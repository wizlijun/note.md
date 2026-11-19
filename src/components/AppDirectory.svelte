<script lang="ts">
  import { onMount, tick } from 'svelte'
  import AppIcon from './AppIcon.svelte'
  import type { HomeApp } from '../lib/home-apps/catalog'
  import { PLUGIN_CATEGORY_ORDER, pluginCategoryLabelKey, type PluginCategory } from '../lib/plugins/categories'
  import { pluginMenuLabel } from '../lib/plugins/plugin-i18n'
  import { t } from '../lib/i18n/store.svelte'
  let { apps, pins, selected = null, chooseTarget = false, moving = false, busy = false, loading = false, catalogReady = false, error = null, reason, onclose, ondetail, onopen, onplace, onunpin, onmanage, onmarket, onconfigure, commandEnabled, oncommand, onretry }: {
    apps: HomeApp[]; pins: (string | null)[]; selected?: HomeApp | null; chooseTarget?: boolean; moving?: boolean; busy?: boolean; loading?: boolean; catalogReady?: boolean; error?: string | null
    reason: (app: HomeApp) => string | null; onclose: () => void; ondetail: (app: HomeApp) => void; onopen: (app: HomeApp) => void
    onplace: (app: HomeApp, slot: number) => Promise<boolean>; onunpin: (app: HomeApp) => Promise<boolean>; onmanage: () => void; onmarket: () => void; onconfigure: (app: HomeApp) => void; commandEnabled: (app: HomeApp, command: string) => boolean; oncommand: (app: HomeApp, command: string) => void; onretry?: () => void
  } = $props()
  let query = $state('')
  let category = $state<PluginCategory | null>(null)
  let choosing = $state(false)
  let saved = $state(false)
  let panel: HTMLDivElement
  const filtered = $derived(apps.filter(app => (!category || app.category === category) && `${app.name} ${app.id} ${app.description}`.toLocaleLowerCase().includes(query.toLocaleLowerCase().trim())))
  const pinned = $derived(selected ? pins.includes(selected.id) : false)
  const commands = $derived.by(() => {
    const manifest = selected?.manifest
    if (!manifest) return []
    const declared = new Map(Object.entries(manifest.open_windows ?? {}).filter(([command, window]) => command.trim() && window.trim()))
    for (const view of manifest.file_views ?? []) if (view.open_command?.trim() && !declared.has(view.open_command)) declared.set(view.open_command, view.id)
    return [...declared].map(([command, fallback]) => ({ command, label: pluginMenuLabel(manifest, command, manifest.menus?.find(menu => menu.command === command)?.label ?? fallback) }))
  })
  onMount(() => {
    choosing = chooseTarget
    if (selected) { if (chooseTarget) void focusPosition(); else void focusDetail() }
    else void tick().then(() => panel.querySelector<HTMLInputElement>('input')?.focus())
  })
  async function focusPosition() { await tick(); (panel.querySelector<HTMLElement>('[data-target-slot]:not(:disabled)') ?? panel.querySelector<HTMLElement>('h3'))?.focus() }
  async function focusDetail() { await tick(); panel.querySelector<HTMLElement>('h3')?.focus() }
  function keys(event: KeyboardEvent) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onclose() }
    if (event.key !== 'Tab') return
    const controls = [...panel.querySelectorAll<HTMLElement>('button:not(:disabled), input, [tabindex="0"]')]
    const first = controls[0], last = controls.at(-1)
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }
</script>
<div class="directory-backdrop" role="presentation" onclick={event => { if (event.target === event.currentTarget) onclose() }}>
  <div class="app-directory" bind:this={panel} role="dialog" aria-modal="true" aria-label={t('homeApps.directory')} tabindex="-1" onkeydown={keys}>
    <div class="home-section-heading"><h2>{t('homeApps.directory')}</h2><button class="home-control" onclick={onclose}>{t('homeApps.close')}</button></div>
    <input type="search" aria-label={t('homeApps.search')} placeholder={t('homeApps.search')} bind:value={query}/>
    <div class="categories" aria-label={t('homeApps.categories')}>
      <button class="home-control" aria-pressed={category === null} onclick={() => { category = null }}>{t('homeApps.all')}</button>
      {#each PLUGIN_CATEGORY_ORDER as key}<button class="home-control" aria-pressed={category === key} onclick={() => { category = key }}>{t(pluginCategoryLabelKey(key))}</button>{/each}
    </div>
    {#if loading}<p class="home-status" role="status">{t('homeApps.loading')}</p>{:else if catalogReady && !apps.length}<p class="home-status">{t('homeApps.empty')}</p>{:else if apps.length && !filtered.length}<p class="home-status">{t('homeApps.noResults')}</p>{/if}
    <div class="directory-list">
      {#each filtered as app (app.id)}
        <button class="directory-row" data-app-id={app.id} aria-pressed={selected?.id === app.id} onclick={() => { choosing = false; saved = false; ondetail(app); void tick().then(() => panel.querySelector<HTMLElement>('h3')?.focus()) }}>
          <AppIcon id={app.id}/><span><strong>{app.name}</strong><span class="description">{app.description}</span>{#if reason(app)}<span class="home-status">{reason(app)}</span>{/if}</span>
          <span class="details-label">{t('homeApps.details')}</span>
        </button>
      {/each}
    </div>
    {#if selected}
      <section class="app-detail" aria-label={t('homeApps.details')}>
        <h3 tabindex="-1">{selected.name}</h3><p>{selected.description}</p>
        {#if selected.id === 'notemd.md2pdf'}<p class="usage-guide">{t('homeApps.pdfGuide')}</p>{/if}
        {#if reason(selected)}<p class="home-status">{reason(selected)}</p>{/if}
        <div class="detail-controls">
          {#if selected.entry.kind === 'command'}<button class="home-control" disabled={Boolean(reason(selected)) || busy} onclick={() => onopen(selected!)}>{t('homeApps.open')}</button>{/if}
          <button class="home-control" disabled={busy} onclick={() => { choosing = !choosing; saved = false; if (choosing) void focusPosition() }}>{t(pinned ? 'homeApps.move' : 'homeApps.pin')}</button>
          {#if pinned}<button class="home-control" disabled={busy} onclick={async () => { saved = await onunpin(selected!); choosing = false; await focusDetail() }}>{t('homeApps.unpin')}</button>{/if}
          {#if selected.manifest?.settings}<button class="home-control" onclick={() => onconfigure(selected!)}>{t('homeApps.configure')}</button>{/if}
          <button class="home-control" onclick={onmanage}>{t('homeApps.manage')}</button>
        </div>
        {#if selected.entry.kind === 'details' && commands.length}<div class="declared-commands"><p class="home-status">{t('homeApps.chooseEntry')}</p><div class="detail-controls">{#each commands as entry}<button class="home-control" data-app-command={entry.command} disabled={busy || !commandEnabled(selected, entry.command)} onclick={() => oncommand(selected!, entry.command)}>{entry.label}</button>{/each}</div></div>{/if}
        {#if choosing}
          <p class="home-status">{t(pinned || moving ? 'homeApps.moveHint' : 'homeApps.choosePosition')}</p>
          {#if !pinned && !moving && pins.every(Boolean)}<p class="home-status">{t('homeApps.full')}</p>{/if}
          <div class="position-grid">
            {#each pins as id, slot}<button class="home-control" data-target-slot={slot} disabled={busy || (!pinned && !moving && id !== null)} aria-label={t('homeApps.position', { n: slot + 1 })} title={id ? apps.find(app => app.id === id)?.name ?? id : t('homeApps.vacant')} onclick={async () => { saved = await onplace(selected!, slot); if (saved) choosing = false; await focusDetail() }}>{slot + 1}{#if id}<span> · {apps.find(app => app.id === id)?.compactName ?? id}</span>{/if}</button>{/each}
          </div>
        {/if}
        {#if saved}<p class="home-status" role="status">{t('homeApps.saved')}</p>{/if}
      </section>
    {/if}
    {#if error}<p class="home-error" role="alert">{error}</p>{#if onretry}<button class="home-control" onclick={onretry}>{t('homeApps.retry')}</button>{/if}{/if}
    <div class="directory-footer"><button class="home-control" onclick={onmarket}>{t('homeApps.market')}</button><button class="home-control" onclick={onmanage}>{t('homeApps.manage')}</button></div>
  </div>
</div>
<style>
  .directory-backdrop { position:fixed; inset:0; z-index:400; display:grid; place-items:center; padding:24px; background:#0006; }
  .app-directory { box-sizing:border-box; width:680px; max-width:100%; max-height:85vh; overflow:auto; padding:24px; border:1px solid color-mix(in srgb,CanvasText 20%,transparent); border-radius:14px; background:Canvas; color:CanvasText; box-shadow:0 12px 40px #0003; }
  input { box-sizing:border-box; width:100%; padding:10px; font:inherit; border:1px solid GrayText; border-radius:6px; background:Canvas; color:CanvasText; }
  .categories { display:flex; flex-wrap:wrap; gap:8px; margin:16px 0; }
  [aria-pressed=true] { outline:1px solid var(--ui-accent,Highlight); outline-offset:1px; }
  .directory-list { display:flex; flex-direction:column; gap:8px; }
  .directory-row { width:100%; display:flex; align-items:center; gap:16px; text-align:start; border:1px solid color-mix(in srgb,CanvasText 12%,transparent); border-radius:8px; padding:12px; background:Canvas; color:CanvasText; font:inherit; cursor:pointer; }
  .directory-row > span { min-width:0; overflow-wrap:anywhere; }
  .directory-row strong { font-size:13px; font-weight:550; }
  .description, .directory-row .home-status { display:block; margin-top:4px; font-size:12px; }
  .description { color:GrayText; }
  .details-label { margin-left:auto; flex:none; font-size:12px; }
  .app-detail { margin-top:24px; padding-top:16px; border-top:1px solid color-mix(in srgb,CanvasText 15%,transparent); }
  h3 { font-size:15px; margin:0; overflow-wrap:anywhere; }
  .app-detail p { font-size:12px; overflow-wrap:anywhere; }
  .detail-controls, .directory-footer { display:flex; flex-wrap:wrap; gap:8px; }
  .position-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:8px; }
  .position-grid button { min-width:0; overflow-wrap:anywhere; }
  .directory-footer { margin-top:24px; }
  @media(max-width:480px) { .directory-backdrop { padding:12px; } .app-directory { padding:16px; } .details-label { display:none; } .position-grid { grid-template-columns:repeat(2,minmax(0,1fr)); } }
</style>
