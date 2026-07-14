// src/lib/outline/dirs.svelte.ts
import { Store } from '@tauri-apps/plugin-store'
import { sanitizeFileName } from './slug'

export const DEFAULT_DIRS = { wikipage: 'wikipage', dailynote: 'dailynote' } as const

/** vault 内约定目录名(spec §一/§6:全局可配置,默认 wikipage/dailynote;wikilink 黑名单 blocklist.md 落在 wikipage 下) */
export const outlineDirs = $state<{ wikipage: string; dailynote: string }>({ ...DEFAULT_DIRS })

/** 目录名约束:单段合法文件名;空白回退默认值 */
export function normalizeDirName(raw: string, fallback: string): string {
  if (raw.trim() === '') return fallback
  const s = sanitizeFileName(raw)
  return s === 'untitled' ? fallback : (s || fallback)
}

let store: Awaited<ReturnType<typeof Store.load>> | null = null
async function getStore() {
  if (!store) store = await Store.load('settings.json')
  return store
}

/** 与 loadOutlineGate 同时机调用(settings 水合后) */
export async function loadOutlineDirs(): Promise<void> {
  const s = await getStore()
  outlineDirs.wikipage = (await s.get<string>('outline.wikipageDir')) ?? DEFAULT_DIRS.wikipage
  outlineDirs.dailynote = (await s.get<string>('outline.dailynoteDir')) ?? DEFAULT_DIRS.dailynote
}

export async function setOutlineDir(kind: 'wikipage' | 'dailynote', raw: string): Promise<void> {
  const v = normalizeDirName(raw, DEFAULT_DIRS[kind])
  outlineDirs[kind] = v
  const s = await getStore()
  await s.set(kind === 'wikipage' ? 'outline.wikipageDir' : 'outline.dailynoteDir', v)
  await s.save()
}
