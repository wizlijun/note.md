<script lang="ts">
  import '../../../src/styles/ui-foundation.css'
  import { onDestroy, onMount, tick } from 'svelte'
  import { editMarkdown, InvalidRulesError, loadRules, locale, onDocument, openLink, saveRules } from './lib/bridge'
  import { CATEGORIES, classifyItem, DEFAULT_RULES, type ClassificationRule } from './lib/classification'
  import type { TimelineDocument, TimelineItem } from './lib/parser'
  import { formatDuration, formatTime, layoutTimeline, PIXELS_PER_MINUTE } from './lib/layout'
  import ClassificationSettings from './lib/components/ClassificationSettings.svelte'
  import TimelineDetail from './lib/components/TimelineDetail.svelte'

  const zh = locale().startsWith('zh')
  const categoryNames: Record<string, string> = { work: 'Work', interest: 'Interests', life: 'Life', leisure: 'Leisure', other: 'Other' }
  let doc = $state<TimelineDocument | null>(null)
  let rules = $state<ClassificationRule[]>(DEFAULT_RULES)
  let loadingRules = $state(true)
  let ruleError = $state('')
  let invalidRules = $state(false)
  let settings = $state(false)
  let saving = $state(false)
  let selected = $state<TimelineItem | null>(null)
  let trigger: HTMLButtonElement | null = null
  let settingsOpener: HTMLButtonElement | null = null
  let settingsTrigger: HTMLButtonElement
  const layout = $derived(layoutTimeline(doc?.items ?? []))
  const dateLabel = $derived.by(() => {
    if (!doc?.date) return doc?.title || (zh ? '时间线' : 'Timeline')
    const date = new Date(`${doc.date}T12:00:00`)
    return Number.isNaN(date.getTime()) ? doc.date : new Intl.DateTimeFormat(zh ? 'zh-CN' : 'en-US', { month: 'long', day: 'numeric', weekday: 'long' }).format(date)
  })

  async function fetchRules() {
    loadingRules = true
    ruleError = ''
    invalidRules = false
    try { rules = await loadRules() }
    catch (cause) {
      invalidRules = cause instanceof InvalidRulesError
      ruleError = `${zh ? '无法读取分类设置。' : 'Could not load classification settings.'} ${cause instanceof Error ? cause.message : String(cause)}`
    }
    finally { loadingRules = false }
  }

  // Receive the document before deferred mount effects, including a fast
  // parent onload snapshot. Settings do not gate the display handshake.
  const unsubscribe = onDocument((value) => { doc = value; selected = null })
  onDestroy(unsubscribe)
  onMount(() => { void fetchRules() })

  function showSettings(reset = false, event?: MouseEvent) {
    if (loadingRules || (ruleError && !(reset && invalidRules)) || saving || settings) return
    settingsOpener = event?.currentTarget as HTMLButtonElement | null
    if (reset) rules = structuredClone(DEFAULT_RULES)
    selected = null
    settings = true
    void tick().then(() => document.querySelector<HTMLInputElement>('.settings input')?.focus())
  }

  async function closeSettings() {
    if (saving) return
    settings = false
    await tick()
    ;(settingsOpener?.isConnected ? settingsOpener : settingsTrigger)?.focus()
  }

  async function persistRules(value: ClassificationRule[]) {
    if (saving) return
    saving = true
    try {
      await saveRules(value)
      rules = value
      ruleError = ''
      invalidRules = false
      settings = false
    } finally { saving = false }
    await tick()
    settingsTrigger?.focus()
  }

  function select(item: TimelineItem, event: MouseEvent) {
    selected = item
    trigger = event.currentTarget as HTMLButtonElement
    void tick().then(() => document.querySelector<HTMLButtonElement>('.detail .close')?.focus({ preventScroll: true }))
  }

  async function closeDetail() {
    selected = null
    await tick()
    trigger?.focus({ preventScroll: true })
  }
</script>

