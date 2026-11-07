<script lang="ts">
  import { onMount } from 'svelte'
  import { listen, type UnlistenFn } from '@tauri-apps/api/event'
  import { getCurrentWindow } from '@tauri-apps/api/window'
  import { invoke } from '@tauri-apps/api/core'
  import { acceptSumiSnapshot, acknowledgeSumiProjection, prepareFileViewTransition, setMode, type Tab } from '../lib/tabs.svelte'
  import type { FileViewRef } from '../lib/plugins/file-views'
  import { boundsForNative, nativeSurfaceOccluded } from '../lib/sumi/geometry'
  import { openSumiOwner, closeSumiOwner, mountSumiOwner, detachSumiSurface, updateSumiSurface, type SumiOwner, type NativeBinding, type ProjectionIdentity } from '../lib/sumi/session'
  import SumiRecovery from './SumiRecovery.svelte'

  let { tab, view }: { tab: Tab; view: FileViewRef } = $props()
  let element: HTMLDivElement
  let status = $state<'loading' | 'ready' | 'error'>('loading')
  let failure = $state('')
  let saveError = $state('')
  let owner = $state.raw<SumiOwner>()
  let binding: NativeBinding | undefined
  let disposed = false
  let frame = 0
  let visible: boolean | undefined
  let previousBounds = ''
  let scale = 1
  let reopen = $state.raw<() => Promise<void>>(async () => {})
  let navigating = false

  async function focusNavigation(action: string) {
    if (navigating || !owner || !['new_page', 'previous_page', 'next_page', 'menu'].includes(action)) return
    navigating = true
    const pageId = owner.pageId
    try {
      await prepareFileViewTransition(tab.id)
      await setMode(tab.id, 'source')
      if (tab.mode !== 'source') throw new Error('原编辑面尚未完成保存，请稍后重试')
      await closeSumiOwner(tab.id)
      await invoke('plugin_v2_open_window', {
        pluginId: view.pluginId, windowId: 'main', seed: { kind: 'sumi-navigation', pageId, action },
      })
    } catch (error) {
      const { showError } = await import('../lib/dialogs')
      void showError(String(error))
    } finally { navigating = false }
  }

  function failed(error: unknown) {
    if (disposed) return
    failure = String(error)
    status = 'error'
  }
  async function geometry() {
    if (disposed || !owner || !binding || !element?.isConnected) return
    const bounds = boundsForNative(element, scale), encoded = JSON.stringify(bounds)
    if (encoded !== previousBounds) {
      await updateSumiSurface(owner, binding, 'sumi_bounds', { bounds })
      previousBounds = encoded
    }
    const nextVisible = status !== 'error' && !nativeSurfaceOccluded(element) && bounds.width > 0 && bounds.height > 0
    if (nextVisible !== visible) {
      await updateSumiSurface(owner, binding, 'sumi_visible', { visible: nextVisible })
      visible = nextVisible
    }
  }
  function schedule() {
    if (frame || disposed) return
    frame = requestAnimationFrame(() => {
      frame = 0
      void geometry().catch(error => {
        // IME owns its surface until commit; the next state/DOM event retries.
        if (!String(error).includes('composition active')) failed(error)
      })
    })
  }
  async function updateScale() {
    const nativeWindow = getCurrentWindow()
    const [size, dpi] = await Promise.all([nativeWindow.innerSize(), nativeWindow.scaleFactor()])
    scale = window.innerWidth > 0 ? size.width / dpi / window.innerWidth : 1
    schedule()
  }
  function resized() { void updateScale().catch(failed) }

  onMount(() => {
    const stops: UnlistenFn[] = []
    const resize = new ResizeObserver(schedule)
    resize.observe(element)
    const mutations = new MutationObserver(schedule)
    mutations.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'open', 'aria-hidden'] })
    window.addEventListener('resize', resized)
    window.addEventListener('scroll', schedule, true)
    document.addEventListener('visibilitychange', schedule)
    const initialize = async () => {
      await prepareFileViewTransition(tab.id, true)
      if (disposed) return
      owner = await openSumiOwner(tab.id, tab.filePath, view.pluginId)
      if (disposed) return
      const stateStop = await listen<{ page_id?: string; tab_id?: string; revision?: number; projection_identity?: ProjectionIdentity; notice?: string; error?: string; durable?: boolean; projected?: boolean }>('sumi-state', event => {
        if (event.payload.page_id && event.payload.page_id !== owner?.pageId || event.payload.tab_id && event.payload.tab_id !== tab.id) return
        if (event.payload.durable && event.payload.revision !== undefined) acknowledgeSumiProjection(tab,event.payload.revision,event.payload.projection_identity)
        if (event.payload.notice) void import('../lib/dialogs').then(({ showError }) => showError(event.payload.notice!))
        if (event.payload.error) saveError = event.payload.error
        else if (event.payload.durable && event.payload.projected === true) saveError = ''
        schedule()
      })
      if (disposed) stateStop(); else stops.push(stateStop)
      const actionStop = await listen<{ page_id: string; tab_id?: string; action: string }>('sumi-action', event => {
        if (event.payload.page_id !== owner?.pageId || event.payload.tab_id && event.payload.tab_id !== tab.id) return
        void focusNavigation(event.payload.action)
      })
      if (disposed) actionStop(); else stops.push(actionStop)
      if (disposed) return
      await acceptSumiSnapshot(tab, owner)
      await updateScale()
      if (disposed) return
      binding = await mountSumiOwner(owner, boundsForNative(element, scale), () => !disposed && element.isConnected)
      if (!binding || disposed) return
      status = 'ready'
      await geometry()
      if (visible) await updateSumiSurface(owner, binding, 'sumi_focus')
    }
    reopen = async () => {
      stops.splice(0).forEach(stop => stop())
      await closeSumiOwner(tab.id)
      owner = undefined; binding = undefined; visible = undefined; previousBounds = ''
      status = 'loading'; failure = ''; saveError = ''
      try { await initialize() } catch (error) { failed(error) }
    }
    void initialize().catch(failed)
    return () => {
      disposed = true
      cancelAnimationFrame(frame)
      resize.disconnect(); mutations.disconnect()
      window.removeEventListener('resize', resized)
      window.removeEventListener('scroll', schedule, true)
      document.removeEventListener('visibilitychange', schedule)
      stops.forEach(stop => stop())
      if (owner) void detachSumiSurface(owner, binding).catch(error => {
        // The registry keeps the failed owner; subsequent close/switch remains gated.
        console.error('[Sumi] native detach failed:', error)
      })
    }
  })
