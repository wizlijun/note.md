<script lang="ts">
  // Smart Lookup window. Local-first: typing previews and Enter both read the
  // local index only; an Agent runs only when the user asks for a quick answer
  // or hands the question to a research Agent from the actions menu.
  import './styles/app.css'
  import { onDestroy, onMount, tick } from 'svelte'
  import { invoke } from '@tauri-apps/api/core'
  import { getCurrentWindow } from '@tauri-apps/api/window'
  import { loadLocale, t, watchLocaleChanges } from './lib/i18n/store.svelte'
  import type { AgentOption } from './lib/agent-picker/types'
  import type { SearchHit } from './lib/search/api'
  import type { HitGroup } from './lib/search/grouping'
  import { decideTrigger } from './lib/search/input-trigger'
  import { highlightParts, parseHighlightTerms, previewLine } from './lib/search/preview'
  import { createImeGuard, isImeKey } from './lib/ime'
  import { loadSettings, settings } from './lib/settings.svelte'
  import { SmartSearchStore } from './lib/smart-search/store.svelte'
  import {
    AgentTaskError,
    cancelAgentTask,
    loadDefaultAgentProvider,
    loadSearchAgentOptions,
    pollAgentTask,
    SEARCH_SUMMARY_TASK,
    VAULT_RESEARCH_TASK,
  } from './lib/smart-search/agent'
  import { smartSearchApi } from './lib/smart-search/api'
  import { buildHandoffPacket } from './lib/smart-search/handoff'
  import { hitKey } from './lib/smart-search/hit-key'
  import {
    dateSections,
    hasSummarySource,
    hitReference,
    pickTaskAgent,
    redactError,
    sourceSections,
  } from './lib/smart-search/lookup-view'
  import { availableModelPreference, selectorForPreference } from './lib/smart-search/model-routing'
  import { validateSummaryOutput, type SummarySource } from './lib/smart-search/summary'
  import {
    appendWorkflowEntry,
    formatWorkflowLog,
    type WorkflowEntry,
    type WorkflowLevel,
    type WorkflowStage,
  } from './lib/smart-search/workflow-log'

  /** `preview`: live typing results. `lookup`: the result of an Enter. */
  type ResultsMode = 'idle' | 'preview' | 'lookup'

  interface RunningAgent {
    provider: string
    runId: string
  }

  const PREVIEW_CHARS = 3_000

  const store = new SmartSearchStore()
  const appWindow = getCurrentWindow()
  const ime = createImeGuard()

  let inputValue = $state('')
  let inputEl = $state<HTMLTextAreaElement>()
  let listEl = $state<HTMLDivElement>()
  let menuEl = $state<HTMLDivElement>()
  let menuButton = $state<HTMLButtonElement>()
  let composing = false
  let previewTimer: ReturnType<typeof setTimeout> | undefined

  let mode = $state<ResultsMode>('idle')
  let question = $state('')
  let lookupBusy = $state(false)
  let lookupRunId = $state('')
  let activeKey = $state<string | null>(null)
  let menuOpen = $state(false)
  let openError = $state('')

  let agents = $state<AgentOption[]>([])
  let appDefaultAgent = $state('')

  let summaryBusy = $state(false)
  let summaryText = $state('')
  let summarySources = $state<SummarySource[]>([])
  let summaryError = $state('')
  let handoffBusy = $state(false)
  let handoffRun = $state<RunningAgent | null>(null)
  let handoffError = $state('')

  let activity = $state<WorkflowEntry[]>([])
  let activitySequence = 0
  let startedAt = 0
  let copyStatus = $state('')
  let copyTimer: ReturnType<typeof setTimeout> | undefined

  /** Bumped by every new lookup, preview or stop; stale async work compares against it. */
  let requestSequence = 0
  let summaryAbort: AbortController | null = null
  let summaryRun: RunningAgent | null = null

  let destroyed = false
  const cleanups: Array<() => void> = []

  let highlightTerms = $derived(parseHighlightTerms(mode === 'lookup' ? question : store.query))
  let sections = $derived(settings.smartLookup.results.groupBy === 'date'
    ? dateSections(store.hits, t('smartSearch.dateUnknown'))
    : sourceSections(store.hits, groupLabel))
  let orderedHits = $derived(sections.flatMap((section) => section.hits))
  let activeHit = $derived(orderedHits.find((hit) => hitKey(hit) === activeKey) ?? orderedHits[0] ?? null)
  let summaryAgent = $derived(pickTaskAgent(
    agents, SEARCH_SUMMARY_TASK, settings.smartLookup.summary.provider, appDefaultAgent,
  ))
  let handoffAgent = $derived(pickTaskAgent(
    agents, VAULT_RESEARCH_TASK, settings.smartLookup.handoff.defaultProvider, appDefaultAgent,
  ))
  let summaryReady = $derived(settings.smartLookup.summary.enabled
    && Boolean(lookupRunId) && Boolean(summaryAgent) && hasSummarySource(orderedHits))
  /** Why the quick answer is unavailable; empty when it is available or switched off in settings. */
  let summaryHint = $derived(
    !settings.smartLookup.summary.enabled || summaryReady ? ''
      : !lookupRunId ? t('smartSearch.summaryNeedsLookup')
        : !summaryAgent ? t('smartSearch.summaryAgentUnavailable')
          : t('smartSearch.summaryNeedsLine'),
  )
  let canSummarize = $derived(summaryReady && !summaryBusy && !lookupBusy)
  let canExpand = $derived(Boolean(lookupRunId) && (store.hits.length === 0 || store.deepAvailable))
  let canHandoff = $derived(Boolean(handoffAgent) && Boolean(question || inputValue.trim()) && !handoffBusy)
  let working = $derived(lookupBusy || summaryBusy || handoffBusy || store.loading)
  let activityText = $derived(
    lookupBusy || store.loading ? t('smartSearch.searching')
      : summaryBusy ? t('smartSearch.summaryWorking')
        : handoffBusy ? t('smartSearch.handoffWorking')
          : activity.at(-1)?.message ?? '',
  )

  $effect(() => {
    const title = t('smartSearch.windowTitle')
    void appWindow.setTitle(title).catch(() => {})
  })

  onMount(() => {
    void initialise()
  })

  onDestroy(() => {
    destroyed = true
    cancelPreview()
    clearTimeout(copyTimer)
    supersede()
    for (const cleanup of cleanups.splice(0)) cleanup()
  })

  function keep(cleanup: () => void): void {
    if (destroyed) cleanup()
    else cleanups.push(cleanup)
  }

  async function initialise(): Promise<void> {
    void loadAgents()
    try {
      await Promise.all([loadLocale(), loadSettings()])
      keep(await watchLocaleChanges())
    } catch { /* Defaults stay in effect; lookup still works. */ }
    try {
      const { listen } = await import('@tauri-apps/api/event')
      keep(await listen('settings://changed', () => { void loadSettings().catch(() => {}) }))
    } catch { /* Browser preview has no event bridge. */ }
    await tick()
    resizeInput()
    inputEl?.focus()
    try {
      keep(await appWindow.onFocusChanged(async ({ payload }) => {
        if (!payload) return
        await tick()
        inputEl?.focus()
        inputEl?.select()
      }))
    } catch { /* Browser preview has no Tauri window. */ }
  }

  /** Agents only gate the quick answer and the handoff; a failure never blocks lookup. */
  async function loadAgents(): Promise<void> {
    try {
      const [loaded, fallback] = await Promise.all([
        loadSearchAgentOptions(),
        loadDefaultAgentProvider().catch(() => ''),
      ])
      agents = loaded
      appDefaultAgent = fallback
    } catch {
      agents = []
    }
  }

  // ---- in-flight work ----

  function cancelPreview(): void {
    if (previewTimer) clearTimeout(previewTimer)
    previewTimer = undefined
  }

  /** Make every running lookup, preview and summary stale; stop the summary's Agent run. */
  function supersede(): number {
    requestSequence += 1
    summaryAbort?.abort()
    summaryAbort = null
    if (summaryRun) {
      const run = summaryRun
      summaryRun = null
      void cancelAgentTask(run.provider, SEARCH_SUMMARY_TASK, run.runId).catch(() => {})
    }
    lookupBusy = false
    summaryBusy = false
    return requestSequence
  }

  function resetDerivedWork(): void {
    lookupRunId = ''
    summaryText = ''
    summarySources = []
    summaryError = ''
    handoffRun = null
    handoffError = ''
    openError = ''
  }

  function resetActivity(): void {
    activity = []
    activitySequence = 0
    startedAt = performance.now()
  }

  function appendActivity(
    stage: WorkflowStage,
    level: WorkflowLevel,
    message: string,
    detail: { runId?: string; steps?: number; usage?: unknown } = {},
  ): void {
    activity = appendWorkflowEntry(activity, {
      id: ++activitySequence,
      stage,
      level,
      message,
      elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
      ...detail,
    })
  }

  // ---- typing preview ----

  function onInput(event: Event): void {
    resizeInput()
    if ((event as InputEvent).isComposing || composing) {
      cancelPreview()
      return
    }
    schedulePreview()
  }

  function schedulePreview(): void {
    cancelPreview()
    const decision = decideTrigger(inputValue, composing)
    if (decision.kind === 'hold') return
    closeMenu(false)
    supersede()
    resetDerivedWork()
    resetActivity()
    if (decision.kind === 'clear') {
      store.clear()
      mode = 'idle'
      question = ''
      activeKey = null
      return
    }
    const query = inputValue
    previewTimer = setTimeout(() => {
      previewTimer = undefined
      mode = 'preview'
      question = ''
      activeKey = null
      void store.run(query, { deep: false, limit: settings.smartLookup.results.limit })
    }, decision.delayMs)
  }

  function onCompositionStart(): void {
    composing = true
    ime.start()
    cancelPreview()
  }

  function onCompositionEnd(): void {
    composing = false
    ime.end()
    schedulePreview()
  }

  function resizeInput(): void {
    if (!inputEl) return
    inputEl.style.height = 'auto'
    inputEl.style.height = `${Math.min(inputEl.scrollHeight, 96)}px`
  }

  // ---- lookup (Enter) and expanded lookup ----

  async function lookup(deep = false): Promise<void> {
    const submitted = deep ? question : inputValue.trim()
    if (!submitted) return
    cancelPreview()
    closeMenu(false)
    const mine = supersede()
    store.cancel()
    resetDerivedWork()
    if (deep) startedAt = performance.now()
    else resetActivity()
    question = submitted
    mode = 'lookup'
    lookupBusy = true
    if (deep) appendActivity('search', 'active', t('smartSearch.activityDeepStart'))
    const limit = settings.smartLookup.results.limit
    try {
      const result = await smartSearchApi.localLookup(submitted, deep
        ? { limit, deep: true, timeoutMs: settings.smartLookup.results.deepTimeoutMs }
        : { limit, deep: false })
      if (mine !== requestSequence) return
      store.apply(submitted, result.search)
      lookupRunId = result.lookupRunId
      activeKey = orderedHits[0] ? hitKey(orderedHits[0]) : null
      const n = result.search.hits.length
      const docs = new Set(result.search.hits.map((hit) => hit.path)).size
      appendActivity(
        'search',
        result.search.truncated ? 'warning' : 'success',
        t(result.search.truncated ? 'smartSearch.activitySearchPartial' : 'smartSearch.activitySearchDone', { n, docs }),
      )
    } catch (error) {
      if (mine !== requestSequence) return
      const message = redactError(error)
      store.fail(submitted, message)
      activeKey = null
      appendActivity('search', 'error', `${t('smartSearch.searchError')}: ${message}`)
    } finally {
      if (mine === requestSequence) lookupBusy = false
    }
  }

  // ---- quick answer ----

  function summaryModelSelector(agent: AgentOption) {
    return selectorForPreference(availableModelPreference(
      settings.smartLookup.summary.modelByProvider[agent.id] ?? 'profile:fast',
      'summary',
      agent.harness,
    ))
  }

  async function generateSummary(): Promise<void> {
    const agent = summaryAgent
    if (!canSummarize || !agent) return
    const runId = lookupRunId
    const config = { ...settings.smartLookup.summary }
    const mine = requestSequence
    const controller = new AbortController()
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined
    summaryAbort = controller
    summaryBusy = true
    summaryText = ''
    summarySources = []
    summaryError = ''
    appendActivity('summary', 'active', t('smartSearch.activitySummaryStart'))
    try {
      const start = await smartSearchApi.startSummary(
        runId,
        [],
        config.sourceLimit,
        config.charLimit,
        config.style,
        agent.id,
        summaryModelSelector(agent),
        crypto.randomUUID(),
      )
      if (mine !== requestSequence) {
        void cancelAgentTask(agent.id, SEARCH_SUMMARY_TASK, start.runId).catch(() => {})
        return
      }
      summaryRun = { provider: agent.id, runId: start.runId }
      if (start.staleCount > 0) {
        appendActivity('summary', 'warning', t('smartSearch.summaryStale', { n: start.staleCount }))
      }
      timer = setTimeout(() => { timedOut = true; controller.abort() }, config.timeoutMs)
      const result = await pollAgentTask(agent.id, SEARCH_SUMMARY_TASK, start.runId, (progress) => {
        if (mine !== requestSequence) return
        appendActivity('summary', 'active', t('smartSearch.activityStep', { n: progress.steps }), {
          runId: start.runId, steps: progress.steps,
        })
      }, { signal: controller.signal })
      if (mine !== requestSequence) return
      summaryRun = null
      const valid = validateSummaryOutput(result.content, start.sources, config.style)
      summaryText = valid.content
      summarySources = start.sources
      appendActivity('summary', 'success', t('smartSearch.activitySummaryDone'), {
        runId: start.runId, usage: result.usage,
      })
    } catch (error) {
      if (mine !== requestSequence) return
      if (timedOut && summaryRun) {
        const run = summaryRun
        void cancelAgentTask(run.provider, SEARCH_SUMMARY_TASK, run.runId).catch(() => {})
      }
      summaryRun = null
      summaryError = timedOut
        ? t('smartSearch.agentTimeout')
        : error instanceof AgentTaskError ? t('smartSearch.agentFailed') : redactError(error)
      appendActivity('summary', 'error', `${t('smartSearch.summaryUnavailable')} ${summaryError}`)
    } finally {
      clearTimeout(timer)
      if (summaryAbort === controller) summaryAbort = null
      if (mine === requestSequence) summaryBusy = false
    }
  }

  // ---- handoff ----

  async function startHandoff(): Promise<void> {
    const agent = handoffAgent
    const submitted = question || inputValue.trim()
    if (!agent || !submitted || handoffBusy) return
    const mine = requestSequence
    handoffBusy = true
    handoffRun = null
    handoffError = ''
    appendActivity('handoff', 'active', t('smartSearch.activityHandoffStart'))
    try {
      const refs = settings.smartLookup.handoff.includeSelectedRefs ? orderedHits : []
      const packet = buildHandoffPacket(submitted, null, refs)
      const start = await smartSearchApi.startHandoff(packet, agent.id, crypto.randomUUID())
      if (mine !== requestSequence) return
      handoffRun = { provider: agent.id, runId: start.runId }
      appendActivity('handoff', 'success', t('smartSearch.activityHandoffDone'), { runId: start.runId })
    } catch (error) {
      if (mine !== requestSequence) return
      handoffError = `${t('smartSearch.handoffFailed')} ${
        error instanceof AgentTaskError ? t('smartSearch.agentFailed') : redactError(error)
      }`
      appendActivity('handoff', 'error', handoffError)
    } finally {
      handoffBusy = false
    }
  }

  async function openHandoffRun(): Promise<void> {
    if (!handoffRun) return
    try {
      await invoke('plugin_v2_open_window', { pluginId: handoffRun.provider, windowId: 'main' })
    } catch (error) {
      handoffError = redactError(error)
    }
  }

  // ---- results ----

  function groupLabel(group: HitGroup): string {
    switch (group.kind) {
      case 'pinned': return t('search.group.pinned')
      case 'human': return t('search.group.human')
      case 'source': return t('search.group.source')
      case 'unlabeled': return t('search.group.unlabeled')
      case 'derivedOther': return t('search.group.other')
      case 'derivedType': return group.conceptType ?? t('search.group.other')
    }
  }

  function basename(path: string): string {
    return path.slice(path.lastIndexOf('/') + 1)
  }

  function displayTitle(hit: SearchHit): string {
    return hit.breadcrumb || basename(hit.path).replace(/\.(md|mdx|markdown)$/i, '')
  }

  function snippet(hit: SearchHit): string {
    return previewLine(hit.text, highlightTerms).text || hit.text.slice(0, 240)
  }

  function previewText(hit: SearchHit): string {
    return Array.from(hit.text.slice(0, PREVIEW_CHARS * 2)).slice(0, PREVIEW_CHARS).join('')
  }

  async function focusHit(index: number): Promise<void> {
    if (!orderedHits.length) return
    const next = Math.max(0, Math.min(index, orderedHits.length - 1))
    activeKey = hitKey(orderedHits[next])
    await tick()
    const row = listEl?.querySelector<HTMLElement>(`.result-row[data-index="${next}"]`)
    row?.focus()
    row?.scrollIntoView?.({ block: 'nearest' })
  }

  function onRowKeydown(event: KeyboardEvent, index: number): void {
    if (isImeKey(event)) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      void focusHit(index + 1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      if (index === 0) inputEl?.focus()
      else void focusHit(index - 1)
    } else if (event.key === 'Home') {
      event.preventDefault()
      void focusHit(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      void focusHit(orderedHits.length - 1)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      void openHit(orderedHits[index])
    }
  }

  async function openHit(hit: SearchHit | undefined): Promise<void> {
    if (!hit) return
    const preview = previewLine(hit.text, highlightTerms)
    openError = ''
    try {
      await invoke('editor_show_and_reveal_search_hit', {
        path: hit.absPath,
        line: Math.max(1, hit.line + preview.line),
        anchor: preview.text || hit.breadcrumb || basename(hit.path),
      })
      await invoke('hide_smart_search_window')
    } catch {
      openError = t('smartSearch.staleNavigation')
    }
  }

  // ---- input and window keys ----

  function caretOnLastLine(): boolean {
    if (!inputEl) return false
    return inputEl.selectionStart === inputEl.selectionEnd
      && !inputValue.slice(inputEl.selectionEnd ?? 0).includes('\n')
  }

  function onInputKeydown(event: KeyboardEvent): void {
    if (ime.blocks(event)) return
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void lookup()
    } else if (event.key === 'ArrowDown' && !event.shiftKey && orderedHits.length && caretOnLastLine()) {
      event.preventDefault()
      void focusHit(0)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      void hideWindow()
    }
  }

  function onWindowKeydown(event: KeyboardEvent): void {
    if (isImeKey(event) || event.key !== 'Escape' || event.defaultPrevented) return
    event.preventDefault()
    void hideWindow()
  }

  async function hideWindow(): Promise<void> {
    cancelPreview()
    closeMenu(false)
    if (lookupBusy || summaryBusy || store.loading) {
      const stage: WorkflowStage = summaryBusy ? 'summary' : 'search'
      supersede()
      store.cancel()
      appendActivity(stage, 'warning', t('smartSearch.stopped'))
    }
    try { await invoke('hide_smart_search_window') } catch { /* Browser preview. */ }
  }

  // ---- actions menu ----

  async function toggleMenu(): Promise<void> {
    if (menuOpen) { closeMenu(); return }
    menuOpen = true
    await tick()
    menuItems()[0]?.focus()
  }

  function closeMenu(restoreFocus = true): void {
    if (!menuOpen) return
    menuOpen = false
    if (restoreFocus) menuButton?.focus()
  }

  function menuItems(): HTMLButtonElement[] {
    return Array.from(menuEl?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)') ?? [])
  }

  function onMenuKeydown(event: KeyboardEvent): void {
    if (isImeKey(event)) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeMenu()
      return
    }
    if (event.key === 'Tab') { closeMenu(false); return }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const items = menuItems()
    if (!items.length) return
    const index = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? items.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
    items[next]?.focus()
  }

  function onWindowPointerDown(event: PointerEvent): void {
    if (!menuOpen) return
    const target = event.target as Node | null
    if (target && (menuEl?.contains(target) || menuButton?.contains(target))) return
    closeMenu(false)
  }

  function menuAction(action: () => unknown): void {
    closeMenu()
    void action()
  }

  async function copyText(value: string): Promise<void> {
    try {
      try {
        const { writeText } = await import('@tauri-apps/plugin-clipboard-manager')
        await writeText(value)
      } catch {
        await navigator.clipboard.writeText(value)
      }
      copyStatus = t('smartSearch.copyDone')
    } catch {
      copyStatus = t('smartSearch.copyFailed')
    }
    clearTimeout(copyTimer)
    copyTimer = setTimeout(() => { copyStatus = '' }, 2_500)
  }