<div class="app ui-surface">
  <header class="toolbar">
    <div class="heading">
      <div class="eyebrow">{zh ? '日程时间线' : 'DAILY TIMELINE'}{#if doc?.date}<span>{doc.date.slice(0, 4)}</span>{/if}</div>
      <h1>{dateLabel}</h1>
      {#if doc}<div class="subheading">{doc.items.length} {zh ? '段活动' : 'activities'}{#if layout.ticks.length}<span>·</span>{formatTime(Math.min(...doc.items.map((item) => item.start)))} — {formatTime(Math.max(...doc.items.map((item) => item.end)))}{/if}</div>{/if}
    </div>
    <div class="toolbar-actions">
      <button class="toolbar-button" disabled={saving} onclick={() => { if (!saving) editMarkdown() }}><span class="code-icon" aria-hidden="true">‹/›</span>{zh ? '编辑 Markdown' : 'Edit Markdown'}</button>
      <button class="toolbar-button" class:active={settings} bind:this={settingsTrigger} aria-expanded={settings} disabled={loadingRules || !!ruleError || saving || settings} onclick={(event) => showSettings(false, event)}><span aria-hidden="true">☷</span>{zh ? '分类设置' : 'Categories'}</button>
    </div>
  </header>

  {#if ruleError}<div class="load-error" role="alert"><span>{ruleError}{#if invalidRules} {zh ? '重新设置并保存后，将替换损坏的分类规则。' : 'Resetting and saving will replace the damaged rules.'}{/if}</span><button disabled={loadingRules || saving || settings} onclick={() => { if (!saving && !settings) void fetchRules() }}>{zh ? '重试' : 'Retry'}</button>{#if invalidRules}<button disabled={loadingRules || saving || settings} onclick={(event) => showSettings(true, event)}>{zh ? '重新设置分类' : 'Reset categories'}</button>{/if}</div>{/if}

  {#if settings}
    <main class="settings-scroll"><ClassificationSettings {rules} {zh} onsave={persistRules} oncancel={closeSettings} /></main>
  {:else if !doc}
    <main class="empty" aria-live="polite">{zh ? '正在加载时间线…' : 'Loading timeline…'}</main>
  {:else}
    <div class="legend" aria-label={zh ? '分类图例' : 'Category legend'}>
      {#each CATEGORIES as category}<span class="legend-item"><i data-category={category.id}></i>{zh ? category.label : categoryNames[category.id]}</span>{/each}
      <span class="legend-hint">{zh ? '点击时间块查看详情' : 'Select a block for details'}</span>
    </div>
    {#if doc.title || doc.description || doc.notes.length}
      <details class="document-notes"><summary>{zh ? '时间线说明' : 'Timeline notes'}</summary><div>{#if doc.title}<p class="original-title">{doc.title}</p>{/if}{#if doc.description}<p>{doc.description}</p>{/if}{#each doc.notes as note}<p>{note}</p>{/each}</div></details>
    {/if}
    <main class="workspace" class:has-detail={!!selected}>
      <div class="schedule-scroll" role="region" aria-label={zh ? '日程时间轴' : 'Daily schedule'}>
        {#if !doc.items.length}<div class="empty">{zh ? '暂无带时间的活动记录。可编辑 Markdown 添加日程。' : 'No timed activities yet. Edit Markdown to add a schedule.'}</div>
        {:else}
          <div class="schedule" style:height={`${layout.height + 30}px`} style:min-width={`${Math.max(290, layout.columns * 140 + 80)}px`}>
            {#each layout.ticks as minute}<div class="hour" style:top={`${(minute - layout.ticks[0]) * PIXELS_PER_MINUTE + 16}px`}><time>{formatTime(minute)}</time><span></span></div>{/each}
            <div class="events">
              {#each layout.blocks as block (block.item.id)}
                {@const classification = classifyItem(block.item, rules)}
                {@const action = classification.action || block.item.action || (zh ? '活动' : 'Activity')}
                <button class="event" class:compact={block.height < 64} class:selected={selected?.id === block.item.id} data-category={classification.category} data-item-id={block.item.id} style:top={`${block.top + 16}px`} style:height={`${block.height}px`} style:left={`calc(${block.column / block.columns * 100}% + 3px)`} style:width={`calc(${100 / block.columns}% - 6px)`} aria-label={`${formatTime(block.item.start)}–${formatTime(block.item.end)} ${action}：${block.item.text}`} aria-pressed={selected?.id === block.item.id} title={`${formatTime(block.item.start)}–${formatTime(block.item.end)} · ${action}\n${block.item.text}`} onclick={(event) => select(block.item, event)}>
                  <div class="event-top"><strong>{action}</strong><span>{formatDuration(block.item, zh)}</span></div>
                  <div class="event-time">{formatTime(block.item.start)}–{formatTime(block.item.end)}{#if block.item.children.length}<span> · {block.item.children.length} {zh ? '个议题' : 'topics'}</span>{/if}</div>
                  {#if block.height >= 64}<p class="event-text">{block.item.text}</p>{/if}
                </button>
              {/each}
            </div>
          </div>
        {/if}
      </div>
      {#if selected}<div class="detail-container">{#key selected.id}<TimelineDetail item={selected} {rules} {zh} onclose={closeDetail} onlink={openLink} />{/key}</div>{/if}
    </main>
  {/if}
</div>

<style>
  :global(:root) { color-scheme: light dark; }
  :global(html), :global(body), :global(#app) { height: 100%; margin: 0; }
  :global(body) { background: var(--ui-surface); }
  :global([data-category='work']) { --category-bg: #e9f2ff; --category-border: #a9c8ef; }
  :global([data-category='interest']) { --category-bg: #eaf6ee; --category-border: #abd3b7; }
  :global([data-category='life']) { --category-bg: #fceef2; --category-border: #e5b8c6; }
  :global([data-category='leisure']) { --category-bg: #f0f1f3; --category-border: #c7cbd1; }
  :global([data-category='other']) { --category-bg: #fff; --category-border: #d8dbe0; }
  .app { height: 100%; display: flex; flex-direction: column; overflow: hidden; }
  .toolbar { display: flex; justify-content: space-between; gap: 20px; align-items: center; padding: 22px 26px 18px; flex-shrink: 0; }
  .heading { min-width: 0; }
  .eyebrow { font-size: 10px; font-weight: 650; letter-spacing: 1.5px; color: var(--ui-secondary); display: flex; align-items: center; gap: 10px; }
  .eyebrow span { letter-spacing: .4px; font-weight: 400; padding-left: 10px; border-left: 1px solid var(--ui-separator); }
  h1 { margin: 5px 0 6px; font-size: 24px; font-weight: 650; line-height: 1.3; letter-spacing: -.7px; overflow-wrap: anywhere; }
  .subheading { display: flex; gap: 8px; font-size: 11px; color: var(--ui-secondary); font-variant-numeric: tabular-nums; flex-wrap: wrap; }
  .toolbar-actions { display: flex; gap: 6px; flex-shrink: 0; }
  .toolbar-button { display: flex; align-items: center; justify-content: center; gap: 6px; padding: 7px 10px; color: var(--ui-secondary); border: 1px solid var(--ui-separator); border-radius: 7px; background: var(--ui-surface); cursor: pointer; font-size: 11px; white-space: nowrap; }
  .toolbar-button:hover:enabled { background: var(--ui-hover); color: CanvasText; }
  .toolbar-button.active { background: var(--ui-selection); color: var(--ui-accent-text); }
  .toolbar-button:disabled:not(.active) { opacity: .5; }
  .code-icon { font-family: ui-monospace, monospace; }
  .legend { display: flex; align-items: center; gap: 17px; flex-wrap: wrap; padding: 11px 26px; border-top: 1px solid var(--ui-separator); border-bottom: 1px solid var(--ui-separator); flex-shrink: 0; background: var(--ui-bg); }
  .legend-item { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--ui-secondary); }
  .legend-item i { width: 10px; height: 10px; border-radius: 3px; border: 1px solid var(--category-border); background: var(--category-bg); }
  .legend-hint { margin-left: auto; font-size: 10px; color: var(--ui-tertiary); }
  .document-notes { font-size: 11px; padding: 9px 26px; border-bottom: 1px solid var(--ui-separator); flex-shrink: 0; }
  .document-notes summary { cursor: pointer; color: var(--ui-secondary); }
  .document-notes div { max-height: 160px; overflow: auto; }
  .document-notes p { margin: 10px 0; white-space: pre-wrap; overflow-wrap: anywhere; }
  .original-title { font-weight: 650; }
  .workspace { display: flex; flex: 1; min-height: 0; }
  .schedule-scroll { flex: 1; overflow: auto; min-width: 0; padding: 15px 23px 25px 12px; }
  .schedule { position: relative; }
  .hour { position: absolute; display: flex; align-items: center; gap: 13px; width: 100%; }
  .hour time { width: 48px; text-align: right; color: var(--ui-tertiary); font-size: 10px; line-height: 1; font-variant-numeric: tabular-nums; flex-shrink: 0; transform: translateY(-50%); }
  .hour > span { height: 1px; background: var(--ui-separator); width: 100%; transform: translateY(-5px); }
  .events { position: absolute; top: 0; left: 66px; right: 0; bottom: 0; }
  .event { position: absolute; display: flex; flex-direction: column; text-align: left; padding: 8px 10px; border: 1px solid var(--category-border); border-left-width: 3px; border-radius: 6px; background: var(--category-bg); color: CanvasText; cursor: pointer; box-sizing: border-box; min-width: 0; overflow: hidden; }
  .event:hover { filter: brightness(.98); border-color: color-mix(in srgb, var(--category-border) 65%, CanvasText); }
  .event.selected { outline: 2px solid var(--ui-accent); outline-offset: 1px; }
  .event-top { display: flex; align-items: baseline; gap: 6px; min-width: 0; width: 100%; }
  .event-top strong { font-size: 12px; line-height: 16px; font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .event-top > span { margin-left: auto; color: var(--ui-secondary); font-size: 10px; flex-shrink: 0; }
  .event-time { color: var(--ui-secondary); font-size: 10px; line-height: 14px; white-space: nowrap; font-variant-numeric: tabular-nums; margin-top: 2px; }
  .event-text { margin: 5px 0 0; font-size: 11px; line-height: 1.65; color: var(--ui-secondary); overflow: hidden; overflow-wrap: anywhere; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 4; line-clamp: 4; }
  .event.compact { padding: 3px 8px; }
  .event.compact .event-time { margin-top: 0; }
  .detail-container { width: 330px; min-width: 270px; max-width: 40%; flex-shrink: 0; }
  .settings-scroll { flex: 1; min-height: 0; overflow: auto; background: var(--ui-bg); border-top: 1px solid var(--ui-separator); }
  .empty { flex: 1; display: flex; align-items: center; justify-content: center; min-height: 160px; padding: 30px; color: var(--ui-secondary); text-align: center; }
  .load-error { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; background: var(--ui-bg); padding: 10px 26px; color: var(--ui-danger); font-size: 11px; overflow-wrap: anywhere; }
  .load-error button { flex-shrink: 0; border: 1px solid var(--ui-control-border); padding: 4px 9px; border-radius: 5px; color: CanvasText; background: var(--ui-surface); cursor: pointer; }
  @media (prefers-color-scheme: dark) {
    :global([data-category='work']) { --category-bg: #243449; --category-border: #47668c; }
    :global([data-category='interest']) { --category-bg: #253c30; --category-border: #496e56; }
    :global([data-category='life']) { --category-bg: #432f38; --category-border: #795262; }
    :global([data-category='leisure']) { --category-bg: #30343a; --category-border: #555c65; }
    :global([data-category='other']) { --category-bg: #242628; --category-border: #50555b; }
    .event:hover { filter: brightness(1.08); }
  }
  @media (max-width: 780px) { .workspace { flex-direction: column; } .detail-container { order: -1; width: 100%; max-width: none; min-width: 0; } .legend-hint { display: none; } }
  @media (max-width: 560px) { .toolbar { align-items: flex-start; flex-direction: column; gap: 13px; padding: 18px 18px 15px; } h1 { font-size: 22px; } .toolbar-actions { width: 100%; } .toolbar-button { flex: 1; } .legend { padding: 10px 18px; gap: 13px; } .document-notes { padding-inline: 18px; } .schedule-scroll { padding-left: 4px; padding-right: 12px; } }
</style>
