<script lang="ts">
  import { untrack, type Snippet } from 'svelte'
  import type { Tab } from '../lib/tabs.svelte'
  import type { FileViewRef } from '../lib/plugins/file-views'
  import { t } from '../lib/i18n/store.svelte'
  import { handleFileViewMessage, type FileViewOpen } from '../lib/plugins/v2/file-view-msg'

  type FallbackReason = 'edit' | 'unsupported' | 'unavailable'
  let { tab, view, fallback, onFallback }: {
    tab: Tab
    view: FileViewRef
    fallback: Snippet
    onFallback?: (reason: FallbackReason) => void
  } = $props()
  let pluginOrigin = $derived(`plugin://${view.pluginId}`)
  let src = $derived(`${pluginOrigin}/${view.entry}`)
  let iframeEl: HTMLIFrameElement | undefined = $state()
  let status = $state<'loading' | 'ready' | 'fallback'>('loading')
  let fallbackReason = $state<FallbackReason>('unsupported')
  let loaded = false
  let requestId = 0
  let snapshot: FileViewOpen | undefined
  let activeSrc = ''
  let timer: ReturnType<typeof setTimeout> | undefined

  function clearTimer() {
    clearTimeout(timer)
    timer = undefined
  }

  function useDefaultEditor(reason: FallbackReason) {
    clearTimer()
    loaded = false
    fallbackReason = reason
    status = 'fallback'
    onFallback?.(reason)
  }

  function sendSnapshot() {
    if (!loaded || !snapshot || status === 'fallback') return
    try {
      iframeEl?.contentWindow?.postMessage(snapshot, pluginOrigin)
    } catch {
      useDefaultEditor('unavailable')
    }
  }

  function begin(content: string, uri: string, viewId: string, nextSrc: string) {
    clearTimer()
    if (activeSrc !== nextSrc) loaded = false
    activeSrc = nextSrc
    snapshot = { type: 'file_view.open', uri, content, viewId, requestId: ++requestId }
    status = 'loading'
    const pendingRequest = requestId
    // Includes asset loading and parsing; onload never extends this deadline.
    timer = setTimeout(() => {
      if (requestId === pendingRequest && status === 'loading') useDefaultEditor('unavailable')
    }, 8_000)
    sendSnapshot()
  }

  function retry() {
    begin(tab.currentContent, tab.filePath, view.viewId, src)
  }

  $effect(() => {
    const content = tab.currentContent
    const uri = tab.filePath
    const viewId = view.viewId
    const nextSrc = src
    untrack(() => {
      // After a fallback, typing must remain in the default editor. Explicit
      // retry, source/rich switching and external reloads reopen the view.
      if (status === 'fallback') return
      // The reload event can already have sent this snapshot before Svelte's
      // content effect runs. Do not issue another request or extend its timer.
      if (snapshot?.content === content && snapshot.uri === uri && snapshot.viewId === viewId && activeSrc === nextSrc) return
      begin(content, uri, viewId, nextSrc)
    })
  })

  $effect(() => {
    const onMessage = (event: MessageEvent) => {
      if (status === 'fallback') return
      handleFileViewMessage(event, {
        pluginOrigin,
        expectedSource: iframeEl?.contentWindow,
        requestId,
        onReady: () => { clearTimer(); status = 'ready' },
        onFallback: (reason) => useDefaultEditor(reason === 'edit' ? 'edit' : 'unsupported'),
      })
    }
    const onReload = (event: Event) => {
      if ((event as CustomEvent<{ tabId: string }>).detail?.tabId === tab.id) retry()
    }
    window.addEventListener('message', onMessage)
    window.addEventListener('notemd:auto-reloaded', onReload)
    return () => {
      clearTimer()
      window.removeEventListener('message', onMessage)
      window.removeEventListener('notemd:auto-reloaded', onReload)
    }
  })
</script>

{#if status === 'fallback'}
  <div class="file-plugin-fallback" role="status">
    <span>{t(fallbackReason === 'edit' ? 'fileView.editing' : fallbackReason === 'unsupported' ? 'fileView.unsupported' : 'fileView.unavailable')}</span>
  </div>
  {@render fallback()}
{:else}
  <div class="file-plugin-view" aria-busy={status === 'loading'}>
    {#if status === 'loading'}
      <div class="file-plugin-loading" role="status">
        <span>{t('fileView.loading')}</span>
      </div>
    {/if}
    {#key src}
      <iframe
        bind:this={iframeEl}
        class:pending={status === 'loading'}
        title={tab.title}
        {src}
        sandbox="allow-scripts allow-same-origin allow-forms"
        onload={() => { loaded = true; sendSnapshot() }}
        onerror={() => useDefaultEditor('unavailable')}
      ></iframe>
    {/key}
  </div>
{/if}

<style>
  .file-plugin-view { position: relative; display: flex; flex: 1; min-height: 0; min-width: 0; }
  iframe { flex: 1; width: 100%; height: 100%; min-height: 0; border: 0; background: Canvas; }
  iframe.pending { visibility: hidden; }
  .file-plugin-loading { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: GrayText; font-size: 13px; }
  .file-plugin-fallback { display: flex; align-items: center; padding: 7px 12px; border-bottom: 1px solid color-mix(in srgb, CanvasText 12%, transparent); color: GrayText; font-size: 12px; }
</style>