</script>

<div class="native-file-view" aria-busy={status === 'loading'}>
  {#if saveError}<div class="native-save-error" role="status">保存未完成，当前草稿已保留：{saveError}
    <SumiRecovery path={tab.filePath} pluginId={view.pluginId} tabId={tab.id} pageId={owner?.pageId} onrestored={reopen} />
  </div>{/if}
  <div class="native-editor-region" bind:this={element}>
  {#if status === 'loading'}
    <div class="native-status" role="status">正在打开 Sumi…</div>
  {:else if status === 'error'}
    <div class="native-status" role="alert">
      <span>Sumi 暂时无法打开：{failure}</span>
      <button onclick={() => { void setMode(tab.id, 'source') }}>查看 Markdown 源码</button>
      <SumiRecovery path={tab.filePath} pluginId={view.pluginId} tabId={tab.id} pageId={owner?.pageId} onrestored={reopen} />
    </div>
  {/if}
  </div>
</div>

<style>
  .native-file-view { display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0; }
  .native-editor-region { flex: 1; min-width: 0; min-height: 0; position: relative; }
  .native-save-error { padding: 8px 16px; color: var(--text-primary); background: var(--bg-secondary); font-size: 12px; }
  .native-status { display: flex; gap: 12px; align-items: center; justify-content: center; height: 100%; padding: 24px; color: var(--text-muted, GrayText); font-size: 13px; }
</style>
