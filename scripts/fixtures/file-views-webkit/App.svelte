<script lang="ts">
  import FilePluginView from '../../../src/components/FilePluginView.svelte'
  import { i18n } from '../../../src/lib/i18n/store.svelte'
  import type { Tab } from '../../../src/lib/tabs.svelte'

  i18n.locale = 'zh'
  const unsupported = new URL(location.href).searchParams.get('case') === 'unsupported'
  const content = unsupported
    ? '---\ntype: timeline\n---\n- 29:00–30:00 — 开发：不支持的时间。\n'
    : '---\ntype: timeline\n---\n# 2026-09-09 Timeline\n\n- 09:00–10:00 — 开发：隔离验收时间块。\n- 10:00–11:00 — 阅读：独立浏览器验收。\n'
  ;(window as Window & { fixtureContent: string }).fixtureContent = content
  const tab = {
    id: 'isolated-timeline', filePath: '/fixture/diary/2026-09-09.timeline.md',
    title: '2026-09-09.timeline.md', currentContent: content, initialContent: content,
    mode: 'rich', kind: 'markdown', externalState: 'fresh', externalBannerDismissed: false,
    lastKnownMtime: 0, lastKnownHash: '',
  } as Tab
</script>

<FilePluginView {tab} view={{ pluginId: 'notemd.timeline', viewId: 'timeline', entry: 'index.html' }}>
  {#snippet fallback()}<textarea aria-label="Fixture Markdown editor" value={tab.currentContent}></textarea>{/snippet}
</FilePluginView>

<style>
  :global(html), :global(body), :global(#app) { margin: 0; height: 100%; }
  :global(#app) { display: flex; flex-direction: column; }
  textarea { flex: 1; padding: 20px; }
</style>
