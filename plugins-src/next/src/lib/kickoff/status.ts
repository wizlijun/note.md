import type { KickoffFailure } from './registry'

export const POLL_MS = 2000

export type KickoffRunView = {
  state: 'running'
  started_at?: string
  steps: number
  last: string
  warning?: string
} | {
  state: 'success'
  content: string
  harness?: string
  model?: string
  started_at?: string
  ended_at?: string
  warning?: string
} | {
  state: 'failed'
  failure: KickoffFailure
}
const obj = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
const str = (v: unknown): string | undefined => typeof v === 'string' ? v : undefined

export function interpretKickoffStatus(raw: unknown): KickoffRunView {
  const r = obj(raw), record = obj(r.record), warning = str(r.warning) ?? str(record.warning), rawSnippet = str(r.rawSnippet) ?? str(record.rawSnippet)
  if(r.state === 'running')
    return {
      state: 'running',
      started_at: str(r.started_at),
      steps: typeof r.steps === 'number' ? r.steps : 0,
      last: str(r.last) ?? '',
      warning
    }
  if(r.state === 'done' && record.status === 'success') {
    const content = str(obj(r.terminal_result).content)
    if(content?.trim())
      return {
        state: 'success',
        content,
        harness: str(record.harness),
        model: str(record.model),
        started_at: str(record.started_at),
        ended_at: str(record.ended_at),
        warning
      }
    return {
      state: 'failed',
      failure: {
        kind: 'missing-result',
        message: 'Agent completed without a saved result',
        at: str(record.ended_at) ?? '',
        warning,
        rawSnippet
      }
    }
  }
  const kind = r.state === 'done' && ['skipped', 'error', 'timeout', 'cancelled', 'capacity'].includes(String(record.status)) ? String(record.status) : 'lost'
  return {
    state: 'failed',
    failure: {
      kind,
      message: str(record.stderr_tail)?.trim() || str(record.result) || 'Run interrupted without a result',
      at: str(record.ended_at) ?? '',
      warning,
      rawSnippet
    }
  }
}

export function formatElapsed(ms: number): string {
  const seconds = Math.floor(Math.max(0, Number.isFinite(ms) ? ms : 0) / 1000), s = String(seconds % 60).padStart(2, '0'), m = Math.floor(seconds / 60)
  return m < 60 ? `${m}:${s}` : `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${s}`
}
