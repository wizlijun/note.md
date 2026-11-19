<script module lang="ts">
  // One in-memory snapshot survives welcome-page unmounts; never persists to disk.
  let cached: { key: string; stats: import('../lib/vault-stats').VaultStats } | null = null
</script>

<script lang="ts">
  import { onMount } from 'svelte'
  import { invoke } from '@tauri-apps/api/core'
  import { watchImmediate } from '@tauri-apps/plugin-fs'
  import { writeText } from '@tauri-apps/plugin-clipboard-manager'
  import { revealItemInDir } from '@tauri-apps/plugin-opener'
  import { sotvaultStore } from '../lib/sotvault.svelte'
  import { pluginRuntime } from '../lib/plugins/runtime.svelte'
  import { t, i18n } from '../lib/i18n/store.svelte'
  import { vaultManagement, refreshVaultManagement, openVaultManagement, abbreviateHome } from '../lib/vault-management.svelte'
  import { vaultDocumentRules, formatContentBytes, type VaultStats } from '../lib/vault-stats'
  let { compact = false }: { compact?: boolean } = $props()

  let stats = $state<VaultStats | null>(null)
  let busy = $state(false)
  let error = $state<string | null>(null)
  let actionError = $state<string | null>(null)
  let copied = $state(false)
  let expanded = $state(false)
  let refresh = () => {}
  const root = $derived(sotvaultStore.vaultRoot)
  const rules = $derived(vaultDocumentRules(pluginRuntime.manifests))
  const pathLabel = $derived(root ? abbreviateHome(root, vaultManagement.info?.homeDir ?? null) : '')
  const name = $derived(root?.split(/[\\/]/).filter(Boolean).at(-1) ?? '')

  onMount(() => { void refreshVaultManagement().catch((e) => { error = String(e) }) })

  $effect(() => {
    const currentRoot = root
    const currentRules = rules
    const cacheKey = JSON.stringify([currentRoot, currentRules])
    stats = cached?.key === cacheKey ? cached.stats : null
    error = null
    copied = false
    if (!currentRoot) { busy = false; refresh = () => {}; return }
    let disposed = false
    let running = false
    let queued = false
    let requestId: string | null = null
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopWatch: (() => void) | undefined
    const load = async () => {
      if (disposed || document.visibilityState === 'hidden') return
      if (running) { queued = true; return }
      running = true
      cancelled = false
      busy = true
      error = null
      requestId = crypto.randomUUID()
      try {
        const result = await invoke<VaultStats>('notemd_vault_stats', { expectedRoot: currentRoot, requestId, rules: currentRules })
        if (!disposed && !cancelled && result.root === currentRoot) { stats = result; cached = { key: cacheKey, stats: result } }
      } catch (e) {
        if (!disposed && !cancelled) error = String(e)
      } finally {
        running = false
        requestId = null
        if (!disposed) {
          busy = false
          if (queued) { queued = false; schedule() }
        }
      }
    }
    const schedule = () => {
      if (disposed) return
      clearTimeout(timer)
      timer = setTimeout(() => { void load() }, 1000)
    }
    refresh = () => { void load() }
    const onVisible = () => {
      if (document.visibilityState === 'visible') { void load(); return }
      clearTimeout(timer)
      queued = false
      cancelled = true
      if (requestId) void invoke('notemd_vault_stats_cancel', { requestId }).catch(() => {})
    }
    document.addEventListener('visibilitychange', onVisible)
    void load()
    void watchImmediate(currentRoot, (event) => {
      if (typeof event.type === 'object' && 'access' in event.type) return
      if (event.paths.length && event.paths.every((path) => {
        const relative = path.startsWith(currentRoot) ? path.slice(currentRoot.length) : path
        return relative.split(/[\\/]/).some((part) => ['.git', '.notemd', '.DS_Store', 'Thumbs.db'].includes(part))
      })) return
      schedule()
    }, { recursive: true }).then((stop) => {
      if (disposed) stop()
      else stopWatch = stop
    }).catch(() => { /* A manual refresh remains available when watching is unavailable. */ })
    return () => {
      disposed = true
      clearTimeout(timer)
      stopWatch?.()
      document.removeEventListener('visibilitychange', onVisible)
      if (requestId) void invoke('notemd_vault_stats_cancel', { requestId }).catch(() => {})
    }
  })

  async function action(run: () => Promise<unknown>) {
    actionError = null
    try { await run() } catch (e) { actionError = String(e) }
  }
</script>

