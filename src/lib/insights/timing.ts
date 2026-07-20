/** No user input for this long → stop counting dwell time. */
export const IDLE_MS = 60_000

export type TimingMode = 'read' | 'edit'

export interface Presence {
  appFocused: boolean
  tabActive: boolean
  idle: boolean
}

export interface TimingState {
  presence: Presence
  mode: TimingMode
  /** Epoch ms when the current active stretch began, or null when paused. */
  activeSince: number | null
  /** Epoch ms of the most recent user activity (for idle detection). */
  lastActivity: number
}

export type TimingEvent =
  | { type: 'focus' }
  | { type: 'blur' }
  | { type: 'tabActive' }
  | { type: 'tabInactive' }
  | { type: 'mode'; mode: TimingMode }
  | { type: 'activity' }
  | { type: 'tick' }

export interface Accrued {
  mode: TimingMode
  ms: number
}

export interface ApplyResult {
  state: TimingState
  accrued: Accrued | null
}

/** The attention-session side effects implied by one dispatch. */
export interface SessionAction {
  /** Became active (inactive→active) → open a new interval. */
  start: boolean
  /** Time to credit into the open interval (its mode), or null. */
  extend: Accrued | null
  /** Became inactive (active→inactive) → finalize the open interval. */
  close: boolean
}

/**
 * Pure mapping from an active-state transition + accrued time to the session
 * open/extend/close side effects. A session opens on inactive→active, extends on
 * any accrued time (read↔edit mode changes stay ONE session), and closes on
 * active→inactive (idle timeout, blur/tab switch). `extend` and `close` can both
 * fire in one dispatch (a blur credits the final stretch, then ends the session).
 */
export function sessionActionFor(
  wasActive: boolean,
  isActive: boolean,
  accrued: Accrued | null,
): SessionAction {
  return { start: !wasActive && isActive, extend: accrued, close: wasActive && !isActive }
}

export function activeNow(p: Presence): boolean {
  return p.appFocused && p.tabActive && !p.idle
}

export function initTiming(nowMs: number, mode: TimingMode): TimingState {
  return {
    presence: { appFocused: false, tabActive: false, idle: false },
    mode,
    activeSince: null,
    lastActivity: nowMs,
  }
}

/** Non-negative ms between `activeSince` (if set) and `until`, for the old mode. */
function flush(state: TimingState, until: number): Accrued | null {
  if (state.activeSince == null) return null
  const ms = Math.max(0, until - state.activeSince)
  return { mode: state.mode, ms }
}

export function applyEvent(state: TimingState, ev: TimingEvent, now: number): ApplyResult {
  const wasActive = activeNow(state.presence)
  const presence: Presence = { ...state.presence }
  let mode = state.mode
  let lastActivity = state.lastActivity
  // The moment up to which the OLD active stretch should be credited.
  let flushUntil = now

  switch (ev.type) {
    case 'focus': presence.appFocused = true; break
    case 'blur': presence.appFocused = false; break
    case 'tabActive': presence.tabActive = true; break
    case 'tabInactive': presence.tabActive = false; break
    case 'mode': mode = ev.mode; break
    case 'activity':
      lastActivity = now
      presence.idle = false
      break
    case 'tick':
      if (now - state.lastActivity >= IDLE_MS) {
        presence.idle = true
        // Credit only up to the last real activity, not the idle tick.
        flushUntil = Math.min(now, state.lastActivity)
      }
      break
  }

  const accrued = wasActive ? flush(state, flushUntil) : null
  const isActive = activeNow(presence)

  return {
    state: {
      presence,
      mode,
      activeSince: isActive ? now : null,
      lastActivity,
    },
    accrued,
  }
}
