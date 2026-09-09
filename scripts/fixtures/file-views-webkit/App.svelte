<script lang="ts">
  import FilePluginView from '../../../src/components/FilePluginView.svelte'
  import ModeToggle from '../../../src/components/ModeToggle.svelte'
  import { i18n } from '../../../src/lib/i18n/store.svelte'
  import { tabs, type Tab } from '../../../src/lib/tabs.svelte'
  import { pluginRuntime } from '../../../src/lib/plugins/runtime.svelte'
  import { fallbackFileView, fileViewPresentation } from '../../../src/lib/plugins/file-view-presentation.svelte'

  i18n.locale = 'zh'
  const unsupported = new URL(location.href).searchParams.get('case') === 'unsupported'
  const content = unsupported
    ? '---\ntype: timeline\n---\n- 29:00–30:00 — 开发：不支持的时间。\n'
    : '---\ntype: timeline\n---\n# 2026-09-09 Timeline\n\n- 09:00–10:00 — 开发：隔离验收时间块。\n- 10:00–11:00 — 阅读：独立浏览器验收。\n'
  ;(window as Window & { fixtureContent: string }).fixtureContent = content
  tabs.splice(0)
  tabs.push({
    id: 'isolated-timeline', filePath: '/fixture/diary/2026-09-09.timeline.md',
    title: '2026-09-09.timeline.md', currentContent: content, initialContent: content,
    mode: 'rich', kind: 'markdown', externalState: 'fresh', externalBannerDismissed: false,
    lastKnownMtime: 0, lastKnownHash: '',
  } as Tab)
  const tab = tabs[0]
  pluginRuntime.manifests = [{
    id: 'notemd.timeline', name: 'Timeline', version: '1.0.0', binary: '', host_capabilities: [],
    file_views: [{ id: 'timeline', entry: 'index.html', selectors: [{ file_extensions: ['md'], frontmatter: { type: ['timeline'] } }] }],
  }]
  let presentation = $derived(fileViewPresentation(tab, pluginRuntime.manifests))
</script>

<div class="viewbar"><ModeToggle {tab} /></div>
{#if presentation.fallback}
  <div class="file-plugin-fallback" role="status">
    {presentation.fallback.reason === 'unsupported' ? '文件视图无法解析此文档，已打开默认编辑器。' : '文件视图未能载入，已打开默认编辑器。'}
  </div>
{/if}
{#if presentation.active}
  <FilePluginView {tab} view={presentation.active} onFallback={(reason) => fallbackFileView(tab, presentation.active!, reason)}>
    {#snippet fallback()}<textarea aria-label="Fixture Markdown editor" value={tab.currentContent}></textarea>{/snippet}
  </FilePluginView>
{:else}
  <textarea aria-label="Fixture Markdown editor" value={tab.currentContent}></textarea>
{/if}

<style>
  :global(html), :global(body), :global(#app) { margin: 0; height: 100%; }
  :global(#app) { display: flex; flex-direction: column; }
  .viewbar { display: flex; flex: 0 0 34px; align-items: center; justify-content: flex-end; padding: 0 28px; border-bottom: 1px solid color-mix(in srgb, CanvasText 10%, transparent); }
  .file-plugin-fallback { padding: 7px 12px; color: GrayText; font: 12px system-ui; }
  textarea { flex: 1; padding: 20px; }
</style>
