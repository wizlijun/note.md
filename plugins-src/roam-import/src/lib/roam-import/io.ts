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
import { fsReadBytes, fsReadText, vaultExists, vaultRead, vaultWrite } from '../bridge'
import type { ImportManifest } from './types'

/** Local ZIP archives start with the "PK\x03\x04" signature. */
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]

/** True when `bytes` begins with the ZIP local-file-header magic. */
function looksLikeZip(bytes: Uint8Array): boolean {
  return ZIP_MAGIC.every((b, i) => bytes[i] === b)
}

/** Unzip a Roam `.zip` export and return the text of its single `.json` entry. */
function extractJsonFromZip(bytes: Uint8Array): string {
  const entries = unzipSync(bytes)
  const jsonName = Object.keys(entries).find(
    (n) => n.toLowerCase().endsWith('.json') && !n.startsWith('__MACOSX'),
  )
  if (!jsonName) throw new Error('no .json entry found inside the zip archive')
  return strFromU8(entries[jsonName])
}

/**
 * Read the user-picked export and return the Roam JSON text.
 *
 * Roam's real "Export All (JSON)" downloads as a `.zip`; a manually-unzipped
 * `.json` is also accepted. `.json` reads directly as UTF-8 text over
 * `host.fs.read_text`; `.zip` (or any file whose bytes carry the ZIP magic)
 * is fetched as raw bytes over `host.fs.read_bytes` and unzipped client-side
 * with fflate (parity with the v1 importer).
 */
export async function readRoamExport(path: string): Promise<string> {
  if (path.toLowerCase().endsWith('.zip')) {
    return extractJsonFromZip(await fsReadBytes(path))
  }
  // Non-.zip extension: read as text, but magic-sniff for a mislabelled zip so
  // we still unzip it rather than feed a binary archive to JSON.parse.
  const text = await fsReadText(path)
  const head = new TextEncoder().encode(text.slice(0, 4))
  if (looksLikeZip(head)) {
    return extractJsonFromZip(await fsReadBytes(path))
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
