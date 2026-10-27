import type { WorkspaceItem } from '../repository'
import type { KickoffRun, KickoffFailure } from './registry'
import type { KickoffRunView } from './status'

export type ButtonState = 'idle' | 'starting' | 'running' | 'ready-unread' | 'ready' | 'stale' | 'failed'

export interface KickoffCardView {
  state: ButtonState
  elapsedMs?: number
  durationSeconds?: number
  steps?: number
  last?: string
  harness?: string
  failure?: KickoffFailure
}

export interface ButtonStateInput {
  starting?: boolean
  run?: KickoffRun | null
  result?: {
    based_on: string
    duration_seconds?: number
  } | null
  taskHash?: string
  unread?: boolean
  status?: KickoffRunView | null
}

export function kickoffEligible(item: WorkspaceItem): boolean {
  return item.kind === 'task' && !!item.path && !item.orphan && !item.repairReason && /^inbox\/tasks\/[^/]+-task\.md$/.test(item.path) && !/[\\\0]/.test(item.path) && !!item.task && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(item.task.id) && ['capture', 'waiting', 'dormant'].includes(item.state)
}

export function kickoffButtonState(input: ButtonStateInput): ButtonState {
  if(input.starting)
    return 'starting'
  if(input.run?.state === 'running')
    return 'running'
  if(input.run?.state === 'failed')
    return 'failed'
  if(input.result)
    return input.taskHash !== undefined && input.result.based_on !== input.taskHash ? 'stale' : input.unread ? 'ready-unread' : 'ready'
  return 'idle'
}

export function kickoffCardView(input: ButtonStateInput, now: number): KickoffCardView {
  const status = input.status, started = status?.state === 'running' ? status.started_at : undefined
  const start = Date.parse(started ?? input.run?.requested_at ?? '')
  return {
    state: kickoffButtonState(input),
    elapsedMs: Number.isFinite(start) ? Math.max(0, now - start) : 0,
    durationSeconds: input.result?.duration_seconds,
    harness: input.run?.harness,
    steps: status?.state === 'running' ? status.steps : undefined,
    last: status?.state === 'running' ? status.last : undefined,
    failure: input.run?.failure ?? undefined
  }
}
