<script lang="ts">
  import '../../../src/styles/ui-foundation.css'
  import { onDestroy, onMount, tick } from 'svelte'
  import { DEFAULT_START_TIME, InvalidSettingsError, loadSettings, locale, onDocument, openLink, openTimelineDate, saveSettings, startTimeMinute, type TimelineSettings } from './lib/bridge'
  import { CATEGORIES, classifyItem, DEFAULT_RULES, type ClassificationRule } from './lib/classification'
  import type { TimelineDocument, TimelineItem } from './lib/parser'
  import { formatDuration, formatTime, layoutTimeline, PIXELS_PER_MINUTE } from './lib/layout'
  import { shiftTimelineDate } from './lib/date-navigation'
  import { scrollTimelineToMinute } from './lib/scroll-position'
  import ClassificationSettings from './lib/components/ClassificationSettings.svelte'
  import TimelineDetail from './lib/components/TimelineDetail.svelte'
  import ImportanceLabel from './lib/components/ImportanceLabel.svelte'
  import { assessmentLabel, IMPORTANCE_LEVELS } from './lib/importance'

  const zh = locale().startsWith('zh')
  const categoryNames: Record<string, string> = { work: 'Work', interest: 'Interests', life: 'Life', leisure: 'Leisure', other: 'Other' }
  let doc = $state<TimelineDocument | null>(null)
  let rules = $state<ClassificationRule[]>(DEFAULT_RULES)
  let startTime = $state(DEFAULT_START_TIME)
  let loadingRules = $state(true)
  let ruleError = $state('')
  let invalidRules = $state(false)
  let settings = $state(false)
  let saving = $state(false)
  let navigating = $state(false)
  let navigationError = $state('')
  let selected = $state<TimelineItem | null>(null)
  let trigger: HTMLButtonElement | null = null
  let settingsOpener: HTMLButtonElement | null = null
  let settingsTrigger: HTMLButtonElement
  let scheduleScroll = $state<HTMLDivElement | null>(null)
  let scheduleElement = $state<HTMLDivElement | null>(null)
  let positionVersion = 0
  const layout = $derived(layoutTimeline(doc?.items ?? []))
  const previousDate = $derived(doc ? shiftTimelineDate(doc.date, -1) : null)
  const nextDate = $derived(doc ? shiftTimelineDate(doc.date, 1) : null)
  const dateNavigationDisabled = $derived(navigating || settings || saving)
  const dateLabel = $derived.by(() => {
    if (!doc?.date) return doc?.title || (zh ? '时间线' : 'Timeline')
    const date = new Date(`${doc.date}T12:00:00`)
    return Number.isNaN(date.getTime()) ? doc.date : new Intl.DateTimeFormat(zh ? 'zh-CN' : 'en-US', { month: 'long', day: 'numeric', weekday: 'long' }).format(date)
  })

  async function fetchSettings() {
    loadingRules = true
    ruleError = ''
    invalidRules = false
    try {
      const loaded = await loadSettings()
      rules = loaded.classification
      startTime = loaded.startTime
    }
    catch (cause) {
      invalidRules = cause instanceof InvalidSettingsError
      ruleError = `${zh ? '无法读取时间线设置。' : 'Could not load timeline settings.'} ${cause instanceof Error ? cause.message : String(cause)}`
    }
    finally {
      loadingRules = false
      if (doc) void positionSchedule()
    }
  }

  async function positionSchedule() {
    const version = ++positionVersion
    if (loadingRules) return
    await tick()
    if (typeof requestAnimationFrame === 'function') await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    if (version !== positionVersion || !scheduleScroll || !scheduleElement || !layout.ticks.length) return
    scrollTimelineToMinute(scheduleScroll, scheduleElement, startTimeMinute(startTime), layout.ticks[0])
  }

  // Receive the document before deferred mount effects, including a fast
  // parent onload snapshot. Settings do not gate the display handshake.
  const unsubscribe = onDocument((value) => { doc = value; selected = null; navigationError = ''; void positionSchedule() })
  onDestroy(unsubscribe)
  onMount(() => { void fetchSettings() })

  function showSettings(reset = false, event?: MouseEvent) {
    if (loadingRules || (ruleError && !(reset && invalidRules)) || saving || navigating || settings) return
    settingsOpener = event?.currentTarget as HTMLButtonElement | null
    if (reset) { rules = structuredClone(DEFAULT_RULES); startTime = DEFAULT_START_TIME }
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

  async function persistSettings(value: TimelineSettings) {
    if (saving) return
    saving = true
    try {
      await saveSettings(value)
      rules = value.classification
      startTime = value.startTime
      ruleError = ''
      invalidRules = false
      settings = false
    } finally { saving = false }
    await tick()
    if (doc) void positionSchedule()
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

  async function navigateDate(date: string | null) {
    if (!date || date === doc?.date || dateNavigationDisabled) return
    navigating = true
    navigationError = ''
    try { await openTimelineDate(date) }
    catch (cause) { navigationError = cause instanceof Error ? cause.message : String(cause) }
    finally { navigating = false }
  }
</script>

<div class="app ui-surface">
  <header class="toolbar">
    <div class="heading">
      <div class="eyebrow">{zh ? '日程时间线' : 'DAILY TIMELINE'}{#if doc?.date}<span>{doc.date.slice(0, 4)}</span>{/if}</div>
      <div class="date-navigation" aria-label={zh ? '时间线日期' : 'Timeline date'}>
        {#if previousDate || nextDate}<button class="day-button" aria-label={zh ? '上一天' : 'Previous day'} disabled={dateNavigationDisabled || !previousDate} onclick={() => navigateDate(previousDate)}>‹</button>{/if}
        <div class="date-title">
          <h1>{dateLabel}</h1>
          {#if previousDate || nextDate}
            <input class="date-picker" type="date" aria-label={zh ? '选择日期' : 'Choose date'} title={zh ? '选择日期' : 'Choose date'} value={doc?.date} min="0001-01-01" max="9999-12-31" disabled={dateNavigationDisabled} onchange={(event) => { const date = event.currentTarget.value; event.currentTarget.value = doc?.date ?? ''; void navigateDate(date) }} />
          {/if}
        </div>
        {#if previousDate || nextDate}<button class="day-button" aria-label={zh ? '下一天' : 'Next day'} disabled={dateNavigationDisabled || !nextDate} onclick={() => navigateDate(nextDate)}>›</button>{/if}
      </div>
      {#if doc}<div class="subheading">{doc.items.length} {zh ? '段活动' : 'activities'}{#if layout.ticks.length}<span>·</span>{formatTime(Math.min(...doc.items.map((item) => item.start)))} — {formatTime(Math.max(...doc.items.map((item) => item.end)))}{/if}</div>{/if}
    </div>
    <div class="toolbar-actions">
      <button class="toolbar-button" class:active={settings} bind:this={settingsTrigger} aria-expanded={settings} disabled={loadingRules || !!ruleError || saving || navigating || settings} onclick={(event) => showSettings(false, event)}><span aria-hidden="true">☷</span>{zh ? '时间线设置' : 'Settings'}</button>
    </div>
  </header>

  {#if navigationError}<div class="navigation-error" role="alert">{navigationError}</div>{/if}

  {#if ruleError}<div class="load-error" role="alert"><span>{ruleError}{#if invalidRules} {zh ? '重新设置并保存后，将替换损坏的时间线设置。' : 'Resetting and saving will replace the damaged timeline settings.'}{/if}</span><button disabled={loadingRules || saving || settings} onclick={() => { if (!saving && !settings) void fetchSettings() }}>{zh ? '重试' : 'Retry'}</button>{#if invalidRules}<button disabled={loadingRules || saving || settings} onclick={(event) => showSettings(true, event)}>{zh ? '重新设置' : 'Reset settings'}</button>{/if}</div>{/if}

  {#if settings}
    <main class="settings-scroll"><ClassificationSettings {rules} {startTime} {zh} onsave={persistSettings} oncancel={closeSettings} /></main>
  {:else if !doc}
    <main class="empty" aria-live="polite">{zh ? '正在加载时间线…' : 'Loading timeline…'}</main>
  {:else}
    <div class="legend" aria-label={zh ? '分类图例' : 'Category legend'}>
      {#each CATEGORIES as category}<span class="legend-item"><i data-category={category.id}></i>{zh ? category.label : categoryNames[category.id]}</span>{/each}
      <span class="legend-hint">{zh ? '点击时间块查看详情' : 'Select a block for details'}</span>
    </div>
    <div class="importance-legend" aria-label={zh ? '重要程度图例' : 'Importance legend'}>
      <span class="legend-title">{zh ? '重要程度' : 'Importance'}</span>
      {#each IMPORTANCE_LEVELS as importance}<ImportanceLabel {importance} {zh} />{/each}
      <span class="anomaly-key">{zh ? '反常单独判断' : 'Anomalies assessed separately'}</span>
    </div>
    {#if doc.title || doc.description || doc.notes.length}
      <details class="document-notes"><summary>{zh ? '时间线说明' : 'Timeline notes'}</summary><div>{#if doc.title}<p class="original-title">{doc.title}</p>{/if}{#if doc.description}<p>{doc.description}</p>{/if}{#each doc.notes as note}<p>{note}</p>{/each}</div></details>
    {/if}
    <main class="workspace" class:has-detail={!!selected}>
      <div class="schedule-scroll" bind:this={scheduleScroll} role="region" aria-label={zh ? '日程时间轴' : 'Daily schedule'}>
        {#if !doc.items.length}<div class="empty">{zh ? '暂无带时间的活动记录。可编辑 Markdown 添加日程。' : 'No timed activities yet. Edit Markdown to add a schedule.'}</div>
        {:else}
          <div class="schedule" bind:this={scheduleElement} style:height={`${layout.height + 30}px`} style:min-width={`${Math.max(290, layout.columns * 200 + 80)}px`}>
            {#each layout.ticks as minute}<div class="hour" style:top={`${(minute - layout.ticks[0]) * PIXELS_PER_MINUTE + 16}px`}><time>{formatTime(minute)}</time><span></span></div>{/each}
            <div class="events">
              {#each layout.blocks as block (block.item.id)}
                {@const classification = classifyItem(block.item, rules)}
                {@const action = classification.action || block.item.action || (zh ? '活动' : 'Activity')}
                {@const timeLabel = `${formatTime(block.item.start)}–${formatTime(block.item.end)}${block.item.children.length ? ` · ${block.item.children.length} ${zh ? '个议题' : 'topics'}` : ''}`}
                <button class="event" class:compact={block.height < 64} class:selected={selected?.id === block.item.id} data-category={classification.category} data-item-id={block.item.id} data-importance={block.item.metadata.importance} style:top={`${block.top + 16}px`} style:height={`${block.height}px`} style:left={`calc(${block.column / block.columns * 100}% + 3px)`} style:width={`calc(${100 / block.columns}% - 6px)`} aria-label={`${assessmentLabel(block.item, zh)} · ${timeLabel} · ${formatDuration(block.item, zh)} ${action}：${block.item.text}`} aria-pressed={selected?.id === block.item.id} title={`${timeLabel} · ${formatDuration(block.item, zh)} · ${action}\n${block.item.text}`} onclick={(event) => select(block.item, event)}>
                  <div class="event-top"><strong>{action}</strong><ImportanceLabel importance={block.item.metadata.importance} flagged={block.item.metadata.anomaly?.status === 'flagged'} {zh} /></div>
                  <div class="event-time"><span class="event-range">{timeLabel}</span><span class="event-duration">{formatDuration(block.item, zh)}</span></div>
                  {#if block.height >= 76}<p class="event-text">{block.item.text}</p>{/if}
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
  :global([data-category='work']) { --category-bg: #f0f4f8; --category-border: #d9e1eb; }
  :global([data-category='interest']) { --category-bg: #f1f5f1; --category-border: #dce5dd; }
  :global([data-category='life']) { --category-bg: #f8f1f3; --category-border: #eadde1; }
  :global([data-category='leisure']) { --category-bg: #f3f3f5; --category-border: #e0e0e5; }
  :global([data-category='other']) { --category-bg: #fafafa; --category-border: #e2e2e7; }
  :global([data-importance='high']) { --importance-color: var(--timeline-important-text); --importance-stripe: var(--timeline-important-stripe); }
  :global([data-importance='normal']) { --importance-color: var(--timeline-normal-text); --importance-stripe: var(--timeline-normal-stripe); }
  :global([data-importance='unknown']) { --importance-color: var(--timeline-pending-text); --importance-stripe: var(--timeline-pending-stripe); }
  .app {
    --timeline-important-text: #825b32;
    --timeline-important-stripe: #bea17a;
    --timeline-normal-text: #496887;
    --timeline-normal-stripe: #94aac0;
    --timeline-pending-text: #65656d;
    --timeline-pending-stripe: #b4b4bd;
    --timeline-anomaly-text: #8c5860;
    --timeline-anomaly-bg: #f2e6e8;
  }
  .app { height: 100%; display: flex; flex-direction: column; overflow: hidden; }
  .toolbar { display: flex; justify-content: space-between; gap: 20px; align-items: center; padding: 22px 26px 18px; flex-shrink: 0; }
  .heading { min-width: 0; max-width: 100%; }
  .eyebrow { font-size: 10px; font-weight: 650; letter-spacing: 1.5px; color: var(--ui-secondary); display: flex; align-items: center; gap: 10px; }
  .eyebrow span { letter-spacing: .4px; font-weight: 400; padding-left: 10px; border-left: 1px solid var(--ui-separator); }
  h1 { margin: 5px 0 6px; font-size: 24px; font-weight: 650; line-height: 1.3; letter-spacing: -.7px; overflow-wrap: anywhere; }
  .date-navigation { display: flex; align-items: center; gap: 5px; min-width: 0; }
  .date-title { position: relative; min-width: 0; border-radius: 5px; }
  .date-title h1 { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .date-title:focus-within { outline: 3px solid var(--ui-focus); outline-offset: 2px; }
  .date-picker { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; opacity: 0; cursor: pointer; }
  .date-picker::-webkit-calendar-picker-indicator { position: absolute; inset: 0; width: 100%; height: 100%; padding: 0; margin: 0; cursor: pointer; }
  .day-button { display: grid; place-items: center; flex-shrink: 0; width: 24px; height: 26px; padding: 0; border: 0; border-radius: 5px; background: transparent; color: var(--ui-secondary); font: 22px/1 var(--ui-font); cursor: pointer; }
  .day-button:hover:enabled { background: var(--ui-hover); color: CanvasText; }
  .day-button:disabled { opacity: .35; }
  .navigation-error { padding: 0 26px 12px; color: var(--ui-danger); font-size: 11px; overflow-wrap: anywhere; }
  .subheading { display: flex; gap: 8px; font-size: 11px; color: var(--ui-secondary); font-variant-numeric: tabular-nums; flex-wrap: wrap; }
  .toolbar-actions { display: flex; gap: 6px; flex-shrink: 0; }
  .toolbar-button { display: flex; align-items: center; justify-content: center; gap: 6px; padding: 7px 10px; color: var(--ui-secondary); border: 1px solid var(--ui-separator); border-radius: 7px; background: var(--ui-surface); cursor: pointer; font-size: 11px; white-space: nowrap; }
  .toolbar-button:hover:enabled { background: var(--ui-hover); color: CanvasText; }
  .toolbar-button.active { background: var(--ui-selection); color: var(--ui-accent-text); }
  .toolbar-button:disabled:not(.active) { opacity: .5; }
  .legend { display: flex; align-items: center; gap: 17px; flex-wrap: wrap; padding: 11px 26px; border-top: 1px solid var(--ui-separator); border-bottom: 1px solid var(--ui-separator); flex-shrink: 0; background: var(--ui-bg); }
  .importance-legend { display: flex; align-items: center; flex-wrap: wrap; gap: 7px 17px; padding: 8px 26px; border-bottom: 1px solid var(--ui-separator); flex-shrink: 0; }
  .legend-title, .anomaly-key { font-size: 10px; color: var(--ui-secondary); }
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
  .event { position: absolute; display: flex; flex-direction: column; text-align: left; padding: 8px 10px; border: 1px solid var(--category-border); border-left: 4px solid var(--importance-stripe); border-radius: 6px; background: var(--category-bg); color: CanvasText; cursor: pointer; box-sizing: border-box; min-width: 0; overflow: hidden; }
  .event:hover { filter: brightness(.98); border-color: color-mix(in srgb, var(--category-border) 65%, CanvasText); border-left-color: var(--importance-stripe); }
  .event.selected { outline: 2px solid var(--ui-accent); outline-offset: 1px; }
  .event-top { display: flex; align-items: baseline; gap: 6px; min-width: 0; width: 100%; }
  .event-top strong { flex: 1; min-width: 0; font-size: 12px; line-height: 16px; font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .event-time { display: flex; align-items: baseline; gap: 6px; width: 100%; min-width: 0; color: var(--ui-secondary); font-size: 10px; line-height: 14px; white-space: nowrap; font-variant-numeric: tabular-nums; margin-top: 2px; }
  .event-range { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .event-duration { flex-shrink: 0; }
  .event-text { margin: 5px 0 0; font-size: 11px; line-height: 1.65; color: var(--ui-secondary); overflow: hidden; overflow-wrap: anywhere; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 4; line-clamp: 4; }
  .event.compact { padding: 3px 8px; }
  .event.compact .event-time { margin-top: 0; }
  .detail-container { width: 330px; min-width: 270px; max-width: 40%; flex-shrink: 0; }
  .settings-scroll { flex: 1; min-height: 0; overflow: auto; background: var(--ui-bg); border-top: 1px solid var(--ui-separator); }
  .empty { flex: 1; display: flex; align-items: center; justify-content: center; min-height: 160px; padding: 30px; color: var(--ui-secondary); text-align: center; }
  .load-error { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; background: var(--ui-bg); padding: 10px 26px; color: var(--ui-danger); font-size: 11px; overflow-wrap: anywhere; }
  .load-error button { flex-shrink: 0; border: 1px solid var(--ui-control-border); padding: 4px 9px; border-radius: 5px; color: CanvasText; background: var(--ui-surface); cursor: pointer; }
  @media (prefers-color-scheme: dark) {
    .app {
      --timeline-important-text: #d3b286;
      --timeline-important-stripe: #927b5d;
      --timeline-normal-text: #a1b6cf;
      --timeline-normal-stripe: #70849b;
      --timeline-pending-text: #b5b5bd;
      --timeline-pending-stripe: #777780;
      --timeline-anomaly-text: #d1a1a7;
      --timeline-anomaly-bg: #46343a;
    }
    :global([data-category='work']) { --category-bg: #292e36; --category-border: #414a58; }
    :global([data-category='interest']) { --category-bg: #2a312e; --category-border: #424e47; }
    :global([data-category='life']) { --category-bg: #342c31; --category-border: #54434b; }
    :global([data-category='leisure']) { --category-bg: #2d2e32; --category-border: #484950; }
    :global([data-category='other']) { --category-bg: #29292c; --category-border: #45454b; }
    .event:hover { filter: brightness(1.08); }
  }
  @media (max-width: 780px) { .workspace { flex-direction: column; } .detail-container { order: -1; width: 100%; max-width: none; min-width: 0; } .legend-hint { display: none; } }
  @media (max-width: 560px) { .event { max-width: calc(100vw - 92px); } .toolbar { align-items: flex-start; flex-direction: column; gap: 13px; padding: 18px 18px 15px; } h1 { font-size: 22px; } .toolbar-actions { width: 100%; } .toolbar-button { flex: 1; } .legend { padding: 10px 18px; gap: 13px; } .importance-legend { padding-inline: 18px; gap: 7px 13px; } .document-notes { padding-inline: 18px; } .schedule-scroll { padding-left: 4px; padding-right: 12px; } }
</style>
