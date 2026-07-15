import { companionPathFor } from './store.svelte'
import { isUnder, type SotRecord } from '../sotvault-logic'

/** Decision for where a note SHOULD be written when the user starts editing one. */
export type HomePlan =
  | { action: 'use'; notePath: string }   // note home already determined — write here
  | { action: 'sync' }                     // sync mainPath into vault first, then home = vault companion
  | { action: 'configure-vault' }          // no vault configured — guide the user

export interface HomeCtx {
  vaultRoot: string | null
  records: SotRecord[]
  /** Does a `.note.md` already exist on disk next to the source md? (caller stats it) */
  legacyNoteExists: boolean
}

/**
 * Vault-homed note resolution (WRITE path). Priority:
 *  (a) legacy sidecar note already next to source → keep in place, never touch vault.
 *  (b) source already synced → note lives next to the vault copy.
 *  (c) file itself is under the vault → note beside it (as before).
 *  (d) outside vault, unsynced, no legacy note → sync into vault (or guide to configure).
 */
export function planNoteHome(mainPath: string, ctx: HomeCtx): HomePlan {
  const companion = companionPathFor(mainPath)
  if (companion == null) return { action: 'use', notePath: mainPath } // non-md guard (callers pass md)

  if (ctx.legacyNoteExists) return { action: 'use', notePath: companion }          // (a)

  const mapped = mappedVaultCompanion(mainPath, ctx.records)
  if (mapped) return { action: 'use', notePath: mapped }                            // (b)

  if (ctx.vaultRoot && isUnder(mainPath, ctx.vaultRoot)) return { action: 'use', notePath: companion } // (c)

  return ctx.vaultRoot ? { action: 'sync' } : { action: 'configure-vault' }         // (d)
}

/**
 * Where an EXISTING note for `mainPath` would be found (READ path, no side effects).
 * Synced source → vault companion; otherwise the source-side companion (correct for
 * legacy & vault-internal files, and a harmless non-existent path for unsynced ones —
 * the panel just opens empty until the user writes a note).
 */
export function noteHomeForRead(
  mainPath: string,
  ctx: { vaultRoot: string | null; records: SotRecord[] },
): string | null {
  return mappedVaultCompanion(mainPath, ctx.records) ?? companionPathFor(mainPath)
}

/** Companion path next to the vault copy `mainPath` was synced to, or null. */
function mappedVaultCompanion(mainPath: string, records: SotRecord[]): string | null {
  const rec = records.find((r) => r.source_path === mainPath)
  return rec ? companionPathFor(rec.vault_path) : null
}
