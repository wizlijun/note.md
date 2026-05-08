import {
  readMd, writeMd, basename, classifyPath, isSupportedPath, looksBinary,
  modeKeyFor, statFile, type FileKind,
} from './fs'
import { sha256Hex } from './hash'
import { pushRecentFile, getRecentMode, setRecentMode } from './settings.svelte'
import { startWatchingTab, stopWatchingTab, rebindTabPath } from './file-watcher.svelte'

export type Mode = 'source' | 'rich'

export interface Tab {
  id: string
  filePath: string
  title: string
  initialContent: string
  currentContent: string
  mode: Mode
  kind: FileKind
  language?: string
  /** External-change state (see external-state.ts). */
  externalState: 'fresh' | 'changed' | 'deleted'
  /** True after the user clicks the banner's × until the next external event. */
  externalBannerDismissed: boolean
  /** mtime (ms) and sha256 of the disk version we last accepted. */
  lastKnownMtime: number
  lastKnownHash: string
  /** Cached new-content snapshot when externalState === 'changed'. */
  pendingExternal?: { mtime: number; hash: string; content: string }
}

export const tabs = $state<Tab[]>([])
export const activeId = $state<{ value: string | null }>({ value: null })

export function activeTab(): Tab | null {
  return tabs.find((t) => t.id === activeId.value) ?? null
}

export function isDirty(id: string): boolean {
  const t = tabs.find((x) => x.id === id)
  return t ? t.currentContent !== t.initialContent : false
}

export function activate(id: string): void {
  if (tabs.some((t) => t.id === id)) activeId.value = id
}

function defaultModeFor(kind: FileKind): Mode {
  return kind === 'html' ? 'rich' : 'source'
}

export async function openFile(path: string): Promise<void> {
  const cls = classifyPath(path)
  if (!cls) {
    throw new Error(`Unsupported file type: ${path}`)
  }
  const existing = tabs.find((t) => t.filePath === path)
  if (existing) {
    activeId.value = existing.id
    return
  }
  const content = await readMd(path)
  if (looksBinary(content)) {
    throw new Error(`Binary file not supported: ${path}`)
  }
  const mode = getRecentMode(modeKeyFor(path)) ?? defaultModeFor(cls.kind)
  const stat = await statFile(path)
  const hash = await sha256Hex(content)
  const tab: Tab = {
    id: crypto.randomUUID(),
    filePath: path,
    title: basename(path),
    initialContent: content,
    currentContent: content,
    mode,
    kind: cls.kind,
    language: cls.language,
    externalState: 'fresh',
    externalBannerDismissed: false,
    lastKnownMtime: stat?.mtime ?? 0,
    lastKnownHash: hash,
    pendingExternal: undefined,
  }
  tabs.push(tab)
  activeId.value = tab.id
  await pushRecentFile(path)
  await startWatchingTab(tab)
}

export function setContent(id: string, md: string): void {
  const t = tabs.find((x) => x.id === id)
  if (t) t.currentContent = md
}

export function toggleMode(id: string): void {
  const t = tabs.find((x) => x.id === id)
  if (!t) return
  setMode(id, t.mode === 'source' ? 'rich' : 'source')
}

export function setMode(id: string, mode: Mode): void {
  const t = tabs.find((x) => x.id === id)
  if (!t || t.mode === mode) return
  t.mode = mode
  setRecentMode(modeKeyFor(t.filePath), mode).catch((e) => console.warn(e))
}

export async function saveActive(): Promise<void> {
  const t = activeTab()
  if (!t) return
  await writeMd(t.filePath, t.currentContent)
  t.initialContent = t.currentContent
  await recordOurWrite(t)
}

export async function saveAs(id: string, newPath: string): Promise<void> {
  const t = tabs.find((x) => x.id === id)
  if (!t) return
  await writeMd(newPath, t.currentContent)
  t.filePath = newPath
  t.title = basename(newPath)
  t.initialContent = t.currentContent
  // Re-classify in case user changed extension
  const cls = classifyPath(newPath)
  if (cls) {
    t.kind = cls.kind
    t.language = cls.language
  } else {
    console.warn(`[saveAs] unrecognised extension; retained old kind: ${newPath}`)
  }
  await pushRecentFile(newPath)
  setRecentMode(modeKeyFor(newPath), t.mode).catch((e) => console.warn(e))
  await recordOurWrite(t)
  await rebindTabPath(id)
}

export type DirtyChoice = 'save' | 'discard' | 'cancel'

export async function closeTab(
  id: string,
  confirm: () => Promise<DirtyChoice>,
): Promise<boolean> {
  const idx = tabs.findIndex((t) => t.id === id)
  if (idx < 0) return false
  if (isDirty(id)) {
    const choice = await confirm()
    if (choice === 'cancel') return false
    if (choice === 'save') {
      const previousActiveId = activeId.value
      activeId.value = id
      await saveActive()
      activeId.value = previousActiveId
    }
  }
  tabs.splice(idx, 1)
  await stopWatchingTab(id)
  if (activeId.value === id) {
    activeId.value = tabs[idx]?.id ?? tabs[idx - 1]?.id ?? null
  }
  return true
}

/**
 * After a write that we initiated, capture the post-write mtime and hash so
 * the imminent watcher echo (or focus-poll re-stat) can be recognised as our
 * own and ignored. Also resets externalState back to 'fresh'.
 *
 * Exported so the autosave loop can call it after each silent write — without
 * this, every autosave would race the watcher and show a phantom external-
 * change banner while the user is still typing.
 */
export async function recordOurWrite(t: Tab): Promise<void> {
  const stat = await statFile(t.filePath)
  t.lastKnownMtime = stat?.mtime ?? Date.now()
  t.lastKnownHash = await sha256Hex(t.currentContent)
  t.externalState = 'fresh'
  t.externalBannerDismissed = false
  t.pendingExternal = undefined
}

/**
 * Discard local edits and replace the buffer with whatever the watcher last
 * read from disk (`pendingExternal`). Clears banner state.
 *
 * Pre: tab.externalState === 'changed' && tab.pendingExternal != null.
 */
export async function reloadFromDisk(id: string): Promise<void> {
  const t = tabs.find((x) => x.id === id)
  if (!t || !t.pendingExternal) return
  const p = t.pendingExternal
  t.initialContent = p.content
  t.currentContent = p.content
  t.lastKnownMtime = p.mtime
  t.lastKnownHash = p.hash
  t.externalState = 'fresh'
  t.externalBannerDismissed = false
  t.pendingExternal = undefined
}

/**
 * Write the current buffer to disk, accepting the loss of the external
 * change. Clears banner state.
 */
export async function overwriteOnDisk(id: string): Promise<void> {
  const t = tabs.find((x) => x.id === id)
  if (!t) return
  await writeMd(t.filePath, t.currentContent)
  t.initialContent = t.currentContent
  await recordOurWrite(t)
}

/**
 * Hide the banner without resolving the change. State stays non-fresh; the
 * banner reappears on the next external event.
 */
export function dismissExternalBanner(id: string): void {
  const t = tabs.find((x) => x.id === id)
  if (t) t.externalBannerDismissed = true
}
