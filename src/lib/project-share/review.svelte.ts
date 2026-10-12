import { acceptUnconflicted, compose, MERGE_KERNEL_VERSION, tokenize, type AnchorResult, type HunkDecision, type MergeInput, type MergeProposal, type TextSelector } from '../share-merge'
import { scanOwnerAnnotations } from '../share-merge/critic'
import { hunkFlags } from '../share-merge/flags'
import { sanitizeNote } from '../note-anno/note-commands'
import type { IndexedSelector, LocatedAnnotation } from './merge-client'
import type { LocalFeedback, ReviewDraft, ReviewFile } from './types'

export interface ReviewDependencies {
  command<T>(op: string, args: Record<string, unknown>): Promise<T>
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
function retain(proposal: MergeProposal, candidates: Record<string, unknown>) {
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
  const opening = /^\uFEFF?---(?:\r\n|\n)/.exec(text)
  if (!opening) return []
  const closing = /^(?:---|\.\.\.)(?:\r?\n|$)/gm
  closing.lastIndex = opening[0].length
  const end = closing.exec(text)
  if (!end) return []
  return tokenize(text.slice(0, end.index + end[0].length)).filter(token => hunkFlags({
    base: token.text, ours: token.text, theirs: token.text, tokens: [token], baseStart: token.start, baseEnd: token.end,
    ownerAnnotations: [], degraded: false,
  }).flags.includes('trust-field'))
}

export function createProjectReview(projectId: string, deps: ReviewDependencies) {
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
  const mutable = () => phase === 'ready' && !!file && !terminal.has(file.status) && feedback?.status !== 'resolved'
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
      draft: { kernel_version: MERGE_KERNEL_VERSION, ours_hash: file.currentHash, hunks: { ...decisions }, target: null, updated_at: new Date().toISOString() } satisfies ReviewDraft }
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
        const updated = await deps.command<LocalFeedback>('annotation-decide', { project_id: projectId, submissionId: submission(), ...entry })
        update(updated)
        annotationQueue = annotationQueue.filter(item => item !== entry)
        staged = staged.filter(index => index !== entry.index)
      }
      if (error.startsWith('批注状态保存失败：')) error = ''
    })().catch(e => { error = `批注状态保存失败：${String(e)}`; throw e }).finally(() => { annotationJob = undefined })
    return annotationJob
  }
  async function flush() {
    stopTimer()
    if (saveJob) await saveJob
    while (draftDirty) await saveDraft()
    if (annotationQueue.length || annotationJob) await saveAnnotations()
  }
  async function refresh(epoch: number, candidates: Record<string, unknown>) {
    const fresh = await deps.command<ReviewFile>('review', { project_id: projectId, submissionId: submission(), path })
    const next = await deps.compute({ path, base: fresh.base, ours: fresh.current, theirs: fresh.after })
    if (epoch !== generation) return
    const restored = retain(next, candidates)
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
    feedback = nextFeedback; path = nextPath; file = null; proposal = null; decisions = {}; rows = []; staged = []
    cache = new Map(); cacheText = ''; staleDecisions = 0; notice = ''; error = ''; phase = 'loading'
    try {
      const initial = await deps.command<ReviewFile>('review', { project_id: projectId, submissionId: submission(), path })
      if (epoch !== generation) return
      await deps.prepareSource(initial.sourcePath)
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
        canPromote: mutable() && !decision && !!row.anchor && row.anchor.status !== 'orphan' && !row.manualReason }
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
    if (phase === 'writing' || phase === 'destroyed') return
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
    if (phase === 'writing' || phase === 'destroyed' || !feedback || terminal.has(file?.status ?? feedback.decisions[path]?.status ?? '')) return
    phase = 'writing'
    try {
      await flush()
      const isEdit = feedback.envelope.payload.edits.some(edit => edit.path === path)
      if (!isEdit && feedback.envelope.payload.edits.length) throw new Error('此路径仅含批注，请忽略批注')
      update(await deps.command<LocalFeedback>('reject', { project_id: projectId, submissionId: submission(), ...(isEdit ? { path } : {}) }))
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
  async function destroy() {
    if (phase === 'destroyed') return
    assertCanNavigate()
    await flush()
    assertCanNavigate()
    generation++; deps.cancelAnnotations?.(); deps.dispose?.(); stopTimer(); phase = 'destroyed'
  }
  return {
    get feedback() { return feedback }, get path() { return path }, get file() { return file }, get proposal() { return proposal },
    get decisions(): Readonly<Record<string, HunkDecision>> { return decisions }, get result() { return composed },
    get annotations() { return annotationRows() }, get phase() { return phase }, get dirty() { return draftDirty || annotationQueue.length > 0 },
    get saving() { return saving }, get notice() { return notice }, get error() { return error }, get staleDecisions() { return staleDecisions },
    get canWrite() { return mutable() && !rows.some(row => row.anchor === null) }, get canDecide() { return mutable() },
    get canReject() { return !!feedback && phase === 'ready' && !terminal.has(file?.status ?? feedback.decisions[path]?.status ?? '') },
    open, decide, acceptAll, stageAnnotation, dismissAnnotation, writeFile, rejectFile, resolve, flush, destroy,
  }
}

export type ProjectReviewSession = ReturnType<typeof createProjectReview>
