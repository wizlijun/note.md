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

/** Local `yyyy-MM-dd HH:mm` for a Unix-seconds timestamp. Pure (no runes). */
export function formatDateTime(ts: number): string {
  const d = new Date(ts * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
