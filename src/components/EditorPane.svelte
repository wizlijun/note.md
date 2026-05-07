<script lang="ts">
  import type { Tab } from '../lib/tabs.svelte'
  import { setContent } from '../lib/tabs.svelte'

  let { tab }: { tab: Tab } = $props()

  function onInput(e: Event) {
    const ta = e.currentTarget as HTMLTextAreaElement
    setContent(tab.id, ta.value)
  }
</script>

{#if tab.mode === 'source'}
  <textarea
    class="source"
    value={tab.currentContent}
    oninput={onInput}
    spellcheck="true"
    autofocus
  ></textarea>
{:else}
  <div class="rich-placeholder">Rich mode (wired in Task 7)</div>
{/if}

<style>
  .source {
    width: 100%;
    height: 100%;
    border: 0;
    outline: none;
    resize: none;
    padding: 16px 24px;
    font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
    font-size: 14px;
    line-height: 1.6;
    background: Canvas;
    color: CanvasText;
    box-sizing: border-box;
  }
  .rich-placeholder {
    padding: 16px;
    color: GrayText;
  }
</style>
