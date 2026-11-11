export type WorkflowStage = 'preview' | 'search' | 'judge' | 'repair' | 'answer' | 'settings'
export type WorkflowLevel = 'active' | 'success' | 'warning' | 'error'

export interface WorkflowEntry {
  id: number
  stage: WorkflowStage
  level: WorkflowLevel
  message: string
  runId?: string
  steps?: number
  /** Milliseconds since the lookup that owns this entry started. */
  elapsedMs?: number
  /** Provider-reported token usage of a judge, repair or answer request, when the provider returned it. */
  usage?: unknown
}

export const WORKFLOW_LOG_LIMIT = 50

export function appendWorkflowEntry(
  entries: WorkflowEntry[],
  entry: WorkflowEntry,
): WorkflowEntry[] {
  const duplicate = entry.runId && entry.steps !== undefined
    ? entries.some((existing) => (
        existing.runId === entry.runId
        && existing.steps === entry.steps
        && existing.message === entry.message
      ))
    : false
  if (duplicate) return entries
  const next = [...entries, entry]
  return next.length > WORKFLOW_LOG_LIMIT ? next.slice(-WORKFLOW_LOG_LIMIT) : next
}

export function isNearLogBottom(
  metrics: Pick<HTMLElement, 'scrollTop' | 'clientHeight' | 'scrollHeight'>,
  threshold = 24,
): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= threshold
}

/** One JSON object per line, stable key order, for pasting into a bug report. */
export function formatWorkflowLog(entries: WorkflowEntry[]): string {
  return entries.map((entry) => JSON.stringify({
    stage: entry.stage,
    level: entry.level,
    elapsedMs: entry.elapsedMs ?? null,
    usage: entry.usage ?? null,
    message: entry.message,
  })).join('\n')
}
