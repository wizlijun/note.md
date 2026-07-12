import { isUnder } from '../sotvault-logic'

/** True when the tab's file lives inside the configured vault repo (so it has
 *  git history). Pure — no runes/tauri imports, so it's unit-testable. */
export function historyAppliesTo(
  tab: { filePath: string } | null,
  vaultRoot: string | null,
): boolean {
  if (!tab || !tab.filePath || !vaultRoot) return false
  return isUnder(tab.filePath, vaultRoot)
}

/** Compact relative time for a Unix-seconds timestamp. `now` (seconds) is
 *  injectable for deterministic tests; defaults to the wall clock. */
export function relTime(ts: number, now: number = Date.now() / 1000): string {
  const s = Math.max(0, Math.floor(now - ts))
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  return `${d}d`
}
