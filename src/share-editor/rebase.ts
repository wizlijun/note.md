import { anchor, compose, extractGuestAnnotations, rebaseDraft } from '../lib/share-merge'
import { scanOwnerAnnotations } from '../lib/share-merge/critic'
import { sha256Sync } from '../lib/share-merge/hash'
import type { HunkDecision, MergeProposal } from '../lib/share-merge/types'
import type { DraftV2, ProjectAnnotationV2 } from '../lib/project-share/types'
import type { ShareEditorHost } from './contract'

export interface RebaseCandidate {
  old: DraftV2
  next: DraftV2
  files: readonly { path: string; proposal: MergeProposal; decisions: Record<string, HunkDecision> }[]
  removed: readonly string[]
  orphans: readonly { path: string; annotation: ProjectAnnotationV2; id: string }[]
  /** Explicit export confirmations; never inferred from opening the panel. */
  exported: Set<string>
}
const key = (a: Pick<ProjectAnnotationV2, 'selector' | 'comment'>) => sha256Sync(a.selector.exact + '\0' + a.comment).slice(0, 16)
const orphanKey = (path: string, index: number) => `annotation:${path}:${index}`
export { orphanKey }

function annotations(candidate: RebaseCandidate, path: string, clean: string) {
  const extracted = extractGuestAnnotations({ base: candidate.old.base[path].markdown, draft: candidate.old.after[path] ?? candidate.old.base[path].markdown })
  const owners = scanOwnerAnnotations(clean), occupied: { start: number; end: number }[] = []
  const insertions: { start: number; end: number; raw: string; annotation: ProjectAnnotationV2 }[] = []
  const orphans: { path: string; annotation: ProjectAnnotationV2; id: string }[] = []
  const source: ProjectAnnotationV2[] = [...extracted.annotations.map(a => ({ ...a, path, kind: candidate.old.annotationKinds[key(a)] ?? 'comment' })), ...(candidate.next.previous?.annotations ?? []).filter(a => a.path === path)]
  source.forEach((a, index) => {
    const annotation: ProjectAnnotationV2 = { ...a, path }
    const position = anchor(clean, a.selector)
    const intersects = (r: { start: number; end: number }, start: number, end: number) => start === end
      ? start > r.start && start < r.end : start < r.end && end > r.start
    if (position.status === 'orphan' || [...owners, ...occupied].some(r => intersects(r, position.start, position.end))) {
      orphans.push({ path, annotation, id: orphanKey(path, index) }); return
    }
    const { start, end } = position, exact = clean.slice(start, end)
    const raw = (exact ? `{==${exact}==}` : '') + `{>>${a.comment}<<}`
    // Use the existing scanner/extractor as the format authority. Reject a
    // placement that cannot round-trip (including escaped/nested delimiters).
    const probe = clean.slice(0, start) + raw + clean.slice(end)
    const roundTrip = extractGuestAnnotations({ base: clean, draft: probe })
    if (roundTrip.clean !== clean || roundTrip.annotations.length !== 1 || roundTrip.annotations[0].comment !== a.comment || roundTrip.annotations[0].selector.exact !== exact) {
      orphans.push({ path, annotation, id: orphanKey(path, index) }); return
    }
    occupied.push({ start, end })
    insertions.push({ start, end, raw, annotation: { ...annotation, selector: { ...a.selector, exact, start, end } } })
  })
  let raw = clean
  for (const insertion of insertions.sort((a, b) => b.start - a.start || b.end - a.end)) raw = raw.slice(0, insertion.start) + insertion.raw + raw.slice(insertion.end)
  return { raw, orphans, kinds: Object.fromEntries(insertions.map(row => [key(row.annotation), row.annotation.kind!])) }
}

