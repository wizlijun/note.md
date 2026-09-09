<script lang="ts">
  import FilePluginView from '../../src/components/FilePluginView.svelte'
  import { fileViewFor } from '../../src/lib/plugins/file-views'
  import { i18n } from '../../src/lib/i18n/store.svelte'
  i18n.locale = 'zh'
  import type { Tab } from '../../src/lib/tabs.svelte'
  import type { PluginManifest } from '../../src/lib/plugins/types'

  const initial = `---
type: Timeline
title: "2026-09-08 Timeline"
description: "合成日程，用于验证时间轴查看与来源跳转。"
---
# 2026-09-08 Timeline

所有内容均为测试数据，不关联个人知识库。

- 09:00:00–10:00:00 — 开发：实现日程时间轴，检查编辑器回退行为。 [开发记录](../agent/browser-example.md#line10)
  - 09:10:00–09:20:00 — 核查：验证来源链接与跨窗口消息。
- 09:15:00–09:45:00 — 审阅：评审时间块配色与布局。
- 10:00:00–10:40:00 — 阅读：学习木工与设计基础。 [阅读记录](../reading/browser-example.md)
- 10:45:00–11:25:00 — 家庭：安排本周家务与采购。
- 11:30:00–12:00:00 — 散步：沿公园步道休息。
- 12:10:00–12:40:00 — 随手记录：记下一条尚未分类的活动。
- 12:45:00–12:45:00 — 沟通：确认收到项目计划的即时记录。
`
  let tab = $state({ id: 'timeline-browser', filePath: '/fixture-vault/diary/2026-09-08.timeline.md', title: '2026-09-08.timeline.md', kind: 'markdown', mode: 'rich', initialContent: initial, currentContent: initial } as Tab)
  const manifest: PluginManifest = { id: 'notemd.timeline', name: 'Timeline', version: '1.0.0', binary: '', host_capabilities: [], file_views: [{ id: 'timeline', selectors: [{ file_extensions: ['md'], frontmatter: { type: ['timeline'] } }], entry: 'timeline-plugin.html' }] }
  let enabled = $state(true)
  const view = $derived(enabled ? fileViewFor({ path: tab.filePath, kind: tab.kind, content: tab.currentContent }, [manifest]) : null)

  Object.assign(window, { __timelineBrowser: {
    initial,
    events: [] as unknown[],
    get content() { return tab.currentContent },
    setContent(content: string) { tab.currentContent = content },
    reload(content: string) {
      tab.currentContent = content
      window.dispatchEvent(new CustomEvent('notemd:auto-reloaded', { detail: { tabId: tab.id } }))
    },
    setMode(mode: 'source' | 'rich') { tab.mode = mode },
    setEnabled(value: boolean) { enabled = value },
  } })
  window.addEventListener('message', (event) => {
    const state = (window as any).__timelineBrowser
    if (event.data?.type?.startsWith('file_view.')) state.events.push({ origin: event.origin, ...event.data })
  })
</script>

<main class="fixture">
  {#if tab.mode === 'source'}
    <textarea class="source-editor" aria-label="Markdown 源码" bind:value={tab.currentContent}></textarea>
  {:else if view}
    <FilePluginView {tab} {view}>
      {#snippet fallback()}
        <textarea class="fallback-editor" aria-label="Markdown 编辑器" bind:value={tab.currentContent}></textarea>
      {/snippet}
    </FilePluginView>
  {:else}
    <textarea class="fallback-editor" aria-label="Markdown 编辑器" bind:value={tab.currentContent}></textarea>
  {/if}
</main>

<style>
  :global(html), :global(body), :global(#fixture) { height: 100%; margin: 0; color-scheme: light dark; }
  :global(body) { color: CanvasText; background: Canvas; font-family: system-ui, sans-serif; }
  .fixture { height: 100%; display: flex; flex-direction: column; min-width: 0; min-height: 0; }
  textarea { flex: 1; box-sizing: border-box; width: 100%; resize: none; border: 0; color: CanvasText; background: Canvas; padding: 24px; font: 13px/1.7 ui-monospace, monospace; }
</style>
