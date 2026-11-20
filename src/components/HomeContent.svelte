<script lang="ts">
  import { openFile } from '../lib/tabs.svelte'
  import { homeContentStore, dismissHomeContent, refreshHomeContent } from '../lib/home-content/store.svelte'
  import { openSettings } from '../lib/ui-state.svelte'
  import { t, i18n } from '../lib/i18n/store.svelte'

  let actionError = $state<string | null>(null)
  let pending = $state(false)
  const COLLAPSED_ROWS = 4
  const PAGE_SIZE = 10
  let expanded = $state({ new: false, continue: false })
  let expandedRows = $state({ new: PAGE_SIZE * 2, continue: PAGE_SIZE * 2 })
  const sections = $derived([
    { kind: 'new' as const, title: t('homeContent.new'), empty: t('homeContent.emptyNew'), items: homeContentStore.newItems },
    { kind: 'continue' as const, title: t('homeContent.continue'), empty: t('homeContent.emptyContinue'), items: homeContentStore.continueItems },
  ])

  function dateLabel(at: number): string {
    if (!Number.isFinite(at) || at <= 0 || !Number.isFinite(new Date(at).getTime())) return ''
    return new Intl.DateTimeFormat(i18n.locale === 'zh' ? 'zh-CN' : i18n.locale, { month: 'short', day: 'numeric' }).format(at)
  }

  async function action(run: () => Promise<unknown>): Promise<void> {
    if (pending) return
    actionError = null
    pending = true
    try { await run() } catch (error) { actionError = String(error) } finally { pending = false }
  }
</script>

<section class="home-content" aria-label={t('homeContent.label')} aria-busy={homeContentStore.busy}>
  {#if homeContentStore.error || actionError}
    <div class="content-error" role="alert">
      <span>{t('homeContent.error', { error: actionError ?? homeContentStore.error ?? '' })}</span>
      {#if homeContentStore.error}<button class="home-control" disabled={pending || homeContentStore.busy} onclick={() => void action(refreshHomeContent)}>{t('homeContent.retry')}</button>{/if}
    </div>
  {/if}
  {#if homeContentStore.skipped > 0}<p class="content-partial" role="status">{t('homeContent.partial', { count: homeContentStore.skipped })}</p>{/if}
  <div class="content-columns">
    {#each sections as section (section.kind)}
      {@const isExpanded = expanded[section.kind]}
      {@const visibleRows = isExpanded ? expandedRows[section.kind] : COLLAPSED_ROWS}
      <section aria-labelledby={`home-content-${section.kind}`}>
        <div class="content-heading">
          <h2 id={`home-content-${section.kind}`}>{section.title}</h2>
          <span class="content-actions">
            {#if section.kind === 'new'}
              <button class="content-more content-rules" onclick={() => openSettings('search')}>{t('homeContent.rules')}</button>
            {/if}
            {#if section.items.length > COLLAPSED_ROWS}
              <button class="content-more" aria-controls={`home-content-list-${section.kind}`} aria-expanded={isExpanded}
                onclick={() => { expanded[section.kind] = !isExpanded }}>{isExpanded ? t('homeContent.less') : t('homeContent.more')}</button>
            {/if}
          </span>
        </div>
        {#if section.items.length}
          <ul id={`home-content-list-${section.kind}`}>
            {#each section.items.slice(0, visibleRows) as item (item.path)}
              <li data-content-kind={section.kind}>
                <button class="content-open" disabled={pending} title={item.path} onclick={() => void action(() => openFile(item.path))}>
                  <span class="content-topline"><span class="content-title">{item.title}</span><span class="content-date">{dateLabel(item.at)}</span></span>
                  <span class="content-preview" class:fallback={!item.preview?.trim()}>{item.preview?.trim() || (item.detail && item.detail !== '.' ? item.detail : item.path)}</span>
                </button>
                <button class="content-dismiss" disabled={pending || homeContentStore.busy} aria-label={t('homeContent.dismiss', { title: item.title })} title={t('homeContent.dismiss', { title: item.title })} onclick={() => void action(() => dismissHomeContent(section.kind, item.path))}>×</button>
              </li>
            {/each}
          </ul>
          {#if isExpanded && section.items.length > visibleRows}
            <button class="home-control content-load-more" aria-controls={`home-content-list-${section.kind}`} onclick={() => { expandedRows[section.kind] += PAGE_SIZE }}>
              {t('homeContent.loadMore')}
            </button>
          {/if}
        {:else if !homeContentStore.ready && homeContentStore.busy}
          <p class="content-empty" role="status">{t('homeContent.loading')}</p>
        {:else if homeContentStore.ready}
          <p class="content-empty">{section.empty}</p>
        {/if}
      </section>
    {/each}
  </div>
</section>

<style>
  .home-content { margin-bottom:32px; }
  .content-columns { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:24px; }
  section { min-width:0; }
  .content-heading { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:12px; }
  h2 { margin:0; font-size:14px; font-weight:600; }
  ul { display:flex; flex-direction:column; gap:8px; list-style:none; margin:0; padding:0; }
  li { display:flex; align-items:center; gap:2px; border:1px solid color-mix(in srgb,CanvasText 7%,transparent); border-radius:10px; background:color-mix(in srgb,CanvasText 3%,transparent); }
  button { font:inherit; color:inherit; }
  .content-open { flex:1; display:flex; flex-direction:column; gap:6px; min-width:0; border:0; padding:10px 12px; border-radius:9px; background:none; text-align:left; cursor:pointer; }
  .content-topline { display:flex; align-items:baseline; gap:10px; width:100%; min-width:0; }
  .content-title { display:block; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:13px; line-height:1.5; }
  .content-preview { display:-webkit-box; -webkit-line-clamp:2; line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; min-height:3.1em; width:100%; color:GrayText; font-size:12px; line-height:1.55; overflow-wrap:anywhere; }
  .content-date { flex:none; color:GrayText; font-size:11px; line-height:1.5; }
  .content-more { flex:none; padding:3px 0; border:0; border-radius:4px; background:none; color:GrayText; font-size:12px; cursor:pointer; }
  .content-dismiss { flex:none; display:grid; place-items:center; width:28px; height:28px; margin-right:6px; padding:0; border:0; border-radius:4px; background:none; color:GrayText; font-size:18px; cursor:pointer; }
  .content-open:hover, .content-dismiss:hover, .content-more:hover { background:color-mix(in srgb,CanvasText 6%,transparent); }
  button:focus-visible { outline:2px solid var(--ui-accent,Highlight); outline-offset:2px; }
  button:disabled { cursor:default; opacity:.6; }
  .content-load-more { display:block; margin:12px auto 0; }
  .content-actions { display:flex; align-items:center; gap:12px; }
  .content-partial { margin:0 0 12px; color:GrayText; font-size:12px; line-height:1.6; }
  .content-empty { margin:0; padding:10px 6px; color:GrayText; font-size:12px; line-height:1.7; }
  .content-error { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:16px; font-size:12px; line-height:1.6; color:var(--ui-danger,#b3261e); overflow-wrap:anywhere; }
  .content-error .home-control { flex:none; }
  @container(max-width:580px) { .content-columns { grid-template-columns:minmax(0,1fr); } }
  @media(forced-colors:active) { li { border-color:GrayText; } .content-dismiss { border:1px solid ButtonText; } }
</style>
