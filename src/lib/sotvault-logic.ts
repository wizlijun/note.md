export interface SotRecord {
  vault_path: string
  source_path: string
  synced_at: number
  source_hash: string
  vault_hash: string
}

export function isTracked(path: string | null, records: SotRecord[]): boolean {
  if (!path) return false
  return records.some((r) => r.vault_path === path)
}

/** The source path a tracked vault copy was synced from, or null. */
export function sourceForVault(path: string | null, records: SotRecord[]): string | null {
  if (!path) return null
  return records.find((r) => r.vault_path === path)?.source_path ?? null
}

/** True when `path` has already been synced to the vault (it's a record's source). */
export function isSyncedSource(path: string | null, records: SotRecord[]): boolean {
  if (!path) return false
  return records.some((r) => r.source_path === path)
}

export function isUnder(path: string, root: string): boolean {
  if (path === root) return true
  const r = root.endsWith('/') ? root : root + '/'
  return path.startsWith(r)
}

export function canSyncToVault(
  path: string | null,
  vaultRoot: string | null,
  records: SotRecord[],
): boolean {
  if (!path || !vaultRoot) return false
  if (isUnder(path, vaultRoot)) return false
  if (isTracked(path, records)) return false
  if (isSyncedSource(path, records)) return false
  return true
}

/** A date formatted as local `yyyy-MM-dd` (used to prefix undated synced filenames). */
export function localYmd(d: Date = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export type DialogAction = 'none' | 'source-missing' | 'confirm-origin' | 'conflict'

export function dialogActionFor(outcome: string): DialogAction {
  switch (outcome) {
    case 'origin_updated': return 'confirm-origin'
    case 'conflict': return 'conflict'
    case 'source_missing': return 'source-missing'
    default: return 'none'
  }
}

export type PushAction = 'noop' | 'apply-silent' | 'prompt-conflict'

/** save-push 决策：源刚被保存后，源→vault 影子该怎么走。
 *  origin_updated(仅源改) → 静默覆盖;conflict(两边都改) → 弹框;其余 → 不动。 */
export function pushActionForOutcome(outcome: string): PushAction {
  switch (outcome) {
    case 'origin_updated': return 'apply-silent'
    case 'conflict': return 'prompt-conflict'
    default: return 'noop'
  }
}
