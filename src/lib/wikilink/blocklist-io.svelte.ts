// src/lib/wikilink/blocklist-io.svelte.ts
// vault/wikilink/blocklist.md 的播种 / 读取 / watch 重载。
// 响应式 wikilinkBlocklistState.version 供显示层订阅（重载后重渲染）。
import { sotvaultStore } from '../sotvault.svelte'
import { outlineDirs } from '../outline/dirs.svelte'
import { joinPath } from '../fs'
import { DEFAULT_BLOCKED_WIKILINKS, parseBlocklistFile, setBlockedWikilinks } from './blocklist'

export const wikilinkBlocklistState = $state<{ version: number }>({ version: 0 })

let unwatch: (() => void) | null = null
let watchedPath: string | null = null

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
export async function ensureWikilinkBlocklist(): Promise<void> {
  const vault = sotvaultStore.vaultRoot
  if (!vault) return
  const dir = joinPath(vault, outlineDirs.wikilink)
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