export function refreshGuestRebase(candidate: RebaseCandidate): void {
  const orphans: RebaseCandidate['orphans'][number][] = [], kinds: DraftV2['annotationKinds'] = {}
  for (const [index, annotation] of (candidate.next.previous?.annotations ?? []).entries()) {
    if (candidate.removed.includes(annotation.path)) orphans.push({ path: annotation.path, annotation, id: `removed-annotation:${index}` })
  }
  for (const file of candidate.files) {
    const merged = compose(file.proposal, file.decisions), result = annotations(candidate, file.path, merged.text)
    candidate.next.after[file.path] = result.raw
    orphans.push(...result.orphans); Object.assign(kinds, result.kinds)
  }
  candidate.orphans = orphans; candidate.next.annotationKinds = kinds
}

export function prepareGuestRebase(draft: DraftV2, snapshot: ShareEditorHost['snapshot'], sidecar: readonly ProjectAnnotationV2[] = []): RebaseCandidate {
  if (draft.pending) throw Error('请先发送或导出冻结提交包，再迁移版本')
  if (draft.previous) throw Error('请先完成提交或撤销上次 rebase')
  if (draft.rebaseRecovery) throw Error('请先恢复或取消上次迁移')
  if (draft.snapshotId === snapshot.snapshotId) throw Error('草稿已在此版本')
  const old = structuredClone(draft), next = structuredClone(draft)
  next.previous = { snapshotId: old.snapshotId, base: structuredClone(old.base), after: structuredClone(old.after), annotationKinds: structuredClone(old.annotationKinds), ...(sidecar.length ? { annotations: structuredClone([...sidecar]) } : {}), ...(old.rebasedFrom ? { rebasedFrom: old.rebasedFrom } : {}) }
  next.snapshotId = snapshot.snapshotId; next.rebasedFrom = old.snapshotId; next.base = {}; delete next.editorFiles
  const candidate: RebaseCandidate = { old, next, files: [], removed: [], orphans: [], exported: new Set() }
  const files: RebaseCandidate['files'][number][] = [], removed: string[] = []
  for (const path of Object.keys(old.base)) {
    const incoming = snapshot.files.find(file => file.path === path && typeof file.markdown === 'string')
    if (!incoming) { removed.push(path); continue }
    const clean = extractGuestAnnotations({ base: old.base[path].markdown, draft: old.after[path] ?? old.base[path].markdown }).clean
    const result = rebaseDraft({ path, oldBase: old.base[path].markdown, newBase: incoming.markdown!, draft: clean })
    next.base[path] = { hash: incoming.hash, markdown: incoming.markdown! }
    files.push({ path, proposal: result.proposal, decisions: Object.fromEntries(result.proposal.hunks.filter(h => h.kind === 'theirs-only').map(h => [h.id, { kind: 'theirs-only', choice: 'accept' }])) })
  }
  candidate.files = files; candidate.removed = removed; refreshGuestRebase(candidate)
  return candidate
}

export function completeGuestRebase(candidate: RebaseCandidate): DraftV2 {
  refreshGuestRebase(candidate)
  for (const file of candidate.files) if (compose(file.proposal, file.decisions).pendingConflicts.length) throw Error('请逐一解决冲突')
  for (const path of candidate.removed) if (!candidate.exported.has('file:' + path)) throw Error('请先导出并确认移除的完整草稿')
  if (candidate.orphans.some(row => !candidate.exported.has(row.id))) throw Error('请先处理无法定位的批注')
  const next = structuredClone(candidate.next)
  for (const path of candidate.removed) delete next.after[path]
  return next
}

export function undoGuestRebase(draft: DraftV2): DraftV2 {
  if (draft.pending) throw Error('请先发送或导出冻结提交包')
  if (!draft.previous) throw Error('没有可撤销的 rebase')
  const old = structuredClone(draft), previous = old.previous!
  old.snapshotId = previous.snapshotId; old.base = previous.base; old.after = previous.after
  old.annotationKinds = previous.annotationKinds ?? {}; old.rebasedFrom = previous.rebasedFrom
  delete old.previous; delete old.editorFiles; delete old.rebaseRecovery
  return old
}
