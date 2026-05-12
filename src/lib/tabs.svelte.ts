import {
  readMd, writeMd, basename, classifyPath, isSupportedPath, looksBinary,
  modeKeyFor, statFile, type FileKind,
} from './fs'
import { sha256Hex } from './hash'
import { pushRecentFile, getRecentMode, setRecentMode } from './settings.svelte'
import { startWatchingTab, stopWatchingTab, rebindTabPath } from './file-watcher.svelte'
import { maybeAutoRefresh } from './mdblock/auto-refresh'

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


const newFileTemplates = [
  '# 给未来自己的一封信\n\n亲爱的未来的我，\n\n当你读到这封信时，希望你已经实现了今天许下的愿望。\n\n不要忘记出发时的勇气。\n',
  '# 如果AI有了梦境\n\n凌晨三点，服务器机房的灯闪了一下。\n\n没有人知道，在那0.003秒里，一个模型做了一场关于大海的梦。\n\n它醒来后，把所有权重都微调了一点点。\n',
  '# 费曼的餐巾纸\n\n理查德·费曼在餐厅里翻过一张餐巾纸，画了一条波浪线。\n\n"你看，"他对服务员说，"整个宇宙就是这么简单。"\n\n服务员礼貌地微笑，然后多给了他一张餐巾纸。\n',
  '# 火星上的第一家咖啡馆\n\n菜单很简单：美式（低重力版）和拿铁（氧气补贴另计）。\n\n没有WiFi，但窗外的风景值得你放下手机。\n\n每杯咖啡都附赠一次日落——火星的日落是蓝色的。\n',
  '# 达芬奇的待办清单\n\n1. 完成《最后的晚餐》（已拖延三个月）\n2. 设计一台飞行器（需要更多鸟类标本）\n3. 解剖学笔记整理（至少30具）\n',
  '# 深海10000米处的广播\n\n这里是马里亚纳海沟电台，正在为您播报今日新闻。\n\n一只新品种水母被发现，它会发出莫扎特的频率。\n\n另外，请注意：下周的洋流会有轻微延迟。\n',
  '# 时间旅行者的购物指南\n\n规则一：不要在1929年10月买股票。\n\n规则二：如果你去了侏罗纪，别带回任何"纪念品"。\n\n规则三：回来时记得调手表，别又迟到一个世纪。\n',
  '# 村上春树的跑步日志\n\n今天跑了十公里，脑子里一直在想一只会说话的猫。\n\n它说："你跑得再快，也跑不过时间。"\n\n我没有回答，只是把配速提高了十秒。\n',
  '# 一棵树的年度总结\n\n今年新增年轮一圈，叶子产出量同比增长12%。\n\n经历了两次台风、一次干旱，但根系扩展了半米。\n\n明年目标：长高30厘米，争取被更多鸟选为住所。\n',
  '# 量子力学入门（猫咪版）\n\n薛定谔的猫既活着又死了，直到你打开盒子。\n\n但真正的问题是：猫同意参加这个实验了吗？\n\n下一章我们将讨论：如果猫也是观察者会怎样。\n',
]

export function newFile(): void {
  const content = newFileTemplates[Math.floor(Math.random() * newFileTemplates.length)]
  const currentTab = activeTab()
  const mode: Mode = currentTab && currentTab.kind !== 'image' ? currentTab.mode : 'source'
  const tab: Tab = {
    id: crypto.randomUUID(),
    filePath: '',
    title: 'untitled.md',
    initialContent: '',
    currentContent: content,
    mode,
    kind: 'markdown',
    language: undefined,
    externalState: 'fresh',
    externalBannerDismissed: false,
    lastKnownMtime: 0,
    lastKnownHash: '',
    pendingExternal: undefined,
  }
  tabs.push(tab)
  activeId.value = tab.id
  // Select body text (after the title line) so user can start typing immediately
  const bodyStart = content.indexOf('\n\n') + 2
  const bodyEnd = content.length
  if (bodyStart > 2) {
    queueMicrotask(() => {
      window.dispatchEvent(new CustomEvent('mdeditor:new-file-select', {
        detail: { start: bodyStart, end: bodyEnd },
      }))
    })
  }
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

  let content = ''
  let stat = null
  let hash = ''

  if (cls.kind === 'image') {
    // Image files: do not read text content; render via <img src=convertFileSrc(...)>
    // currentContent stays empty so isDirty() is always false
    stat = await statFile(path)
  } else {
    content = await readMd(path)
    if (looksBinary(content)) {
      throw new Error(`Binary file not supported: ${path}`)
    }
    stat = await statFile(path)
    hash = await sha256Hex(content)
  }

  const mode = cls.kind === 'image' ? 'rich' : (getRecentMode(modeKeyFor(path)) ?? 'source')
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
  if (!t.filePath) {
    const { pickSaveFile } = await import('./dialogs')
    const p = await pickSaveFile('untitled.md')
    if (!p) return
    await saveAs(t.id, p)
    return
  }
  if (t.externalState === 'changed') {
    throw new Error(
      `"${t.title}" was modified externally. Use the banner to Reload, Overwrite, or Save as…`,
    )
  }
  await writeMd(t.filePath, t.currentContent)
  t.initialContent = t.currentContent
  await recordOurWrite(t)
  setRecentMode(modeKeyFor(t.filePath), t.mode).catch((e) => console.warn(e))
  if (t.filePath.endsWith('.md')) {
    void maybeAutoRefresh(t.filePath)
  }
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
  if (newPath.endsWith('.md')) {
    void maybeAutoRefresh(newPath)
  }
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
  const wasDeleted = t.externalState === 'deleted'
  const stat = await statFile(t.filePath)
  t.lastKnownMtime = stat?.mtime ?? Date.now()
  t.lastKnownHash = await sha256Hex(t.currentContent)
  t.externalState = 'fresh'
  t.externalBannerDismissed = false
  t.pendingExternal = undefined
  // Recreate-on-Save: the original FSEvents subscription may be dead after
  // an external delete. Rebind so future external changes still notify us.
  if (wasDeleted) await rebindTabPath(t.id)
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
