import { compose, MERGE_KERNEL_VERSION, type MergeInput, type MergeProposal } from '../share-merge'
import { retainReviewDecisions } from './review.svelte'
import type { GitPrepared, GitProbe, GitTarget } from './types'

export function gitTarget(probe: GitProbe): GitTarget {
  return probe.git ? probe.target ?? (probe.remote ? 'branch' : 'worktree') : 'worktree'
}
export function pushCommand(remote: string, branch: string): string {
  const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'"
  return `git push -- ${quote(remote)} ${quote(branch)}`
}
export interface GitReviewFile { path: string; current: string; result: string; pendingTheirs: number }
export interface GitConfirmation { target: 'branch' | 'patch'; files: GitReviewFile[]; pendingAnnotations: number }
export async function prepareGitReview(project_id: string, submissionId: string, deps: {
  command<T>(op: string, args: Record<string, unknown>): Promise<T>
  compute(input: MergeInput): Promise<MergeProposal>
}) {
  const prepared = await deps.command<GitPrepared>('prepare', { project_id, submissionId })
  const results: Record<string, string> = {}, files: GitReviewFile[] = []
  let accepted = 0, total = 0
  for (const file of prepared.files) {
    const proposal = await deps.compute({ path: file.path, base: file.base, ours: file.current, theirs: file.after })
    const draft = prepared.feedback.review?.[file.path]
    if (draft && draft.kernel_version !== MERGE_KERNEL_VERSION) throw new Error('审阅规则已更新，请重新确认决定')
    const retained = retainReviewDecisions(proposal, draft?.hunks ?? {})
    const result = compose(proposal, retained.decisions)
    if (retained.stale || result.staleDecisions.length || result.pendingConflicts.length) throw new Error('相对 HEAD 有冲突或决定失效，请先提交本地改动，或改用 A')
    accepted += result.accepted; total += result.total
    results[file.path] = result.text
    files.push({ path: file.path, current: file.current, result: result.text, pendingTheirs: result.pendingTheirs.length })
  }
  if (total && !accepted) throw new Error('请先审阅并接受需要合入的改动')
  if (files.every(file => file.result === file.current)) throw new Error('HEAD 已包含这些内容，无需合入或导出补丁')
  return { prepared, results, files }
}
