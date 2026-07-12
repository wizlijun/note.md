<script lang="ts">
  import { invoke } from '@tauri-apps/api/core'
  import { getCurrentWindow } from '@tauri-apps/api/window'
  import DiffView from './components/history/DiffView.svelte'

  interface PreviewPayload { title: string; kind: string; content: string }

  let payload = $state<PreviewPayload | null>(null)
  let missing = $state(false)

  async function fetchPayload() {
    try {
      const label = getCurrentWindow().label
      const p = await invoke<PreviewPayload | null>('take_preview_payload', { label })
      if (p) {
        payload = p
        missing = false
        void getCurrentWindow().setTitle(p.title).catch(() => {})
      } else if (!payload) {
        missing = true
      }
    } catch (e) {
      console.warn('[preview] fetch payload:', e)
      if (!payload) missing = true
    }
  }

  $effect(() => {
    void fetchPayload()
    const un = getCurrentWindow().listen('preview-updated', () => { void fetchPayload() })
    return () => { void un.then((f) => f()) }
  })
</script>

<main class="preview-root">
  {#if payload?.kind === 'diff'}
    <DiffView content={payload.content} />
  {:else if payload?.kind === 'rich'}
    <iframe class="rich-frame" title={payload.title} srcdoc={payload.content} sandbox="allow-same-origin"></iframe>
  {:else if missing}
    <div class="empty">This preview is no longer available. Reopen it from the history panel.</div>
  {/if}
</main>

<style>
  /* Independent window: declare its own color-scheme so system canvas colors
     (used by DiffView) track light/dark, instead of being stuck light. */
  :global(:root) { color-scheme: light dark; }
  :global(html), :global(body) { margin: 0; height: 100%; }
  .preview-root {
    display: flex;
    flex-direction: column;
    height: 100vh;
    background: Canvas;
    color: CanvasText;
    overflow: hidden;
  }
  .rich-frame {
    flex: 1;
    width: 100%;
    border: 0;
    background: #fff;
  }
  .empty { padding: 24px; opacity: 0.6; font-size: 13px; }
</style>
