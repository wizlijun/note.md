import { readMd, writeMd, basename, isMarkdownPath } from './fs'
import { pushRecentFile, getRecentMode, setRecentMode } from './settings.svelte'

export type Mode = 'source' | 'rich'

export interface Tab {
  id: string
  filePath: string
  title: string
  initialContent: string
  currentContent: string
  mode: Mode
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

export async function openFile(path: string): Promise<void> {
  if (!isMarkdownPath(path)) {
    throw new Error(`Not a markdown file: ${path}`)
  }
  const existing = tabs.find((t) => t.filePath === path)
  if (existing) {
    activeId.value = existing.id
    return
  }
  const content = await readMd(path)
  const mode = getRecentMode(path) ?? 'source'
  const tab: Tab = {
    id: crypto.randomUUID(),
    filePath: path,
    title: basename(path),
    initialContent: content,
    currentContent: content,
    mode,
  }
  tabs.push(tab)
  activeId.value = tab.id
  await pushRecentFile(path)
}

export function setContent(id: string, md: string): void {
  const t = tabs.find((x) => x.id === id)
  if (t) t.currentContent = md
}

export function toggleMode(id: string): void {
  const t = tabs.find((x) => x.id === id)
  if (!t) return
  t.mode = t.mode === 'source' ? 'rich' : 'source'
  setRecentMode(t.filePath, t.mode).catch((e) => console.warn(e))
}

export async function saveActive(): Promise<void> {
  const t = activeTab()
  if (!t) return
  await writeMd(t.filePath, t.currentContent)
  t.initialContent = t.currentContent
}

export async function saveAs(id: string, newPath: string): Promise<void> {
  const t = tabs.find((x) => x.id === id)
  if (!t) return
  await writeMd(newPath, t.currentContent)
  t.filePath = newPath
  t.title = basename(newPath)
  t.initialContent = t.currentContent
  await pushRecentFile(newPath)
  setRecentMode(newPath, t.mode).catch((e) => console.warn(e))
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
  if (activeId.value === id) {
    activeId.value = tabs[idx]?.id ?? tabs[idx - 1]?.id ?? null
  }
  return true
}
