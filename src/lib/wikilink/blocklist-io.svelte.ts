// src/lib/wikilink/blocklist-io.svelte.ts
// vault/{wikipage}/blocklist.md 的播种 / 读取 / watch 重载。
// 响应式 wikilinkBlocklistState.version 供显示层订阅（重载后重渲染）。
import { sotvaultStore } from '../sotvault.svelte'
import { outlineDirs } from '../outline/dirs.svelte'
import { joinPath } from '../fs'
import { DEFAULT_BLOCKED_WIKILINKS, parseBlocklistFile, setBlockedWikilinks } from './blocklist'

export const wikilinkBlocklistState = $state<{ version: number }>({ version: 0 })

let unwatch: (() => void) | null = null
let watchedPath: string | null = null
/** 最近一次(每次 vault 变更重置)的加载 promise，供派生路径在首扫前 await。 */
let ready: Promise<void> | null = null

/**
 * 首次派生 wikilink → 伴生笔记前必须 await：确保黑名单已从 vault 加载进 Set，
 * 否则空 Set 会漏过所有拉黑项（黑名单加载是 fire-and-forget，与首扫存在竞态）。
 * 尚未触发加载时惰性触发一次；无 vault 时 ensure 会即刻以空表 resolve。
 */
export function whenWikilinkBlocklistReady(): Promise<void> {
  return ready ?? ensureWikilinkBlocklist()
}

function defaultFileText(): string {
  return '# 无效 wikilink 清单（此处列出的不会渲染为链接、不可点、不进关系索引）\n'
    + DEFAULT_BLOCKED_WIKILINKS.map((w) => `- ${w}`).join('\n') + '\n'
}

async function loadFrom(path: string): Promise<void> {
  const { readTextFile } = await import('@tauri-apps/plugin-fs')
  const text = await readTextFile(path)
  setBlockedWikilinks(parseBlocklistFile(text))
  wikilinkBlocklistState.version++
}

/**
 * 依当前 vault 根，确保 blocklist.md 存在（不存在则用默认三条播种）、
 * 加载进纯 Set、并监听变更。无 vault 时 no-op（黑名单保持空）。
 */
export function ensureWikilinkBlocklist(): Promise<void> {
  ready = loadAndWatch()
  return ready
}

async function loadAndWatch(): Promise<void> {
  const vault = sotvaultStore.vaultRoot
  if (!vault) { setBlockedWikilinks([]); wikilinkBlocklistState.version++; return }
  const dir = joinPath(vault, outlineDirs.wikipage)
  const path = joinPath(dir, 'blocklist.md')
  try {
    const { exists, mkdir, writeTextFile } = await import('@tauri-apps/plugin-fs')
    if (!(await exists(path).catch(() => false))) {
      await mkdir(dir, { recursive: true }).catch(() => {})
      await writeTextFile(path, defaultFileText())
    }
    await loadFrom(path)
    if (watchedPath !== path) {
      if (unwatch) { try { unwatch() } catch { /* ignore */ } unwatch = null }
      watchedPath = path
      const { watchImmediate } = await import('@tauri-apps/plugin-fs')
      watchImmediate(path, () => { void loadFrom(path).catch((e) => console.warn('[wikilink] reload blocklist failed:', e)) })
        .then((s) => { unwatch = s })
        .catch((e) => console.warn('[wikilink] watch blocklist failed:', e))
    }
  } catch (e) {
    console.warn('[wikilink] ensure blocklist failed:', e)
  }
}
