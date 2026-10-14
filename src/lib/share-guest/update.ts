import { propose, compose, type MergeProposal, type HunkDecision } from '../share-merge'
import { classifyPath } from '../fs'
import { sha256Sync } from '../share-merge/hash'
export function isGuestMarkdownPath(path: string): boolean {
  const kind = classifyPath(path)?.kind
  return kind === 'markdown' || kind === 'mdx'
}
export type GuestUpdateAction =
  | { kind: 'write'; path: string; expectedHash: string | null; content: string }
  | { kind: 'copy-base'; path: string; sourcePath: string; expectedHash: string | null }
  | { kind: 'delete' | 'retain-removed'; path: string; expectedHash: string }
export interface GuestUpdatePlan {
  fromSnapshotId: string; toSnapshotId: string; actions: GuestUpdateAction[]
  conflicts: { path: string; proposal: MergeProposal; expectedHash: string }[]
  choices: { path: string; expectedHash: string | null }[]
}
export interface GuestUpdateInput {
  oldBase: Record<string, string>; newBase: Record<string, string>; work: Record<string, string>
  fromSnapshotId: string; toSnapshotId: string
  oldFiles?: Record<string, string>; newFiles?: Record<string, string>
  workHashes?: Record<string, string>; workPaths?: Record<string, string>; occupied?: string[]
}
/** The local side must include every theirs-only hunk, including owner risk flags. */
export function guestDecisions(proposal: MergeProposal): Record<string, HunkDecision> {
  return Object.fromEntries(proposal.hunks.filter(h => h.kind === 'theirs-only').map(h => [h.id, {kind:'theirs-only',choice:'accept'}]))
}
export function composeGuest(proposal: MergeProposal, decisions: Record<string, HunkDecision>): string {
  const result = compose(proposal, {...guestDecisions(proposal), ...decisions})
  if (result.pendingConflicts.length || result.pendingTheirs.length || result.staleDecisions.length) throw Error('GUEST_UNRESOLVED')
  return result.text
}
export function planGuestUpdate(input: GuestUpdateInput): GuestUpdatePlan {
  const plan: GuestUpdatePlan = { fromSnapshotId: input.fromSnapshotId, toSnapshotId: input.toSnapshotId, actions: [], conflicts: [], choices: [] }
  const hashes = (map: Record<string,string>) => Object.fromEntries(Object.entries(map).map(([p,s]) => [p,sha256Sync(s)]))
  const old = input.oldFiles ?? hashes(input.oldBase), next = input.newFiles ?? hashes(input.newBase), work = input.workHashes ?? hashes(input.work)
  const occupied = new Set([...(input.occupied ?? Object.keys(work)), ...Object.keys(next)].map(p=>p.toLowerCase()))
  const own = (map: object, key: string) => Object.hasOwn(map,key)
  for (const sourcePath of new Set([...Object.keys(old), ...Object.keys(next)])) {
    let path = input.workPaths?.[sourcePath] ?? sourcePath
    const expectedHash = work[path] ?? null
    if (!own(next,sourcePath)) {
      if (expectedHash !== null) plan.actions.push({kind:expectedHash === old[sourcePath] ? 'delete' : 'retain-removed',path,expectedHash})
      continue
    }
    if (!own(old,sourcePath)) {
      if ((input.occupied ?? Object.keys(work)).some(p=>p.toLowerCase() === path.toLowerCase())) {
        const dot=path.lastIndexOf('.'), slash=path.lastIndexOf('/'), stem=dot>slash ? path.slice(0,dot) : path, ext=dot>slash ? path.slice(dot) : ''
        let n=1
        do { path=stem+'.shared'+(n===1?'':'-'+n)+ext; n++ } while(occupied.has(path.toLowerCase()))
      }
      occupied.add(path.toLowerCase())
      plan.actions.push({kind:'copy-base',sourcePath,path,expectedHash:null})
    } else if (expectedHash === null) {
      plan.choices.push({path:sourcePath,expectedHash:null})
    } else if (!isGuestMarkdownPath(sourcePath) || !own(input.oldBase,sourcePath) || !own(input.newBase,sourcePath)) {
      if (expectedHash === old[sourcePath]) plan.actions.push({kind:'copy-base',sourcePath,path,expectedHash})
      else plan.choices.push({path:sourcePath,expectedHash})
    } else {
      const proposal=propose({path:sourcePath,base:input.oldBase[sourcePath],ours:input.newBase[sourcePath],theirs:input.work[path]})
      if (proposal.hunks.some(h=>h.kind==='conflict')) plan.conflicts.push({path:sourcePath,proposal,expectedHash})
      else plan.actions.push({kind:'write',path,expectedHash,content:composeGuest(proposal,{})})
    }
  }
  return plan
}
