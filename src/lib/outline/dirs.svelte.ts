// src/lib/outline/dirs.svelte.ts
import { Store } from '@tauri-apps/plugin-store'
import { invoke } from '@tauri-apps/api/core'
import { sanitizeFileName } from './slug'

export const DEFAULT_DIRS = { wikipage: 'wikipage', dailynote: 'dailynote' } as const

/** vault 内约定目录名(spec §一/§6:全局可配置,默认 wikipage/dailynote;wikilink 黑名单 blocklist.md 落在 wikipage 下)。
 *  自 2026-07 起存 vault 级配置 `{vault}/.notemd/settings.json`,跟随 git 同步。 */
export const outlineDirs = $state<{ wikipage: string; dailynote: string }>({ ...DEFAULT_DIRS })

/** 目录名约束:单段合法文件名;空白回退默认值 */
export function normalizeDirName(raw: string, fallback: string): string {
  if (raw.trim() === '') return fallback
  const s = sanitizeFileName(raw)
  return s === 'untitled' ? fallback : (s || fallback)
}

type DirKind = 'wikipage' | 'dailynote'
const DTO_KEY: Record<DirKind, 'wikipageDir' | 'dailynoteDir'> = {
  wikipage: 'wikipageDir',
  dailynote: 'dailynoteDir',
}
/** 旧 app-store 键(vault 配置之前的存储位置),仅用于一次性迁移读取。 */
const LEGACY_KEY: Record<DirKind, string> = {
  wikipage: 'outline.wikipageDir',
  dailynote: 'outline.dailynoteDir',
}

interface VaultSettingsDto {
  syncDir?: string | null
  wikipageDir?: string | null
  dailynoteDir?: string | null
}

let store: Awaited<ReturnType<typeof Store.load>> | null = null
async function getStore() {
  if (!store) store = await Store.load('settings.json')
  return store
}

/** 读旧 app-store 里的目录名(迁移用);无/空/异常 → null。 */
async function legacyDir(kind: DirKind): Promise<string | null> {
  try {
    const v = await (await getStore()).get<string>(LEGACY_KEY[kind])
    return typeof v === 'string' && v.trim() !== '' ? v : null
  } catch {
    return null
  }
}

/** 与 loadOutlineGate 同时机调用(settings 水合后)。
 *  优先级:vault 配置 → 旧 app-store 值(并 write-through 迁移一次) → 默认。 */
export async function loadOutlineDirs(): Promise<void> {
  const dto = await invoke<VaultSettingsDto>('notemd_vault_settings_get').catch(
    () => ({}) as VaultSettingsDto,
  )
  for (const kind of ['wikipage', 'dailynote'] as const) {
    const vaultVal = dto?.[DTO_KEY[kind]] ?? null
    if (vaultVal) {
      outlineDirs[kind] = vaultVal
      continue
    }
    const legacy = await legacyDir(kind)
    if (legacy) {
      outlineDirs[kind] = legacy
      // 一次性迁移:把旧值写进 vault 配置(失败静默,不阻塞加载)
      await invoke('notemd_vault_settings_set', { [DTO_KEY[kind]]: legacy }).catch(() => {})
    } else {
      outlineDirs[kind] = DEFAULT_DIRS[kind]
    }
  }
}

export async function setOutlineDir(kind: DirKind, raw: string): Promise<void> {
  const v = normalizeDirName(raw, DEFAULT_DIRS[kind])
  outlineDirs[kind] = v
  await invoke('notemd_vault_settings_set', { [DTO_KEY[kind]]: v })
}