<!-- Interactive content must not reach EmptyState's background double-click action. -->
<section class="vault-overview" class:compact class:configured={Boolean(root)} aria-label={t('vaultOverview.title')} ondblclick={(event) => event.stopPropagation()}>
  <div class="heading">
    <h2>{root ? t('vaultOverview.title') : t('vaultOverview.unconfigured')}</h2>
    {#if root}<button aria-expanded={expanded} onclick={() => { expanded = !expanded }}>{t(expanded ? 'vaultOverview.hideDetails' : 'vaultOverview.showDetails')}</button>{/if}
  </div>
  {#if root}
    <strong class="vault-name" title={name}>{name}</strong>
    {#if expanded}<div class="path-row">
      <span class="path" title={root}>{pathLabel}</span>
      <button aria-label={t('vaultOverview.copyPath')} onclick={() => void action(async () => { await writeText(root); copied = true })}>{copied ? t('vaultOverview.copied') : t('vaultOverview.copy')}</button>
      <button onclick={() => void action(() => revealItemInDir(root))}>{t('vaultOverview.reveal')}</button>
    </div>{/if}
    <div class="statistics" aria-live="polite" aria-busy={busy}>
      {#if stats}
        {#if stats.skipped > 0}<span class="partial">{t('vaultOverview.partial', { n: stats.skipped })}</span>{/if}
        <div class="metrics">
          <span><strong>{stats.documents.toLocaleString(i18n.locale)}</strong> {t('vaultOverview.documents')}</span>
          <span title={t('vaultOverview.sizeHint')}><strong>{formatContentBytes(stats.bytes)}</strong> {t('vaultOverview.contentSize')}</span>
        </div>
      {:else if busy}
        <p>{t('vaultOverview.counting')}</p>
      {/if}
      {#if stats && busy}<p role="status">{t('vaultOverview.counting')}</p>{/if}
      {#if error}<p class="error" role="alert">{t('vaultOverview.unavailable')}<br />{error}</p>{/if}
      {#if expanded}<div class="footer">
        <span>{#if stats?.completedAt}{t(error ? 'vaultOverview.lastCounted' : 'vaultOverview.countedAt', { time: new Date(stats.completedAt).toLocaleTimeString(i18n.locale, { hour: '2-digit', minute: '2-digit' }) })}{/if}</span>
        <button disabled={busy} onclick={() => refresh()}>{busy ? t('vaultOverview.counting') : t('vaultOverview.refresh')}</button>
      </div>
      <button onclick={() => void action(openVaultManagement)}>{t('vaultOverview.settings')}</button>{/if}
    </div>
  {:else}
    <p>{t('vaultOverview.hint')}</p>
    <button class="primary" onclick={() => void action(openVaultManagement)}>{t('vaultOverview.setup')}</button>
  {/if}
  {#if actionError}<p class="error" role="alert">{actionError}</p>{/if}
</section>

<style>
  .vault-overview { margin-top: 32px; padding: 18px; border: 1px solid color-mix(in srgb, CanvasText 15%, transparent); border-radius: 10px; color: CanvasText; }
  .heading, .path-row, .footer, .metrics { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; min-width: 0; }
  .heading, .footer { justify-content: space-between; }
  h2 { font-size: 13px; font-weight: 500; margin: 0; color: GrayText; }
  .vault-name { display: block; font-size: 18px; margin: 14px 0 8px; overflow-wrap: anywhere; }
  .path { flex: 1 1 240px; min-width: 0; overflow-wrap: anywhere; font-size: 12px; user-select: text; }
  .metrics { gap: 12px 24px; margin: 18px 0 12px; font-size: 12px; color: GrayText; }
  .metrics strong { color: CanvasText; font-size: 18px; font-weight: 550; }
  p, .footer, .partial { font-size: 12px; color: GrayText; }
  .error { color: var(--ui-danger, #b3261e); overflow-wrap: anywhere; }
  button { font: inherit; font-size: 12px; padding: 5px 9px; border-radius: 5px; border: 1px solid color-mix(in srgb, CanvasText 20%, transparent); background: Canvas; color: CanvasText; cursor: pointer; }
  button:hover { background: color-mix(in srgb, CanvasText 8%, Canvas); }
  button:disabled { opacity: .5; cursor: default; }
  .primary { background: var(--ui-accent); color: var(--ui-accent-foreground, white); border-color: var(--ui-accent); }
  .compact { margin:0; padding:0; border:0; border-radius:0; min-width:0; }
  .compact.configured { display:grid; grid-template-columns:auto minmax(0,1fr) auto; align-items:start; gap:6px 12px; }
  .compact.configured .heading { grid-column:3; grid-row:1; }
  .compact.configured .heading h2 { display:none; }
  .compact .vault-name { grid-column:1; grid-row:1; margin:4px 0; min-width:0; max-width:180px; font-size:13px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .compact .statistics { grid-column:2; grid-row:1; min-width:0; }
  .compact .metrics { gap:4px 12px; margin:4px 0; font-size:11px; }
  .compact .metrics strong { font-size:12px; font-weight:500; }
  .compact .path-row { grid-column:1/-1; grid-row:2; }
  .compact p { margin:4px 0; }
  .compact .error { grid-column:1/-1; }
  .compact button { padding:4px 7px; font-size:11px; }
  @container(max-width:660px) {
    .compact.configured { grid-template-columns:minmax(0,1fr) auto; }
    .compact.configured .heading { grid-column:2; }
    .compact .statistics { grid-column:1/-1; grid-row:2; }
    .compact .path-row { grid-row:3; }
  }
</style>
