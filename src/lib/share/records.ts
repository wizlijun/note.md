import { getPluginScopedKey, mergePluginScoped } from '../settings.svelte'
import type { ShareRecord } from './types'

const KEY = 'share.records'

function readAll(): Record<string, ShareRecord> {
  const v = getPluginScopedKey(KEY)
  return (v && typeof v === 'object' ? v : {}) as Record<string, ShareRecord>
}

export function getRecord(path: string): ShareRecord | undefined {
  return readAll()[path]
}

/** Absolute paths of every share record (used to surface audience-only shares). */
export function allShareRecordPaths(): string[] {
  return Object.keys(readAll())
}

export async function putRecord(path: string, rec: ShareRecord): Promise<void> {
  const all = { ...readAll(), [path]: rec }
  await mergePluginScoped({ [KEY]: all })
}

export async function deleteRecord(path: string): Promise<void> {
  const all = { ...readAll() }
  delete all[path]
  await mergePluginScoped({ [KEY]: all })
}
