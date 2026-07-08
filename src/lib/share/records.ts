import { getShareRecords, mergePluginScoped } from '../settings.svelte'
import type { ShareRecord } from './types'

const KEY = 'share.records'

function readAll(): Record<string, ShareRecord> {
  // Share records live in `share_db.json`, hydrated into `shareRecords` and
  // exposed via getShareRecords(). getPluginScopedKey('share.records') does NOT
  // return them (it reads the pluginScoped map, where they no longer live), so
  // reading through it yields {} — which silently broke the audience join.
  return getShareRecords() as unknown as Record<string, ShareRecord>
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
