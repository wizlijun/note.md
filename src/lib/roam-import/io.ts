// src/lib/roam-import/io.ts — IO 薄层,vitest 不覆盖(仓库惯例)
import { unzipSync, strFromU8 } from 'fflate'
import { joinPath } from '../fs'
import { sha256Hex } from '../hash'
import type { ImportManifest } from './types'

/** 读入用户选的 zip/.json,返回 Roam JSON 文本。zip 内取第一个 .json 条目。 */
export async function readRoamExport(path: string): Promise<string> {
  const { readFile } = await import('@tauri-apps/plugin-fs')
  const bytes = await readFile(path)
  if (path.toLowerCase().endsWith('.json')) return new TextDecoder().decode(bytes)
  const entries = unzipSync(bytes)
  const jsonName = Object.keys(entries).find((n) => n.toLowerCase().endsWith('.json') && !n.startsWith('__MACOSX'))
  if (!jsonName) throw new Error('no .json entry found in zip')
  return strFromU8(entries[jsonName])
}

export async function writeNoteFile(vaultRoot: string, relPath: string, text: string): Promise<void> {
  const abs = joinPath(vaultRoot, relPath)
  const { mkdir, writeTextFile } = await import('@tauri-apps/plugin-fs')
  await mkdir(abs.slice(0, abs.lastIndexOf('/')), { recursive: true }).catch(() => {})
  await writeTextFile(abs, text)
}

/** 现有文件 sha256;不存在返回 null */
export async function localFileHash(vaultRoot: string, relPath: string): Promise<string | null> {
  const { exists, readTextFile } = await import('@tauri-apps/plugin-fs')
  const abs = joinPath(vaultRoot, relPath)
  if (!(await exists(abs).catch(() => false))) return null
  return sha256Hex(await readTextFile(abs))
}

const MANIFEST_REL = '.notemd/roam-import.json'

export async function loadImportManifest(vaultRoot: string): Promise<ImportManifest | null> {
  const { exists, readTextFile } = await import('@tauri-apps/plugin-fs')
  const abs = joinPath(vaultRoot, MANIFEST_REL)
  if (!(await exists(abs).catch(() => false))) return null
  try { return JSON.parse(await readTextFile(abs)) as ImportManifest } catch { return null }
}

export async function saveImportManifest(vaultRoot: string, m: ImportManifest): Promise<void> {
  await writeNoteFile(vaultRoot, MANIFEST_REL, JSON.stringify(m, null, 2))
}
