<script lang="ts">
  import { onMount, tick } from 'svelte'
  import { invoke } from '@tauri-apps/api/core'
  import { listen } from '@tauri-apps/api/event'
  import AppIcon from './AppIcon.svelte'
  import AppDirectory from './AppDirectory.svelte'
  import '../styles/home-apps.css'
  import { buildHomeApps, type HomeApp } from '../lib/home-apps/catalog'
  import { shortcutSlots } from '../lib/home-apps/model'
  import { homeAppsStore, loadHomeApps, reconcileHomeApps, refreshHomeAppRanking, pinHomeApp, unpinHomeApp, moveHomeApp, recordHomeAppUse } from '../lib/home-apps/store.svelte'
  import { dispatchPluginCommand, pluginRuntime, refreshPluginManifests } from '../lib/plugins/runtime.svelte'
  import { pluginCommandEnabled } from '../lib/plugins/app-launch'
  import { getPluginScopedAll, pluginScopedVersion } from '../lib/settings.svelte'
  import { sotvaultStore } from '../lib/sotvault.svelte'
  import { openSettings } from '../lib/ui-state.svelte'
  import { t, i18n } from '../lib/i18n/store.svelte'
  import type { InstalledV2 } from '../lib/market/types'

  let installed = $state<InstalledV2[]>([])
  let loading = $state(true)
  let complete = $state(false)
  let awaitingDispatcher = $state(false)
  let catalogError = $state<string | null>(null)
  let actionError = $state<string | null>(null)
  let editing = $state(false)
  let directory = $state(false)
  let selectedId = $state<string | null>(null)
  let chooseTarget = $state(false)
  let moveSource = $state<number | undefined>()
  let menu = $state<{ id: string; slot: number; x: number; y: number } | null>(null)
  let menuElement = $state<HTMLDivElement>()
  let dragged: { id: string; slot: number } | null = null
  let returnFocus: HTMLElement | null = null
  let disposed = false
  let generation = 0
  let reload = $state<() => void>(() => {})
  const apps = $derived(buildHomeApps(installed, pluginRuntime.manifests, i18n.locale))
  const byId = $derived(new Map(apps.map(app => [app.id, app])))
  const eligible = $derived.by(() => {
    void pluginScopedVersion.value
    return apps.filter(app => !reason(app)).map(app => app.id)
  })
  const slots = $derived(shortcutSlots(homeAppsStore.data, eligible))
  function lookup(id: string): HomeApp { return byId.get(id) ?? { id, name: id, description: '', category: 'experience', enabled: true, available: false, entry: { kind: 'details' } } }
  const visibleSlots = $derived(editing ? slots : slots.slice(0, slots.reduce((last, id, index) => id !== null ? index + 1 : last, 0)))
  const selected = $derived(selectedId ? lookup(selectedId) : null)
  const error = $derived(homeAppsStore.error ? t('homeApps.storageError', { error: homeAppsStore.error }) : catalogError ?? actionError)

  function reason(app: HomeApp, command: string | null = app.entry.kind === 'command' ? app.entry.command : null): string | null {
    void pluginScopedVersion.value
    if (!app.enabled) return t('homeApps.disabled')
    if (!app.available || !app.manifest) return t('homeApps.unavailable')
    if (!pluginRuntime.ready) return t('homeApps.starting')
    if (!pluginCommandEnabled(app.manifest, command, { currentTab: null, settings: getPluginScopedAll(app.id), vaultConfigured: Boolean(sotvaultStore.vaultRoot) })) return t('homeApps.contextUnavailable')
    return null
  }
  async function run(action: () => Promise<unknown>): Promise<boolean> {
    actionError = null
    try { await action(); return true } catch (e) { if (!homeAppsStore.error) actionError = String(e); return false }
  }
  function details(app: HomeApp) {
    moveSource = undefined
    selectedId = app.id
    if (!reason(app, null)) void run(() => recordHomeAppUse(app.id))
  }
  function showDirectory(app?: HomeApp, target = false, source?: number) {
    if (!menu) returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    chooseTarget = target; moveSource = source; menu = null; selectedId = app?.id ?? null; directory = true
    if (app && !target) details(app)
  }
  async function closeDirectory() { directory = false; selectedId = null; await tick(); returnFocus?.focus() }
  async function open(app: HomeApp) {
    if (reason(app) || app.entry.kind === 'details') { if (directory) details(app); else showDirectory(app); return }
    const accepted = await run(() => dispatchPluginCommand(app.id, app.entry.kind === 'command' ? app.entry.command : ''))
    if (accepted && directory) await closeDirectory()
  }
  async function place(app: HomeApp, slot: number) {
    return run(() => homeAppsStore.data.pins.includes(app.id) || moveSource !== undefined
      ? moveHomeApp(app.id, slot, moveSource)
      : pinHomeApp(app.id, slot))
  }
  function manage() { void closeDirectory(); market() }
  function configure(app: HomeApp) { if (app.manifest?.settings) { void closeDirectory(); openSettings(app.id) } }
  async function openCommand(app: HomeApp, command: string) {
    const declared = Boolean(app.manifest?.open_windows?.[command]) || app.manifest?.file_views?.some(view => view.open_command === command)
    if (!declared || reason(app, command)) return
    if (await run(() => dispatchPluginCommand(app.id, command))) await closeDirectory()
  }
  function market() { void run(() => invoke('open_plugin_market_window')) }
  function context(event: MouseEvent, app: HomeApp, slot: number) {
    event.preventDefault(); returnFocus = event.currentTarget as HTMLElement
    menu = { id: app.id, slot, x: Math.max(8, Math.min(event.clientX, window.innerWidth - 200)), y: Math.max(8, Math.min(event.clientY, window.innerHeight - 160)) }
    void tick().then(() => menuElement?.querySelector<HTMLButtonElement>('button')?.focus())
  }
  function menuKeys(event: KeyboardEvent) {
    if (event.key === 'Escape') { menu = null; returnFocus?.focus(); event.preventDefault(); return }
    const buttons = [...(menuElement?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault(); const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
      buttons[index]?.focus()
    }
  }
  $effect(() => {
    if (awaitingDispatcher && pluginRuntime.ready) { awaitingDispatcher = false; reload() }
  })
  onMount(() => {
    let stop: (() => void) | undefined
    let ranked = false
    async function load() {
      const request = ++generation
      loading = true; catalogError = null
      // Both reads must succeed. An empty runtime during App hydration is not a catalog.
      try {
        const [items] = await Promise.all([invoke<InstalledV2[]>('plugin_market_installed'), refreshPluginManifests(), loadHomeApps()])
        if (disposed || request !== generation) return
        installed = items; complete = true
        await reconcileHomeApps(items.map(item => item.id))
        if (disposed || request !== generation) return
        if (!pluginRuntime.ready) { awaitingDispatcher = true; return }
        awaitingDispatcher = false
        // The dispatcher is registered and a fresh runtime read has completed.
        const ids = buildHomeApps(items, pluginRuntime.manifests, i18n.locale).filter(app => app.enabled && app.available && app.manifest && pluginCommandEnabled(app.manifest, app.entry.kind === 'command' ? app.entry.command : null, { currentTab: null, settings: getPluginScopedAll(app.id), vaultConfigured: Boolean(sotvaultStore.vaultRoot) })).map(app => app.id)
        if (!ranked) { await refreshHomeAppRanking(ids); ranked = true }
      } catch (e) { if (!disposed && request === generation && !homeAppsStore.error) catalogError = String(e) }
      finally { if (!disposed && request === generation) loading = false }
    }
    reload = () => { void load() }
    void load()
    void listen('plugins-changed', () => { void load() }).then(unlisten => { if (disposed) unlisten(); else stop = unlisten }).catch(e => { if (!disposed) catalogError = String(e) })
    return () => { disposed = true; generation++; stop?.() }
  })
</script>

<svelte:window onpointerdown={event => { if (menu && !(event.target instanceof Element && event.target.closest('.home-context-menu'))) menu = null }} />
<section class="home-apps" aria-label={t('homeApps.apps')} ondblclick={event => event.stopPropagation()}>
  <div class="home-section-heading">
    <h2>{t('homeApps.apps')}</h2>
    <div class="home-controls"><button class="home-control" aria-pressed={editing} onclick={() => { editing = !editing }}>{t(editing ? 'homeApps.done' : 'homeApps.edit')}</button><button class="home-control apps-directory-button" onclick={() => showDirectory()}>{t('homeApps.allApps')}</button></div>
  </div>
  {#if loading || awaitingDispatcher}<p class="home-status" role="status">{t(awaitingDispatcher ? 'homeApps.starting' : 'homeApps.loading')}</p>{/if}
  <div class="home-grid" aria-label={t('homeApps.shortcuts')}>
    {#each visibleSlots as id, slot}
      {@const app = id ? lookup(id) : undefined}
      <div class="shortcut-slot" data-home-slot={slot} class:pinned={homeAppsStore.data.pins[slot] !== null} draggable={editing && Boolean(app)} ondragstart={event => { if (app) { dragged = { id: app.id, slot }; event.dataTransfer?.setData('text/plain', app.id) } }} ondragend={() => { dragged = null }} ondragover={event => { if (editing && dragged) event.preventDefault() }} ondrop={event => { event.preventDefault(); if (editing && dragged) void run(() => moveHomeApp(dragged!.id, slot, dragged!.slot)); dragged = null }} role="group" aria-label={t('homeApps.position', { n: slot + 1 })}>
        {#if app}
          <button class="home-tile" aria-disabled={Boolean(reason(app))} title={`${app.name}${reason(app) ? ` · ${reason(app)}` : ''}`} oncontextmenu={event => context(event, app, slot)} onclick={() => { if (editing) showDirectory(app, true, slot); else void open(app) }}>
            <AppIcon id={app.id}/><span class="tile-label">{app.compactName ?? app.name}</span>
          </button>
          {#if editing}<div class="slot-controls"><button class="home-control" data-move onclick={() => showDirectory(app, true, slot)}>{t('homeApps.move')}</button>{#if homeAppsStore.data.pins[slot]}<button class="home-control" aria-label={`${t('homeApps.unpin')} ${app.name}`} onclick={() => void run(() => unpinHomeApp(app.id))}>−</button>{/if}</div>{:else if homeAppsStore.data.pins[slot]}<span class="pin-mark" role="img" aria-label={t('homeApps.pinned')}><svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 2 8 8-3 1-3 3-1-4-4-1 3-3z M7 10l-5 5"/></svg></span>{/if}
        {:else}<button class="home-tile vacant" aria-label={t('homeApps.addAt', { n: slot + 1 })} onclick={() => showDirectory()}><span class="empty-icon" aria-hidden="true">+</span><span class="tile-label">{t('homeApps.add')}</span></button>{/if}
      </div>
    {/each}
  </div>
  {#if complete && apps.length && !visibleSlots.length && !loading && !awaitingDispatcher}<p class="home-status">{t('homeApps.noShortcuts')}</p>{/if}
  {#if complete && !apps.length}<p class="home-status">{t('homeApps.empty')}</p>{/if}
  {#if error && !directory}<p class="home-error" role="alert">{error}</p><button class="home-control" onclick={() => { actionError = null; reload() }}>{t('homeApps.retry')}</button>{/if}
  {#if menu && byId.has(menu.id)}
    {@const app = byId.get(menu.id)!}
    <div class="home-context-menu menu-panel" role="menu" aria-label={app.name} bind:this={menuElement} style:left={`${menu.x}px`} style:top={`${menu.y}px`} tabindex="-1" onkeydown={menuKeys}>
      <button class="menu-row" role="menuitem" onclick={() => showDirectory(app)}>{t('homeApps.details')}</button>
      <button class="menu-row" role="menuitem" onclick={() => showDirectory(app, true, menu!.slot)}>{t(homeAppsStore.data.pins.includes(app.id) ? 'homeApps.move' : 'homeApps.pin')}</button>
      {#if homeAppsStore.data.pins.includes(app.id)}<button class="menu-row" role="menuitem" onclick={() => { menu = null; void run(() => unpinHomeApp(app.id)) }}>{t('homeApps.unpin')}</button>{/if}
    </div>
  {/if}
  {#if directory}<AppDirectory {apps} loading={loading || awaitingDispatcher} catalogReady={complete} pins={homeAppsStore.data.pins} {selected} {chooseTarget} moving={moveSource !== undefined} busy={homeAppsStore.busy} {error} {reason} onclose={() => { void closeDirectory() }} ondetail={details} onopen={app => { void open(app) }} onplace={place} onunpin={app => run(() => unpinHomeApp(app.id))} onmanage={manage} onmarket={market} onretry={catalogError || !homeAppsStore.ready ? reload : undefined} onconfigure={configure} commandEnabled={(app, command) => !reason(app, command)} oncommand={(app, command) => { void openCommand(app, command) }}/>{/if}
</section>
<style>
  .home-apps { border-top:1px solid color-mix(in srgb,CanvasText 12%,transparent); padding-top:24px; margin-top:32px; color:CanvasText; }
  .shortcut-slot { position:relative; min-width:0; display:flex; align-items:center; flex-direction:column; }
  .shortcut-slot[draggable=true] { cursor:grab; }
  .empty-icon { display:grid; place-items:center; box-sizing:border-box; width:56px; height:56px; border:1px dashed color-mix(in srgb,CanvasText 28%,transparent); border-radius:14px; color:GrayText; font-size:24px; }
  .vacant { color:GrayText; }
  .pin-mark { position:absolute; display:grid; place-items:center; right:calc(50% - 34px); top:-5px; width:18px; height:18px; border-radius:50%; background:Canvas; color:CanvasText; }
  .slot-controls { display:flex; flex-wrap:wrap; justify-content:center; gap:4px; margin-top:8px; }
  .home-context-menu { position:fixed; z-index:450; min-width:180px; }
  .menu-row { width:100%; border:0; background:none; text-align:start; font:inherit; cursor:pointer; }
</style>
