<script lang="ts">
  import type { Tab } from '../lib/tabs.svelte'
  import { t } from '../lib/i18n/store.svelte'
  import { pluginRuntime } from '../lib/plugins/runtime.svelte'
  import { pluginName } from '../lib/plugins/plugin-i18n'
  import { SPARKLE_PATH } from '../lib/context-menu/icons'
  import {
    fileViewPresentation,
    fileViewManifest,
    selectFileView,
    selectRichFileView,
    selectSourceFileView,
  } from '../lib/plugins/file-view-presentation.svelte'

  let { tab }: { tab: Tab } = $props()
  const modeSparklePath = SPARKLE_PATH.replace('fill="#f59e0b"', 'fill="currentColor"')
  let presentation = $derived(fileViewPresentation(tab, pluginRuntime.manifests))
  let viewLabel = $derived.by(() => {
    const view = presentation.candidate
    const id = view?.pluginId
    const manifest = view ? fileViewManifest(tab, view, pluginRuntime.manifests) : undefined
    return manifest ? pluginName(manifest) : id ?? ''
  })
  let viewTitle = $derived(t('fileView.openView', { name: viewLabel }))
  let richActive = $derived(tab.mode === 'rich' && !presentation.active)
  let viewActive = $derived(tab.mode === 'rich' && !!presentation.active)

  function moveTab(event: KeyboardEvent) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    const buttons = [...(event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (current < 0 || !buttons.length) return
    event.preventDefault()
    const next = event.key === 'Home'
      ? buttons[0]
      : event.key === 'End'
        ? buttons.at(-1)!
        : buttons[(current + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length]
    next.click()
    next.focus()
  }
</script>

{#if tab.kind !== 'image' && tab.kind !== 'canvas'}
<div class="seg" role="tablist" aria-label={t('mode.editorMode')} tabindex="-1" onkeydown={moveTab}>
  <button
    type="button"
    role="tab"
    aria-selected={richActive}
    aria-label={t('mode.previewRich')}
    tabindex={richActive ? 0 : -1}
    class:active={richActive}
    onclick={() => selectRichFileView(tab)}
    title={t('mode.previewRich')}
  >
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
      <circle cx="12" cy="12" r="3"/>
    </svg>
  </button>
  <button
    type="button"
    role="tab"
    aria-selected={tab.mode === 'source'}
    aria-label={t('mode.source')}
    tabindex={tab.mode === 'source' ? 0 : -1}
    class:active={tab.mode === 'source'}
    onclick={() => selectSourceFileView(tab)}
    title={t('mode.source')}
  >
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <polyline points="16 18 22 12 16 6"/>
      <polyline points="8 6 2 12 8 18"/>
    </svg>
  </button>
  {#if presentation.candidate}
    <button
      type="button"
      role="tab"
      data-file-view-icon={presentation.candidate.icon}
      aria-selected={viewActive}
      aria-label={viewTitle}
      tabindex={viewActive ? 0 : -1}
      class:active={viewActive}
      onclick={() => presentation.candidate && selectFileView(tab, presentation.candidate)}
      title={viewTitle}
    >
      {#if presentation.candidate.icon === 'sparkle'}
        <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
          {@html modeSparklePath}
        </svg>
      {:else if presentation.candidate.icon === 'clock'}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9"/>
          <path d="M12 7v5l3 2"/>
        </svg>
      {:else}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="3" y="3" width="18" height="18" rx="2"/>
          <path d="M9 3v18M9 9h12"/>
        </svg>
      {/if}
    </button>
  {/if}
</div>
{/if}

<style>
  .seg {
    display: inline-flex;
    align-items: center;
    background: color-mix(in srgb, CanvasText 9%, Canvas);
    border-radius: 8px;
    padding: 2px;
    gap: 0;
  }
  .seg button {
    width: 32px;
    height: 26px;
    border: 0;
    background: transparent;
    color: CanvasText;
    border-radius: 6px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    opacity: 0.5;
    transition: opacity 80ms;
  }
  .seg button:hover { opacity: 0.85; }
  .seg button:focus-visible { outline: 2px solid AccentColor; outline-offset: 1px; }
  .seg button.active {
    background: Canvas;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12);
    opacity: 1;
  }
  .seg svg { display: block; }
</style>
