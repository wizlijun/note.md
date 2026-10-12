import { acceptUnconflicted, compose, MERGE_KERNEL_VERSION, type AnchorResult, type HunkDecision, type MergeInput, type MergeProposal, type TextSelector } from '../share-merge'
import { scanOwnerAnnotations } from '../share-merge/critic'
import { frontmatterTokens } from '../share-merge/frontmatter'
import { hunkFlags } from '../share-merge/flags'
import { sanitizeNote } from '../note-anno/note-commands'
import type { IndexedSelector, LocatedAnnotation } from './merge-client'
import { gitTarget, prepareGitReview, type GitConfirmation } from './git'
import type { GitBranchResult, GitProbe, GitTarget, LocalFeedback, ReviewDraft, ReviewFile } from './types'

export interface ReviewDependencies {
  command<T>(op: string, args: Record<string, unknown>): Promise<T>
  gitCommand?<T>(op: string, args: Record<string, unknown>): Promise<T>
  confirmGit?(input: GitConfirmation): Promise<boolean>
  pickPatch?(defaultPath: string): Promise<string | null>
  savePatch?(path: string, text: string): Promise<void>
  prepareSource(sourcePath: string): Promise<void>
  refreshSource(sourcePath: string): Promise<void>
  confirmWrite(input: { path: string; current: string; result: string; pendingTheirs: number; pendingAnnotations: number }): Promise<boolean>
  compute(input: MergeInput): Promise<MergeProposal>
  locateAnnotations(text: string, selectors: IndexedSelector[]): Promise<LocatedAnnotation[]>
  cancelAnnotations?(): void
  dispose?(): void
  onUpdated?(feedback: LocalFeedback): void
}
export interface ReviewAnnotation {
  index: number
  annotation: LocalFeedback['envelope']['payload']['annotations'][number]
  anchor: AnchorResult | null
  staged: boolean
  decision?: 'promoted' | 'dismissed'
  canPromote: boolean
  manualReason?: string
}

const terminal = new Set(['accepted', 'mirror_pending', 'rejected', 'recovery_conflict', 'branched'])
function validDecision(value: unknown): value is HunkDecision {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const d = value as Record<string, unknown>
  if (d.kind === 'theirs-only') return (d.choice === 'accept' || d.choice === 'reject') && Object.keys(d).every(k => k === 'kind' || k === 'choice')
  return d.kind === 'conflict' && typeof d.choice === 'string' && ['ours', 'theirs', 'ours+theirs', 'theirs+ours', 'edited'].includes(d.choice)
    && (d.text === undefined || typeof d.text === 'string') && (d.choice !== 'edited' || typeof d.text === 'string')
    && (d.source === undefined || d.source === 'human' || d.source === 'ai-suggestion')
    && Object.keys(d).every(k => ['kind', 'choice', 'text', 'source'].includes(k))
}
export function retainReviewDecisions(proposal: MergeProposal, candidates: Record<string, unknown>) {
  const decisions: Record<string, HunkDecision> = {}
  const kinds = new Map(proposal.hunks.map(h => [h.id, h.kind]))
  let stale = 0
  for (const [id, value] of Object.entries(candidates)) {
    if (validDecision(value) && kinds.get(id) === value.kind) decisions[id] = value
    else stale++
  }
  return { decisions, stale }
}
function touches(start: number, end: number, range: { start: number; end: number }) {
  return start === end ? start >= range.start && start < range.end : start < range.end && end > range.start
}
function trustRanges(text: string) {
  return (frontmatterTokens(text)?.tokens ?? []).filter(token => hunkFlags({
    base: token.text, ours: token.text, theirs: token.text, tokens: [token], baseStart: token.start, baseEnd: token.end,
    ownerAnnotations: [], degraded: false,
  }).flags.includes('trust-field'))
}