</script>

<svelte:window onkeydown={onWindowKeydown} onpointerdown={onWindowPointerDown} />

<main class="lookup">
  <section class="query-bar" aria-label={t('smartSearch.windowTitle')}>
    <textarea
      bind:this={inputEl}
      bind:value={inputValue}
      class="query-input"
      rows="1"
      placeholder={t('smartSearch.placeholder')}
      aria-label={t('smartSearch.placeholder')}
      oninput={onInput}
      onkeydown={onInputKeydown}
      oncompositionstart={onCompositionStart}
      oncompositionend={onCompositionEnd}
      onblur={() => ime.reset()}
    ></textarea>
    <p class="hint">{t('smartSearch.inputHint')}</p>
  </section>

  {#if mode === 'idle'}
    <div class="empty-launch">
      <h1>{t('smartSearch.emptyTitle')}</h1>
      <p>{t('smartSearch.emptyPrompt')}</p>
    </div>
  {:else}
    <section class="workspace">
      <aside class="results-pane" aria-label={t('smartSearch.results')}>
        <header class="pane-header">
          <strong>{mode === 'lookup' ? t('smartSearch.localResults') : t('smartSearch.quickPreview')}</strong>
          <span>{t('smartSearch.resultsCount', { n: orderedHits.length })}</span>
          <div class="menu-anchor">
            <button
              bind:this={menuButton}
              class="icon-button more-actions"
              aria-label={t('smartSearch.moreActions')}
              title={t('smartSearch.moreActions')}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onclick={() => void toggleMenu()}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>
            </button>
            {#if menuOpen}
              <div class="menu-popover">
                <div
                  bind:this={menuEl}
                  class="menu-panel actions-menu"
                  role="menu"
                  tabindex="-1"
                  aria-label={t('smartSearch.moreActions')}
                  onkeydown={onMenuKeydown}
                >
                  {#if activeHit}
                    {@const hit = activeHit}
                    <button class="menu-row" role="menuitem" tabindex="-1" onclick={() => menuAction(() => copyText(hitReference(hit)))}>{t('smartSearch.copyRef')}</button>
                  {/if}
                  {#if canExpand}
                    <button class="menu-row" role="menuitem" tabindex="-1" disabled={lookupBusy} onclick={() => menuAction(() => lookup(true))}>{t('smartSearch.expandSearch')}</button>
                  {/if}
                  <button
                    class="menu-row summary-action"
                    role="menuitem"
                    tabindex="-1"
                    disabled={!canSummarize}
                    aria-describedby={summaryHint ? 'summary-hint' : undefined}
                    onclick={() => menuAction(generateSummary)}
                  >{t('smartSearch.generateSummary')}</button>
                  <button
                    class="menu-row handoff-action"
                    role="menuitem"
                    tabindex="-1"
                    disabled={!canHandoff}
                    title={handoffAgent ? (handoffAgent.harness?.harness || handoffAgent.name) : undefined}
                    onclick={() => menuAction(startHandoff)}
                  >{t('smartSearch.handoff')}</button>
                  {#if activity.length}
                    <button class="menu-row" role="menuitem" tabindex="-1" onclick={() => menuAction(() => copyText(formatWorkflowLog(activity)))}>{t('smartSearch.copyActivity')}</button>
                  {/if}
                </div>
                {#if summaryHint}
                  <p id="summary-hint" class="menu-hint">{summaryHint}</p>
                {/if}
              </div>
            {/if}
          </div>
        </header>
        <div class="results-scroll" aria-busy={lookupBusy || store.loading}>
          {#if store.error}
            <div class="state error" role="alert">
              <strong>{t('smartSearch.searchError')}</strong>
              <p>{store.error}</p>
              <button class="secondary-button" onclick={() => void lookup()}>{t('smartSearch.retry')}</button>
            </div>
          {:else if (lookupBusy || store.loading) && !orderedHits.length}
            <div class="state"><span class="spinner" aria-hidden="true"></span><p>{t('smartSearch.searching')}</p></div>
          {:else if !orderedHits.length}
            <div class="state">
              <strong>{t('search.noResults')}</strong>
              <p>{t('smartSearch.noResultsHint')}</p>
            </div>
          {:else}
            <div bind:this={listEl} class="result-list" role="listbox" aria-label={t('smartSearch.results')}>
              {#each sections as section (section.key)}
                <div class="result-group" role="group" aria-label={section.label}>
                  <div class="group-label" aria-hidden="true">{section.label}<span>{section.hits.length}</span></div>
                  {#each section.hits as hit (hitKey(hit))}
                    {@const index = orderedHits.indexOf(hit)}
                    {@const active = activeHit === hit}
                    <div
                      class="result-row"
                      class:active
                      role="option"
                      aria-selected={active}
                      tabindex={active ? 0 : -1}
                      data-index={index}
                      onclick={() => { activeKey = hitKey(hit) }}
                      ondblclick={() => void openHit(hit)}
                      onkeydown={(event) => onRowKeydown(event, index)}
                    >
                      <strong class="result-title">{displayTitle(hit)}</strong>
                      <p class="result-snippet">{#each highlightParts(snippet(hit), highlightTerms) as part}{#if part.hit}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}</p>
                    </div>
                  {/each}
                </div>
              {/each}
            </div>
          {/if}
        </div>
      </aside>

      <article class="preview-pane" aria-label={t('smartSearch.currentResult')}>
        <header class="pane-header preview-header">
          <strong>{t('smartSearch.previewTab')}</strong>
          {#if activeHit}
            {@const hit = activeHit}
            <button class="text-button" onclick={() => void openHit(hit)}>{t('smartSearch.openEditor')} ↗</button>
          {/if}
        </header>
        <div class="preview-scroll">
          {#if openError}<p class="notice error" role="alert">{openError}</p>{/if}
          {#if summaryError}
            <p class="notice error summary-error" role="alert">{t('smartSearch.summaryUnavailable')} {summaryError}</p>
          {/if}
          {#if summaryText}
            <section class="answer" aria-label={t('smartSearch.quickSummary')}>
              <header><strong>{t('smartSearch.quickSummary')}</strong><small>{t('smartSearch.basedOnMatches')}</small></header>
              <p class="answer-body">{summaryText}</p>
              {#if summarySources.length}
                <div class="answer-sources">
                  {#each summarySources as source (source.id)}
                    <button class="text-button" onclick={() => void openHit(store.hits.find((candidate) => candidate.path === source.path && candidate.line === source.line))}>[{source.id}] {basename(source.path)}</button>
                  {/each}
                </div>
              {/if}
            </section>
          {/if}
          {#if handoffRun || handoffError}
            <p class="notice handoff-status" role={handoffError ? 'alert' : undefined}>
              {#if handoffError}{handoffError}{:else}
                {t('smartSearch.activityHandoffDone')}
                <button class="text-button" onclick={() => void openHandoffRun()}>{t('smartSearch.openAgentRun')} ↗</button>
              {/if}
            </p>
          {/if}
          {#if activeHit}
            <div class="preview-location">{hitReference(activeHit)}</div>
            <h1 class="preview-title">{displayTitle(activeHit)}</h1>
            {#if activeHit.level !== 'line' || activeHit.text.length > PREVIEW_CHARS}
              <p class="preview-note">{t('smartSearch.previewLimited')}</p>
            {/if}
            <p class="preview-text">{#each highlightParts(previewText(activeHit), highlightTerms) as part}{#if part.hit}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}</p>
          {:else}
            <p class="state">{t('smartSearch.previewHint')}</p>
          {/if}
        </div>
      </article>
    </section>
  {/if}

  <footer class="activity" role="status" aria-label={t('smartSearch.activityTitle')}>
    {#if working}<span class="spinner" aria-hidden="true"></span>{/if}
    <span class="activity-text">{activityText}</span>
    <span class="copy-status">{copyStatus}</span>
  </footer>
</main>

<style>
  :global(:root) {
    --lookup-accent: #0869ed;
    --lookup-border: color-mix(in srgb, CanvasText 12%, transparent);
    --lookup-muted: color-mix(in srgb, CanvasText 60%, transparent);
    --lookup-soft: color-mix(in srgb, CanvasText 4%, transparent);
  }
  button, textarea { font: inherit; color: inherit; }
  button:disabled { opacity: .4; }
  button:focus-visible, .result-row:focus-visible, textarea:focus-visible {
    outline: 3px solid color-mix(in srgb, var(--lookup-accent) 55%, transparent);
    outline-offset: 1px;
  }
  .lookup { height: 100vh; display: flex; flex-direction: column; background: Canvas; color: CanvasText; overflow: hidden; }
  .query-bar { flex: 0 0 auto; padding: 16px 18px 8px; }
  .query-input {
    box-sizing: border-box; width: 100%; resize: none; min-height: 40px; max-height: 96px;
    padding: 9px 12px; border: 1px solid var(--lookup-border); border-radius: 10px;
    background: Canvas; font-size: 16px; line-height: 1.45; overflow-y: auto;
  }
  .hint { margin: 6px 2px 0; font-size: 11px; color: var(--lookup-muted); }
  .empty-launch { flex: 1; display: flex; flex-direction: column; justify-content: center; align-items: center; padding: 24px; text-align: center; }
  .empty-launch h1 { font-size: 19px; font-weight: 600; margin: 0 0 8px; }
  .empty-launch p { margin: 0; max-width: 380px; color: var(--lookup-muted); font-size: 13px; line-height: 1.6; }
  .workspace { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(260px, 42%) minmax(0, 1fr); border-top: 1px solid var(--lookup-border); }
  .results-pane, .preview-pane { min-width: 0; min-height: 0; display: flex; flex-direction: column; }
  .results-pane { border-right: 1px solid var(--lookup-border); }
  .pane-header { flex: 0 0 auto; min-height: 40px; display: flex; align-items: center; gap: 8px; padding: 0 12px 0 16px; border-bottom: 1px solid var(--lookup-border); }
  .pane-header strong { margin-right: auto; font-size: 12px; font-weight: 600; }
  .pane-header > span { color: var(--lookup-muted); font-size: 11px; white-space: nowrap; }
  .menu-anchor { position: relative; }
  .icon-button { display: grid; place-items: center; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 6px; background: transparent; color: var(--lookup-muted); }
  .icon-button:hover { background: var(--lookup-soft); }
  .menu-popover { position: absolute; right: 0; top: calc(100% + 4px); z-index: 10; width: max-content; max-width: 280px; }
  .actions-menu { display: flex; flex-direction: column; }
  .actions-menu .menu-row { border: 0; background: transparent; text-align: left; min-height: 26px; }
  .menu-hint { margin: 4px 0 0; padding: 6px 9px; border-radius: 8px; background: Canvas; border: 1px solid var(--lookup-border); color: var(--lookup-muted); font-size: 11px; line-height: 1.45; white-space: normal; }
  .results-scroll, .preview-scroll { flex: 1; min-height: 0; overflow-y: auto; }
  .result-group { padding: 6px 0; }
  .group-label { display: flex; gap: 6px; padding: 4px 16px; font-size: 11px; font-weight: 600; color: var(--lookup-muted); }
  .result-row { padding: 7px 16px; border-left: 3px solid transparent; cursor: default; }
  .result-row.active { background: color-mix(in srgb, var(--lookup-accent) 9%, Canvas); border-left-color: var(--lookup-accent); }
  .result-title { display: block; font-size: 13px; font-weight: 550; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .result-snippet { margin: 2px 0 0; font-size: 12px; line-height: 1.45; color: var(--lookup-muted); display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  mark { background: color-mix(in srgb, #f5c518 40%, transparent); color: inherit; border-radius: 2px; }
  .state { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 32px 20px; text-align: center; font-size: 13px; color: var(--lookup-muted); }
  .state strong { color: CanvasText; }
  .state p { margin: 0; }
  .state.error strong { color: #b42318; }
  .secondary-button { margin-top: 6px; padding: 5px 12px; border: 1px solid var(--lookup-border); border-radius: 7px; background: var(--lookup-soft); }
  .text-button { padding: 2px 4px; border: 0; background: transparent; color: var(--lookup-accent); font-size: 12px; }
  .preview-scroll { padding: 14px 18px; }
  .preview-location { font-size: 11px; color: var(--lookup-muted); word-break: break-all; }
  .preview-title { margin: 4px 0 10px; font-size: 16px; font-weight: 600; }
  .preview-note { margin: 0 0 8px; font-size: 12px; color: var(--lookup-muted); }
  .preview-text { margin: 0; font-size: 13px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
  .notice { margin: 0 0 12px; padding: 8px 10px; border-radius: 8px; background: var(--lookup-soft); font-size: 12px; line-height: 1.5; }
  .notice.error { background: color-mix(in srgb, #ce3030 8%, Canvas); }
  .answer { margin: 0 0 14px; padding: 10px 12px; border: 1px solid var(--lookup-border); border-radius: 10px; }
  .answer header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; font-size: 12px; }
  .answer small { color: var(--lookup-muted); font-size: 11px; }
  .answer-body { margin: 8px 0 6px; font-size: 13px; line-height: 1.6; white-space: pre-wrap; }
  .answer-sources { display: flex; flex-wrap: wrap; gap: 4px; }
  .activity { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; min-height: 28px; padding: 0 16px; border-top: 1px solid var(--lookup-border); font-size: 11px; color: var(--lookup-muted); }
  .activity-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .spinner { display: inline-block; flex-shrink: 0; width: 11px; height: 11px; border: 2px solid color-mix(in srgb, var(--lookup-accent) 18%, transparent); border-top-color: var(--lookup-accent); border-radius: 50%; animation: spin .8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (max-width: 560px) {
    .workspace { grid-template-columns: 1fr; grid-template-rows: minmax(0, 1fr) minmax(0, 1fr); }
    .results-pane { border-right: 0; border-bottom: 1px solid var(--lookup-border); }
  }
</style>
