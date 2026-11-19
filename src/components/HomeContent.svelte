<script lang="ts">
  import { openFile } from '../lib/tabs.svelte'
  import { homeContentStore, dismissHomeContent, refreshHomeContent } from '../lib/home-content/store.svelte'
  import { t, i18n } from '../lib/i18n/store.svelte'

  let actionError = $state<string | null>(null)
  let pending = $state(false)
  let expanded = $state({ new: false, continue: false })
  const COLLAPSED_ROWS = 5
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
      <section aria-labelledby={`home-content-${section.kind}`}>
        <h2 id={`home-content-${section.kind}`}>{section.title}</h2>
        {#if section.items.length}
          <ul id={`home-content-list-${section.kind}`}>
            {#each (expanded[section.kind] ? section.items : section.items.slice(0, COLLAPSED_ROWS)) as item (item.path)}
              <li data-content-kind={section.kind}>
                <button class="content-open" disabled={pending} title={item.path} onclick={() => void action(() => openFile(item.path))}>
                  <span class="content-title">{item.title}</span>
                  <span class="content-date">{dateLabel(item.at)}</span>
                </button>
                <button class="content-dismiss" disabled={pending || homeContentStore.busy} aria-label={t('homeContent.dismiss', { title: item.title })} title={t('homeContent.dismiss', { title: item.title })} onclick={() => void action(() => dismissHomeContent(section.kind, item.path))}>×</button>
              </li>
            {/each}
          </ul>
          {#if section.items.length > COLLAPSED_ROWS}
            <button class="content-more" aria-expanded={expanded[section.kind]} aria-controls={`home-content-list-${section.kind}`} onclick={() => { expanded[section.kind] = !expanded[section.kind] }}>{t(expanded[section.kind] ? 'homeContent.less' : 'homeContent.more')}</button>
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
  h2 { margin:0 0 8px; font-size:14px; font-weight:600; }
  ul { list-style:none; margin:0; padding:0; }
  li { display:flex; align-items:center; gap:4px; border-bottom:1px solid color-mix(in srgb,CanvasText 12%,transparent); }
  button { font:inherit; color:inherit; }
  .content-open { flex:1; display:flex; align-items:center; gap:8px; min-width:0; border:0; padding:6px; border-radius:4px; background:none; text-align:left; cursor:pointer; }
  .content-title { display:block; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:13px; line-height:1.5; }
  .content-date { flex:none; color:GrayText; font-size:11px; line-height:1.5; }
  .content-more { margin-top:6px; padding:4px 6px; border:0; border-radius:4px; background:none; color:GrayText; font-size:12px; cursor:pointer; }
  .content-dismiss { flex:none; display:grid; place-items:center; width:28px; height:28px; padding:0; border:0; border-radius:4px; background:none; color:GrayText; font-size:18px; cursor:pointer; }
  .content-open:hover, .content-dismiss:hover, .content-more:hover { background:color-mix(in srgb,CanvasText 6%,transparent); }
  button:focus-visible { outline:2px solid var(--ui-accent,Highlight); outline-offset:2px; }
  button:disabled { cursor:default; opacity:.6; }
  .content-partial { margin:0 0 12px; color:GrayText; font-size:12px; line-height:1.6; }
  .content-empty { margin:0; padding:10px 6px; color:GrayText; font-size:12px; line-height:1.7; }
  .content-error { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:16px; font-size:12px; line-height:1.6; color:var(--ui-danger,#b3261e); overflow-wrap:anywhere; }
  .content-error .home-control { flex:none; }
  @container(max-width:580px) { .content-columns { grid-template-columns:minmax(0,1fr); } }
  @media(forced-colors:active) { li { border-color:GrayText; } .content-dismiss { border:1px solid ButtonText; } }
</style>