export function createProjectReview(projectId: string, deps: ReviewDependencies) {
  let target = $state<GitTarget>('worktree')
  let probe = $state.raw<GitProbe | null>(null)
  let gitError = $state('')
  let branches = $state.raw<Record<string, GitBranchResult>>({})
  let feedback = $state.raw<LocalFeedback | null>(null)
  let path = $state('')
  let file = $state.raw<ReviewFile | null>(null)
  let proposal = $state.raw<MergeProposal | null>(null)
  let decisions = $state.raw<Record<string, HunkDecision>>({})
  const composed = $derived(proposal ? compose(proposal, decisions) : null)
  let rows = $state.raw<ReviewAnnotation[]>([])
  let staged = $state.raw<number[]>([])
  let phase = $state<'idle' | 'loading' | 'ready' | 'writing' | 'destroyed'>('idle')
  let notice = $state(''), error = $state(''), staleDecisions = $state(0)
  let draftDirty = $state(false), saving = $state(false)
  let annotationQueue = $state.raw<{ index: number; value: 'promoted' | 'dismissed' }[]>([])
  let generation = 0, revision = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let saveJob: Promise<void> | undefined
  let annotationJob: Promise<void> | undefined
  let cacheText = '', cache = new Map<string, AnchorResult>()
  const submission = () => feedback!.envelope.payload.submissionId
  function assertCanNavigate() {
    if (phase === 'writing') throw new Error('正在写回，暂不能切换或关闭审阅')
    if (phase === 'destroyed') throw new Error('审阅会话已销毁')
  }
  const mutable = () => phase === 'ready' && !!file && !branches[submission()] && !terminal.has(file.status) && feedback?.status !== 'resolved' && feedback?.status !== 'branched'
  const stopTimer = () => { clearTimeout(timer); timer = undefined }
  const update = (value: LocalFeedback) => { feedback = value; deps.onUpdated?.(value) }
  const selections = (indices?: number[]): IndexedSelector[] => (feedback?.envelope.payload.annotations ?? []).flatMap((annotation, index) =>
    annotation.path === path && (!indices || indices.includes(index)) ? [{ index, selector: { exact: annotation.quote, ...(annotation.start === undefined ? {} : { start: annotation.start }), ...(annotation.end === undefined ? {} : { end: annotation.end }) } }] : [])
  const key = ({ index, selector }: IndexedSelector) => JSON.stringify([index, selector])
  async function locate(text: string, selectors: IndexedSelector[]) {
    if (!selectors.length) return []
    if (cacheText === text && selectors.every(s => cache.has(key(s)))) return selectors.map(s => ({ index: s.index, result: cache.get(key(s))! }))
    const epoch = generation
    const result = await deps.locateAnnotations(text, selectors)
    if (result.length !== selectors.length || selectors.some(s => !result.some(r => r.index === s.index))) throw new Error('批注定位返回不完整')
    if (epoch !== generation) return result
    // Cache only one text version, with selectors as part of its identity.
    if (cacheText !== text) { cacheText = text; cache = new Map() }
    for (const selector of selectors) cache.set(key(selector), result.find(r => r.index === selector.index)!.result)
    return result
  }
  function setRows(locations: LocatedAnnotation[], text: string) {
    const trust = trustRanges(text)
    rows = selections().map(({ index }) => {
      const result = locations.find(l => l.index === index)?.result ?? null
      const manualReason = result && result.status !== 'orphan' && trust.some(range => touches(result.start, result.end, range)) ? '信任字段需手工处理' : undefined
      return { index, annotation: feedback!.envelope.payload.annotations[index], anchor: result, staged: false, canPromote: false, ...(manualReason ? { manualReason } : {}) }
    })
  }
  async function locateCurrent(epoch: number) {
    const text = file!.current
    try {
      const located = await locate(text, selections())
      if (epoch === generation) setRows(located, text)
    } catch (e) {
      if (epoch === generation) { setRows([], text); error = `批注定位失败：${String(e)}` }
    }
  }
  function markDirty() {
    revision++
    draftDirty = true
    stopTimer()
    timer = setTimeout(() => { timer = undefined; void flush().catch(() => {}) }, 500)
  }
  async function saveDraft() {
    if (saveJob) return saveJob
    if (!draftDirty || !feedback || !file || !proposal) return
    if (terminal.has(file.status)) { draftDirty = false; return }
    const savedRevision = revision, epoch = generation
    const args = { project_id: projectId, submissionId: submission(), path,
      draft: { kernel_version: MERGE_KERNEL_VERSION, ours_hash: file.currentHash, hunks: { ...decisions }, target, updated_at: new Date().toISOString() } satisfies ReviewDraft }
    saving = true
    saveJob = (async () => {
      try {
        const updated = await deps.command<LocalFeedback>('review-save', args)
        if (epoch === generation) {
          update(updated)
          if (revision === savedRevision) draftDirty = false
          if (error.startsWith('审阅进度保存失败：')) error = ''
        }
      } catch (e) { error = `审阅进度保存失败：${String(e)}`; throw e }
      finally { saving = false; saveJob = undefined }
    })()
    return saveJob
  }
  async function saveAnnotations() {
    if (annotationJob) return annotationJob
    annotationJob = (async () => {
      while (annotationQueue.length) {
        const entry = annotationQueue[0]
        const updated = await deps.command<LocalFeedback>('annotation-decide', { project_id: projectId, submissionId: submission(), ...entry, target })
        update(updated)
        annotationQueue = annotationQueue.filter(item => item !== entry)
        staged = staged.filter(index => index !== entry.index)
      }
      if (error.startsWith('批注状态保存失败：')) error = ''
    })().catch(e => { error = `批注状态保存失败：${String(e)}`; throw e }).finally(() => { annotationJob = undefined })
    return annotationJob
  }
  async function flush() {
    // Either IPC can admit new decisions while awaited; drain both again.
    do {
      stopTimer()
      if (saveJob) await saveJob
      if (draftDirty) await saveDraft()
      if (annotationQueue.length || annotationJob) await saveAnnotations()
    } while (draftDirty || saveJob || annotationQueue.length || annotationJob)
    stopTimer()
  }
  async function refresh(epoch: number, candidates: Record<string, unknown>) {
    const fresh = await deps.command<ReviewFile>(target === 'worktree' ? 'review' : 'review-readonly', { project_id: projectId, submissionId: submission(), path })
    if (epoch !== generation) return
    const next = await deps.compute({ path, base: fresh.base, ours: fresh.current, theirs: fresh.after })
    if (epoch !== generation) return
    const restored = retainReviewDecisions(next, candidates)
    file = fresh; proposal = next; decisions = restored.decisions; staleDecisions = restored.stale
    await locateCurrent(epoch)
  }
  async function open(nextFeedback: LocalFeedback, nextPath: string) {
    assertCanNavigate()
    // Flush before invalidating the old identity: save results still belong to it.
    await flush()
    assertCanNavigate()
    const epoch = ++generation
    deps.cancelAnnotations?.()
    // flush may replace the feedback object; same-submission reopen uses that
    // durable snapshot rather than the caller's pre-save reference.
    if (feedback?.envelope.payload.submissionId === nextFeedback.envelope.payload.submissionId) nextFeedback = feedback
    feedback = nextFeedback; path = nextPath; file = null; proposal = null; decisions = {}; rows = []; staged = []
    cache = new Map(); cacheText = ''; staleDecisions = 0; notice = ''; error = ''; phase = 'loading'
    try {
      if (target !== 'worktree' && deps.gitCommand) {
        const recovered = await deps.gitCommand<GitBranchResult | null>('branch-state', { project_id: projectId, submissionId: submission() })
        if (epoch !== generation) return
        if (recovered) { branches = { ...branches, [submission()]: recovered }; update(recovered.feedback); nextFeedback = recovered.feedback }
        else { const next = { ...branches }; delete next[submission()]; branches = next }
      }
      const initial = await deps.command<ReviewFile>(target === 'worktree' ? 'review' : 'review-readonly', { project_id: projectId, submissionId: submission(), path })
      if (epoch !== generation) return
      if (target === 'worktree') await deps.prepareSource(initial.sourcePath)
      if (epoch !== generation) return
      const draft = nextFeedback.review?.[nextPath]
      const versionChanged = !!draft && draft.kernel_version !== MERGE_KERNEL_VERSION
      await refresh(epoch, versionChanged ? {} : draft?.hunks ?? {})
      if (epoch !== generation) return
      if (versionChanged) { staleDecisions = Object.keys(draft.hunks).length; notice = `审阅规则已更新，请重新确认 ${staleDecisions} 处决定` }
      else if (staleDecisions) notice = `${staleDecisions} 个决定失效，请重新确认`
    } catch (e) { if (epoch === generation) error = String(e) }
    finally { if (epoch === generation) phase = 'ready' }
  }
  function decide(id: string, decision: HunkDecision) {
    if (!mutable() || !validDecision(decision) || !proposal!.hunks.some(h => h.id === id && h.kind === decision.kind)) return
    decisions = { ...decisions, [id]: decision }; markDirty()
  }
  function acceptAll() {
    if (!mutable()) return
    const accepted = acceptUnconflicted(proposal!)
    if (!Object.keys(accepted).length) return
    decisions = { ...decisions, ...accepted }; markDirty()
  }
  function annotationRows(): ReviewAnnotation[] {
    return rows.map(row => {
      const decision = feedback?.annotation_decisions?.[String(row.index)]
      return { ...row, staged: staged.includes(row.index), decision,
        canPromote: target === 'worktree' && mutable() && !decision && !!row.anchor && row.anchor.status !== 'orphan' && !row.manualReason }
    })
  }
  function stageAnnotation(index: number) {
    if (!annotationRows().some(row => row.index === index && row.canPromote)) return
    staged = staged.includes(index) ? staged.filter(i => i !== index) : [...staged, index]
  }
  async function dismissAnnotation(index: number) {
    if (phase === 'writing' || phase === 'destroyed' || !rows.some(row => row.index === index) || feedback?.annotation_decisions?.[index] === 'promoted') return
    if (!annotationQueue.some(item => item.index === index)) annotationQueue = [...annotationQueue, { index, value: 'dismissed' }]
    await saveAnnotations()
  }
  async function promotedText(text: string) {
    const selectors = selections(staged)
    const locations = await locate(text, selectors)
    const owners = scanOwnerAnnotations(text), trust = trustRanges(text)
    const wrapped: { start: number; end: number }[] = []
    const insertions = [...locations].sort((a, b) => a.index - b.index).map(({ index, result }) => {
      if (result.status === 'orphan') throw new Error('所选批注已无法定位，请重新处理')
      if (trust.some(range => touches(result.start, result.end, range))) throw new Error('信任字段批注需手工处理')
      const annotation = feedback!.envelope.payload.annotations[index]
      const comment = `{>>${sanitizeNote(feedback!.envelope.payload.name || '访客')}：${sanitizeNote(annotation.comment)}<<}`
      const overlapping = owners.filter(owner => touches(result.start, result.end, owner))
      if (overlapping.length) {
        const end = Math.max(result.end, ...overlapping.map(owner => owner.end))
        return { index, start: end, end, replacement: comment }
      }
      if (result.start !== result.end && wrapped.some(range => touches(result.start, result.end, range))) {
        return { index, start: result.end, end: result.end, replacement: comment }
      }
      if (result.start !== result.end) wrapped.push(result)
      return { index, start: result.start, end: result.end,
        replacement: result.start === result.end ? comment : `{==${text.slice(result.start, result.end)}==}${comment}` }
    })
    // Point notes must not be spliced inside a range replaced by a highlight.
    for (const insertion of insertions) {
      if (insertion.start !== insertion.end) continue
      const enclosing = wrapped.filter(range => insertion.start > range.start && insertion.start < range.end)
      if (enclosing.length) insertion.start = insertion.end = Math.max(...enclosing.map(range => range.end))
    }
    insertions.sort((a, b) => b.start - a.start || b.end - a.end || b.index - a.index)
    let result = text
    for (const insertion of insertions) {
      result = result.slice(0, insertion.start) + insertion.replacement + result.slice(insertion.end)
    }
    return { text: result, indices: selectors.map(s => s.index) }
  }
  async function writeFile() {
    if (target !== 'worktree' || phase === 'writing' || phase === 'destroyed') return
    // After an applied write, retry only its durable annotation statuses.
    if (annotationQueue.length) { try { await flush() } catch {} return }
    if (!mutable()) return
    phase = 'writing'; error = ''; notice = ''
    const epoch = generation
    try {
      await flush()
      await deps.prepareSource(file!.sourcePath)
      const previousHash = file!.currentHash
      await refresh(epoch, decisions)
      if (terminal.has(file!.status)) { notice = '此文件已处理，不能再次写回或提升批注'; return }
      if (file!.currentHash !== previousHash) notice = `原件已变化，提案已刷新，${staleDecisions} 个决定失效`
      const result = compose(proposal!, decisions)
      if (result.pendingConflicts.length) { error = '仍有未决冲突，请先逐处确认'; return }
      if (rows.some(row => row.anchor === null)) throw new Error('批注定位失败，请重新打开文件后重试')
      const promoted = await promotedText(result.text)
      const pendingAnnotations = selections().filter(s => !promoted.indices.includes(s.index) && !feedback!.annotation_decisions?.[s.index]).length
      if (!await deps.confirmWrite({ path, current: file!.current, result: promoted.text, pendingTheirs: result.pendingTheirs.length, pendingAnnotations })) return
      const isEdit = feedback!.envelope.payload.edits.some(edit => edit.path === path)
      if (result.total > 0 && !result.accepted && !promoted.indices.length && isEdit) {
        update(await deps.command<LocalFeedback>('reject', { project_id: projectId, submissionId: submission(), path }))
        file = { ...file!, status: feedback!.decisions[path]?.status ?? 'rejected' }; draftDirty = false
        return
      }
      if (!isEdit && !promoted.indices.length) { notice = '没有选择写回内容，可忽略批注后标为已阅'; return }
      const updated = await deps.command<LocalFeedback>('apply', { project_id: projectId, submissionId: submission(), path,
        expectedHash: file!.currentHash, content: promoted.text, summary: { accepted: result.accepted, total: result.total } })
      update(updated)
      file = { ...file!, status: updated.decisions[path]?.status ?? updated.status }
      draftDirty = false
      if (!['accepted', 'mirror_pending'].includes(file.status)) throw new Error('写回结果尚未确认，请重新打开审阅')
      annotationQueue = promoted.indices.map(index => ({ index, value: 'promoted' as const }))
      try { await saveAnnotations() } finally { await deps.refreshSource(file.sourcePath) }
      notice = file.status === 'mirror_pending' ? '原件已写入，镜像待处理' : '此文件已写回'
    } catch (e) {
      if (String(e).includes('source changed; review again')) {
        try { await refresh(epoch, decisions); notice = `原件已变化，提案已刷新，${staleDecisions} 个决定失效` }
        catch (refreshError) { error = String(refreshError) }
      } else if (!error.startsWith('批注状态保存失败：')) error = String(e)
    } finally { phase = 'ready' }
  }
  async function rejectFile() {
    if (phase === 'writing' || phase === 'destroyed' || !feedback || feedback.status === 'branched' || branches[submission()] || terminal.has(file?.status ?? feedback.decisions[path]?.status ?? '')) return
    phase = 'writing'
    try {
      await flush()
      const isEdit = feedback.envelope.payload.edits.some(edit => edit.path === path)
      if (!isEdit && feedback.envelope.payload.edits.length) throw new Error('此路径仅含批注，请忽略批注')
      update(await deps.command<LocalFeedback>('reject', { project_id: projectId, submissionId: submission(), ...(isEdit ? { path } : {}), target }))
      if (file) file = { ...file, status: 'rejected' }
      draftDirty = false
    } catch (e) { error = String(e); throw e } finally { phase = 'ready' }
  }
  async function resolve() {
    if (phase === 'writing' || phase === 'destroyed' || !feedback || feedback.envelope.payload.edits.length) return
    phase = 'writing'
    try { await flush(); update(await deps.command<LocalFeedback>('resolve', { project_id: projectId, submissionId: submission() })) }
    catch (e) { error = String(e); throw e } finally { phase = 'ready' }
  }
  async function initializeTarget(hasEdits = true) {
    assertCanNavigate()
    const epoch = generation
    try {
      const latest = await deps.gitCommand?.<GitProbe>('probe', { project_id: projectId })
      if (epoch !== generation || phase === 'destroyed') return
      probe = latest ?? null; gitError = ''
      target = latest && hasEdits ? gitTarget(latest) : 'worktree'
    } catch (e) { if (epoch === generation) { probe = null; gitError = String(e) } }
  }
  async function setTarget(next: GitTarget) {
    assertCanNavigate()
    if (next === target) return
    if (next !== 'worktree' && (!probe?.git || !feedback?.envelope.payload.edits.length)) return
    // Keep the old target on every in-flight save until config has succeeded.
    phase = 'writing'
    try {
      await flush()
      await deps.command('git-target', { project_id: projectId, target: next })
      target = next
    } finally { phase = 'ready' }
    if (feedback && path) await open(feedback, path)
  }
  function canGit() {
    if (phase !== 'ready' || !file || !proposal || !probe?.git || !feedback?.envelope.payload.edits.length || target === 'worktree') return false
    if (branches[submission()]?.stateError || (target === 'branch' && branches[submission()])) return false
    const statuses = feedback.envelope.payload.edits.map(e => feedback!.decisions[e.path]?.status)
    return statuses.every(status => status === undefined || status === 'not_applied') || (target === 'patch' && statuses.every(status => status === 'branched'))
  }
  async function executeGit() {
    if (!canGit() || !deps.gitCommand || !deps.confirmGit) return
    phase = 'writing'; error = ''; notice = ''
    const epoch = generation, id = submission(), selectedTarget = target as 'branch' | 'patch'
    try {
      await flush()
      const latest = await deps.gitCommand<GitProbe>('probe', { project_id: projectId })
      if (epoch !== generation) return
      probe = latest; gitError = ''
      if (!latest.git) { target = 'worktree'; throw new Error(latest.reason ?? '此项目不再支持 Git，已切换到 A') }
      const batch = await prepareGitReview(projectId, id, { command: deps.gitCommand, compute: deps.compute })
      if (epoch !== generation) return
      update(batch.prepared.feedback)
      const pendingAnnotations = feedback!.envelope.payload.annotations.filter((_, index) => !feedback!.annotation_decisions?.[index]).length
      if (!await deps.confirmGit({ target: selectedTarget, files: batch.files, pendingAnnotations }) || epoch !== generation) return
      const args = { project_id: projectId, submissionId: id, expectedHead: batch.prepared.head, results: batch.results }
      if (selectedTarget === 'branch') {
        const result = await deps.gitCommand<GitBranchResult>('branch', args)
        if (epoch !== generation) return
        branches = { ...branches, [id]: result }; update(result.feedback)
        if (file) file = { ...file, status: result.feedback.decisions[path]?.status ?? file.status }
        notice = result.stateError ? '分支已创建，但审阅状态未完整记录；请重试记录状态' : '整份投稿已创建分支'
      } else {
        if (!deps.pickPatch || !deps.savePatch) throw new Error('补丁保存不可用')
        const destination = await deps.pickPatch(`${batch.prepared.entry.replace(/\.[^/.]+$/, '')}.patch`)
        if (!destination || epoch !== generation) return
        const { patch } = await deps.gitCommand<{ patch: string }>('export-patch', args)
        if (epoch !== generation) return
        await deps.savePatch(destination, patch)
        if (epoch === generation) notice = '补丁已保存；审阅决定保持不变'
      }
    } catch (e) { if (epoch === generation) error = String(e) }
    finally { if (epoch === generation) phase = 'ready' }
  }
  async function retryBranchState() {
    if (phase !== 'ready' || !feedback || !branches[submission()]?.stateError) return
    phase = 'writing'; error = ''
    const result = branches[submission()]
    try {
      for (const edit of feedback!.envelope.payload.edits) {
        update(await deps.command<LocalFeedback>('git-branched', { project_id: projectId, submissionId: submission(), path: edit.path, branch: result.branch, commit: result.commit }))
      }
      branches = { ...branches, [submission()]: { ...result, feedback: feedback!, stateError: undefined } }
      if (file) file = { ...file, status: feedback!.decisions[path]?.status ?? file.status }
      notice = '分支审阅状态已记录'
    } catch (e) { error = String(e) } finally { phase = 'ready' }
  }
  const isDestroyed = () => phase === 'destroyed'
  async function destroy() {
    if (isDestroyed()) return
    assertCanNavigate()
    await flush()
    // Another departure may have completed while this flush was pending.
    if (isDestroyed()) return
    assertCanNavigate()
    generation++; deps.cancelAnnotations?.(); deps.dispose?.(); stopTimer(); phase = 'destroyed'
  }
  return {
    get feedback() { return feedback }, get path() { return path }, get file() { return file }, get proposal() { return proposal },
    get decisions(): Readonly<Record<string, HunkDecision>> { return decisions }, get result() { return composed },
    get annotations() { return annotationRows() }, get phase() { return phase }, get dirty() { return draftDirty || annotationQueue.length > 0 },
    get saving() { return saving }, get notice() { return notice }, get error() { return error }, get staleDecisions() { return staleDecisions },
    get canWrite() { return target === 'worktree' && mutable() && !rows.some(row => row.anchor === null) }, get canDecide() { return mutable() },
    get canReject() { return !!feedback && feedback.status !== 'branched' && !branches[submission()] && phase === 'ready' && !terminal.has(file?.status ?? feedback.decisions[path]?.status ?? '') },
    get target() { return target }, get probe() { return probe }, get gitError() { return gitError },
    get branchResult() { return feedback ? branches[submission()] ?? null : null },
    get canGit() { return canGit() },
    initializeTarget, setTarget, executeGit, retryBranchState,
    open, decide, acceptAll, stageAnnotation, dismissAnnotation, writeFile, rejectFile, resolve, flush, destroy,
  }
}

export type ProjectReviewSession = ReturnType<typeof createProjectReview>
