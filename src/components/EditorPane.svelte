<script lang="ts">
  import type { Tab } from '../lib/tabs.svelte'
  import { setContent } from '../lib/tabs.svelte'
  import RichEditor from './RichEditor.svelte'
  import SourceView from './SourceView.svelte'
  import HtmlPreview from './HtmlPreview.svelte'
  import ExternalChangeBanner from './ExternalChangeBanner.svelte'

  let { tab }: { tab: Tab } = $props()

  function onSourceInput(e: Event) {
    const ta = e.currentTarget as HTMLTextAreaElement
    setContent(tab.id, ta.value)
  }

  function onRichFlush(md: string) {
    setContent(tab.id, md)
  }
</script>

<div class="editor-stack">
  <ExternalChangeBanner {tab} />
  {#if tab.mode === 'source'}
    {#key tab.id}
      <SourceView value={tab.currentContent} oninput={onSourceInput} />
    {/key}
  {:else if tab.kind === 'html'}
    {#key tab.id}
      <HtmlPreview html={tab.currentContent} />
    {/key}
  {:else}
    {#key tab.id}
      <RichEditor
        {tab}
        onFlush={onRichFlush}
        wrapAsCodeBlock={tab.kind === 'code' ? (tab.language ?? '') : undefined}
      />
    {/key}
  {/if}
</div>

<style>
  .editor-stack {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
    min-height: 0;
  }
</style>
