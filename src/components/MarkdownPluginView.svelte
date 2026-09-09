<script lang="ts">
  import { untrack, type Snippet } from 'svelte'
  import type { Tab } from '../lib/tabs.svelte'
  import type { CustomEditorRef } from '../lib/plugins/custom-editors'
  import { handleMarkdownViewerMessage, type MarkdownViewerOpen } from '../lib/plugins/v2/markdown-view-msg'

  let { tab, editor, fallback }: { tab: Tab; editor: CustomEditorRef; fallback: Snippet } = $props()
  let pluginOrigin = $derived(`plugin://${editor.pluginId}`)
  let src = $derived(`${pluginOrigin}/${editor.entry}`)
  let iframeEl: HTMLIFrameElement | undefined = $state()
  let status = $state<'loading' | 'ready' | 'fallback'>('loading')
  let fallbackReason = $state<'edit' | 'unsupported' | 'unavailable'>('unsupported')
  let loaded = false
  let requestId = 0
  let snapshot: MarkdownViewerOpen | undefined
  let activeSrc = ''
  let timer: ReturnType<typeof setTimeout> | undefined

  function clearTimer() {
    clearTimeout(timer)
    timer = undefined
  }

  function useMarkdown(reason: 'edit' | 'unsupported' | 'unavailable') {
    clearTimer()
    loaded = false
    fallbackReason = reason
    status = 'fallback'
  }

  function sendSnapshot() {
    if (!loaded || !snapshot || status === 'fallback') return
    try {
      iframeEl?.contentWindow?.postMessage(snapshot, pluginOrigin)
    } catch {
      useMarkdown('unavailable')
    }
  }

  function begin(content: string, uri: string, editorId: string, nextSrc: string) {
    clearTimer()
    if (activeSrc !== nextSrc) loaded = false
    activeSrc = nextSrc
    snapshot = { type: 'custom_editor.open', uri, content, editorId, requestId: ++requestId }
    status = 'loading'
    const pendingRequest = requestId
    // Includes asset loading and parsing; onload never extends this deadline.
    timer = setTimeout(() => {
      if (requestId === pendingRequest && status === 'loading') useMarkdown('unavailable')
    }, 8_000)
    sendSnapshot()
  }

  function retry() {
    begin(tab.currentContent, tab.filePath, editor.editorId, src)
  }

  $effect(() => {
    const content = tab.currentContent
    const uri = tab.filePath
    const editorId = editor.editorId
    const nextSrc = src
    untrack(() => {
      // After a fallback, typing must remain in the Markdown editor. Explicit
      // retry, source/rich switching and external reloads reopen the view.
      if (status === 'fallback' && activeSrc === nextSrc) return
      // The reload event can already have sent this snapshot before Svelte's
      // content effect runs. Do not issue another request or extend its timer.
      if (snapshot?.content === content && snapshot.uri === uri && snapshot.editorId === editorId && activeSrc === nextSrc) return
      begin(content, uri, editorId, nextSrc)
    })
  })

  $effect(() => {
    const onMessage = (event: MessageEvent) => {
      if (status === 'fallback') return
      handleMarkdownViewerMessage(event, {
        pluginOrigin,
        expectedSource: iframeEl?.contentWindow,
        requestId,
        onReady: () => { clearTimer(); status = 'ready' },
        onFallback: (reason) => useMarkdown(reason === 'edit' ? 'edit' : 'unsupported'),
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
  <div class="markdown-plugin-fallback" role="status">
    <span>{fallbackReason === 'edit' ? '正在编辑 Markdown' : fallbackReason === 'unsupported' ? '显示插件无法解析此文档，已打开 Markdown 编辑器。' : '显示插件未能载入，已打开 Markdown 编辑器。'}</span>
    <button type="button" onclick={retry}>返回插件视图</button>
  </div>
  {@render fallback()}
{:else}
  <div class="markdown-plugin-view" aria-busy={status === 'loading'}>
    {#if status === 'loading'}
      <div class="markdown-plugin-loading" role="status">
        <span>正在载入视图…</span>
        <button type="button" onclick={() => useMarkdown('edit')}>使用 Markdown 编辑器</button>
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
        onerror={() => useMarkdown('unavailable')}
      ></iframe>
    {/key}
  </div>
{/if}

<style>
  .markdown-plugin-view { position: relative; display: flex; flex: 1; min-height: 0; min-width: 0; }
  iframe { flex: 1; width: 100%; height: 100%; min-height: 0; border: 0; background: Canvas; }
  iframe.pending { visibility: hidden; }
  .markdown-plugin-loading { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; color: GrayText; font-size: 13px; }
  .markdown-plugin-fallback { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 7px 12px; border-bottom: 1px solid color-mix(in srgb, CanvasText 12%, transparent); color: GrayText; font-size: 12px; }
  button { flex-shrink: 0; border: 0; border-radius: 5px; padding: 5px 8px; font: inherit; color: AccentColor; background: color-mix(in srgb, AccentColor 10%, Canvas); cursor: pointer; }
  button:focus-visible { outline: 2px solid AccentColor; outline-offset: 2px; }
</style>
