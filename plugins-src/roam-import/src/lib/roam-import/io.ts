// src/lib/roam-import/io.ts — host-RPC IO layer (v2 plugin port).
//
// The v1 version (host src/lib/roam-import/io.ts) called Tauri fs/dialog plugins
// directly. Here every effect goes through the plugin:// fetch-RPC bridge:
//   - the picked Roam export lives OUTSIDE the vault → host.fs.read_text
//     (allowed only because host.dialog.open just returned that path);
//   - vault writes/reads use host.vault.* with VAULT-RELATIVE paths (the host
//     resolves them against the configured vault root and guards containment),
//     so no absolute joinPath is needed anymore.
import { strFromU8, unzipSync } from 'fflate'
import { sha256Hex } from '../hash'
import { fsReadText, vaultExists, vaultRead, vaultWrite } from '../bridge'
import type { ImportManifest } from './types'

/**
 * Read the user-picked export and return the Roam JSON text.
 *
 * The RPC bridge's `host.fs.read_text` returns UTF-8 text, so `.json` exports
 * read directly. `.zip` exports would require a binary read the bridge does not
 * expose; we still detect a zip signature defensively and surface a clear error
 * (the dialog filter offers `.json` only in v2 — see bridge.dialogOpenJson).
 */
export async function readRoamExport(path: string): Promise<string> {
  const text = await fsReadText(path)
  if (path.toLowerCase().endsWith('.json')) return text
  // Defensive: a picked .zip (or mislabelled file) arrives as text; a PK
  // signature means it is a real archive we cannot unzip over the text bridge.
  if (text.startsWith('PK')) {
    // Best-effort: try to decode the text back to bytes and unzip. This only
    // works when the file was UTF-8-clean, which real Roam zips are not — so it
    // almost always throws, producing an actionable message.
    try {
      const bytes = new TextEncoder().encode(text)
      const entries = unzipSync(bytes)
      const jsonName = Object.keys(entries).find(
        (n) => n.toLowerCase().endsWith('.json') && !n.startsWith('__MACOSX'),
      )
      if (jsonName) return strFromU8(entries[jsonName])
    } catch {
      /* fall through to the guidance error */
    }
    throw new Error('zip exports are not supported here — unzip and pick the .json')
  }
  return text
}

/** Write a note into the vault (host resolves the vault-relative path + mkdir -p). */
export async function writeNoteFile(relPath: string, text: string): Promise<void> {
  await vaultWrite(relPath, text)
}

/** SHA-256 of an existing vault file; null when it does not exist. */
export async function localFileHash(relPath: string): Promise<string | null> {
  if (!(await vaultExists(relPath).catch(() => false))) return null
  try {
    return sha256Hex(await vaultRead(relPath))
  } catch {
    return null
  }
}

const MANIFEST_REL = '.notemd/roam-import.json'

export async function loadImportManifest(): Promise<ImportManifest | null> {
  if (!(await vaultExists(MANIFEST_REL).catch(() => false))) return null
  try {
    return JSON.parse(await vaultRead(MANIFEST_REL)) as ImportManifest
  } catch {
    return null
  }
}

export async function saveImportManifest(m: ImportManifest): Promise<void> {
  await writeNoteFile(MANIFEST_REL, JSON.stringify(m, null, 2))
}
