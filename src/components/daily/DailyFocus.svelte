<!-- src/components/daily/DailyFocus.svelte — 每日日志的 zoom 聚焦视图(Roam block-focus 式)。
     给定 {date, path}(path=结构性索引路径),打开该天的 daily .note.md 并挂载受控
     聚焦的 OutlineEditor:只显示 path 定位的那棵子树,顶部日期面包屑做 zoom-out。

     生命周期与 DailyPage 完全一致(同一 webview,共用 tabs/outline 单例):按路径
     openNewOutlineTab(去重),卸载/切走时 flush→closeTab,遵守 intent-save/wipe-guard。

     聚焦变更(bullet 深钻 / 面包屑回退)通过 `focuschange` 事件上抛,由 daily-notes-app
     更新视图(path=null → 回到该天 feed)。 -->
<script lang="ts">
  import { parseOutline } from '../../lib/outline/markdown'
  import { outlineDirs } from '../../lib/outline/dirs.svelte'
  import { sotvaultStore } from '../../lib/sotvault.svelte'
  import { dailyNotePath } from '../../lib/outline/daily'
  import { tabs, openNewOutlineTab, saveTab, closeTab, isDirty, type Tab } from '../../lib/tabs.svelte'
  import { untrack, onMount, createEventDispatcher } from 'svelte'
  import { isEffectivelyEmptyTree, outline, bump } from '../../lib/outline/store.svelte'
  import { applyFolds, setPathExpanded, noteKey, pathOfNodeIn, nodeIdAtPath } from '../../lib/daily/folds'
  import type { OutlineNode as NodeT } from '../../lib/outline/model'
  import OutlineEditor from '../outline/OutlineEditor.svelte'
  import OutlineBreadcrumb from '../outline/OutlineBreadcrumb.svelte'

  // path(结构性索引路径)寻址,而非 node id:本视图重开 tab 会把 .note.md 重解析成
  // 一棵 id 全新的树,只有 path 能跨解析对齐(与 DailyDay 只读↔编辑器桥接同理)。
  let { date, path, rootLabel }: { date: string; path: number[]; rootLabel: string } = $props()
  const dispatch = createEventDispatcher<{ linkclick: { raw: string }; focuschange: { path: number[] | null } }>()

  const notePath = $derived(
    sotvaultStore.vaultRoot ? dailyNotePath(sotvaultStore.vaultRoot, outlineDirs.dailynote, date) : null,
  )

  /** path → 本视图已加载的 outline 树里的实际 node id(树未就绪 → null)。 */
  const focusId = $derived.by<string | null>(() => {
    void outline.version
    if (!editorTab || !notePath || outline.docPath !== notePath) return null
    return nodeIdAtPath(outline.tree, path)
  })
  /** OutlineEditor / 面包屑内部给出的是当前树的 id;转回 path 存进视图状态。 */
  function emitFocus(id: string | null): void {
    dispatch('focuschange', { path: id == null ? null : pathOfNodeIn(outline.tree, id) })
  }

  let editorTab = $state<Tab | null>(null)

  async function ensureEditorTab(filePath: string): Promise<void> {
    let tab = tabs.find((x) => x.filePath === filePath) ?? null
    if (!tab) {
      const { readTextFile } = await import('@tauri-apps/plugin-fs')
      const text = await readTextFile(filePath).catch(() => '')
      await openNewOutlineTab(filePath, text)
      tab = tabs.find((x) => x.filePath === filePath) ?? null
    }
    editorTab = tab
  }

  /** intent-save / wipe-guard 冲刷,与 DailyPage.flush 同规则。 */
  async function flush(tab: Tab, filePath: string): Promise<void> {
    if (!isDirty(tab.id)) return
    if (isEffectivelyEmptyTree(parseOutline(tab.currentContent))) {
      const { exists } = await import('@tauri-apps/plugin-fs')
      const existed = await exists(filePath).catch(() => false)
      if (!existed) return
    }
    await saveTab(tab.id).catch(() => {})
  }

  export async function deactivate(): Promise<void> {
    const tab = editorTab
    const filePath = boundPath
    if (!tab || !filePath) { editorTab = null; return }
    await flush(tab, filePath)
    await closeTab(tab.id, async () => 'discard').catch(() => {})
    editorTab = null
    foldsAppliedTo = null
  }

  let boundPath: string | null = null
  $effect(() => {
    const filePath = notePath
    untrack(() => {
      if (filePath === boundPath) return
      void (async () => {
        await deactivate()
        boundPath = filePath
        if (filePath) await ensureEditorTab(filePath)
      })()
    })
  })

  let foldsAppliedTo: string | null = null
  $effect(() => {
    void outline.version
    const docPath = outline.docPath
    if (!editorTab || !notePath || docPath !== notePath) return
    if (foldsAppliedTo === notePath) return
    untrack(() => {
      applyFolds(outline.tree, noteKey(sotvaultStore.vaultRoot, notePath))
      foldsAppliedTo = notePath
      bump()
    })
  })

  function persistFold(n: NodeT): void {
    if (!notePath) return
    void setPathExpanded(
      sotvaultStore.vaultRoot ?? '',
      noteKey(sotvaultStore.vaultRoot, notePath),
      pathOfNodeIn(outline.tree, n.id),
      !n.collapsed,
    )
  }

  onMount(() => () => { foldsAppliedTo = null; void deactivate() })
</script>

<section class="focus">
  {#if editorTab}
    {#if focusId}
      <OutlineBreadcrumb tree={outline.tree} focusRootId={focusId} {rootLabel} onCrumb={emitFocus} />
    {/if}
    {#key editorTab.id}
      <OutlineEditor
        tab={editorTab}
        embedded={true}
        focusRootId={focusId}
        onFocusChange={emitFocus}
        onWikilink={(target) => dispatch('linkclick', { raw: `[[${target}]]` })}
        onCollapse={persistFold}
      />
    {/key}
  {/if}
</section>

<style>
  .focus { height: 100%; display: flex; flex-direction: column; overflow: hidden; }
</style>
