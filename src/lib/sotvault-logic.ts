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

function isUnder(path: string, root: string): boolean {
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
  return true
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
