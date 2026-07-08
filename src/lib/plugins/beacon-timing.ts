export const IDLE_MS = 30_000
export const MAX_SESSION_MS = 30 * 60_000

/**
 * Pure reading-time accumulator for the share beacon. `takeDelta(now)` returns
 * the visible, non-idle ms since the previous credited point (0 when hidden or
 * idle) and advances the internal cursor. Total accrued is capped at
 * MAX_SESSION_MS. `setVisible`/`activity` drive the state; all take an explicit
 * `now` (epoch ms) so the logic is deterministic and testable.
 */
export function createBeaconClock(startMs: number) {
  let visible = false
  let lastActivity = startMs
  let cursor = startMs         // last point already credited
  let accruedTotal = 0

  const api = {
    setVisible(v: boolean, now: number): void {
      api.takeDelta(now)       // credit up to `now` under the OLD state first
      visible = v
      cursor = now
    },
    activity(now: number): void {
      if (now - lastActivity >= IDLE_MS) cursor = now  // resume: skip the idle gap
      lastActivity = now
    },
    takeDelta(now: number): number {
      if (now <= cursor) { cursor = Math.max(cursor, now); return 0 }
      const idleAt = lastActivity + IDLE_MS
      let end = now
      if (!visible) end = cursor                          // hidden: credit nothing
      else if (now > idleAt) end = Math.max(cursor, idleAt) // idle cap
      const gross = Math.max(0, end - cursor)
      cursor = now
      const room = Math.max(0, MAX_SESSION_MS - accruedTotal)
      const credited = Math.min(gross, room)
      accruedTotal += credited
      return credited
    },
  }
  return api
}
