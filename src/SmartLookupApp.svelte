<script lang="ts">
  // Smart Lookup window. Local-first: typing previews and Enter both read the
  // local index at once. After an Enter the host may judge the candidates (one
  // request at most, reordering inside sections only) or, on zero hits, suggest
  // other wording; both are bound to the lookup run the host retained.
  import './styles/app.css'
  import { onDestroy, onMount, tick } from 'svelte'
  import { invoke } from '@tauri-apps/api/core'
  import { getCurrentWindow } from '@tauri-apps/api/window'
  import { loadLocale, t, watchLocaleChanges } from './lib/i18n/store.svelte'
  import type { SearchHit, SmartSearchHit, SmartSearchResponse } from './lib/search/api'
  import type { HitGroup } from './lib/search/grouping'
  import { decideTrigger } from './lib/search/input-trigger'
  import { highlightParts, parseHighlightTerms, previewLine } from './lib/search/preview'
  import { createImeGuard, isImeKey } from './lib/ime'
  import { isApplePlatformSync } from './lib/platform-sync'
  import { loadSettings, saveSettings, settings } from './lib/settings.svelte'
  import { SmartSearchStore } from './lib/smart-search/store.svelte'
  import {
    smartSearchApi,
    type Diagnosis,
    type JudgeResult,
    type RepairSuggestion,
    type TermGroup,
    type TimeMode,
    type TimeWindow,
    type Trigger,
  } from './lib/smart-search/api'
  import { hitKey } from './lib/smart-search/hit-key'
  import {
    dateSections,
    hitReference,
    redactError,
    sourceSections,
    type ResultSection,
  } from './lib/smart-search/lookup-view'
  import {
    applyOrder,
    chatRequestConfig,
    headerMessage,
    headerOnArrival,
    jevRequestConfig,
    judgingCount,
    judgingMessage,
    movedFrom,
    noMatchAttempts,
    sectionBreaks,
    shouldAutoRepair,
    tiersById,
    type DegradedStatus,
    type HeaderMessage,
    type HeaderState,
    type JudgeTicket,
    type LookupAttempt,
  } from './lib/smart-search/enhance-flow'
  import { clearRecent, loadRecent, rememberRecent } from './lib/smart-search/recent'
  import { OPEN_SETTINGS_TAB_EVENT, type SmartLookupSettings } from './lib/smart-search/settings'
  import {
    appendWorkflowEntry,
    formatWorkflowLog,
    type WorkflowEntry,
    type WorkflowLevel,
    type WorkflowStage,
  } from './lib/smart-search/workflow-log'

  /** `preview`: live typing results. `lookup`: the result of an Enter. */
  type ResultsMode = 'idle' | 'preview' | 'lookup'
  /** The judge or repair request the host is working on; `token` tells a newer one from an older one. */
  type Inflight = { runId: string; kind: 'judge' | 'repair'; token: number }
  type RepairStrip = { inputs: string[]; counts: number[] | null; error: string }
  type Attempts = { original: { hits: number; tookMs: number }; rephrased: LookupAttempt | null; scan: LookupAttempt | null }

  const PREVIEW_CHARS = 3_000
  const TIME_OPTIONS: ReadonlyArray<readonly [TimeMode, 'smartSearch.enhance.timeGroup' | 'smartSearch.enhance.timeWindow' | 'smartSearch.enhance.timeIgnore']> = [
    ['group', 'smartSearch.enhance.timeGroup'],
    ['window', 'smartSearch.enhance.timeWindow'],
    ['ignore', 'smartSearch.enhance.timeIgnore'],
  ]
  const WORDING_SLOTS = 2
  const isMac = isApplePlatformSync()
  const actionsShortcut = isMac ? '⌘K' : 'Ctrl+K'
  const restoreShortcut = isMac ? '⌘Z' : 'Ctrl+Z'

  const store = new SmartSearchStore()
  const appWindow = getCurrentWindow()
  const ime = createImeGuard()

  let inputValue = $state('')
  let inputEl = $state<HTMLTextAreaElement>()
  let listEl = $state<HTMLDivElement>()
  let menuEl = $state<HTMLDivElement>()
  let menuButton = $state<HTMLButtonElement>()
  let timeChipEl = $state<HTMLButtonElement>()
  let composing = false
  let previewTimer: ReturnType<typeof setTimeout> | undefined

  let ready = $state(false)
  let mode = $state<ResultsMode>('idle')
  let question = $state('')
  let lookupBusy = $state(false)
  let lookupRunId = $state('')
  let activeKey = $state<string | null>(null)
  let menuOpen = $state(false)
  let openError = $state('')
  let recent = $state<string[]>(loadRecent())

  // Conditions of the current Enter.
  let lookupTime = $state<TimeWindow | null>(null)
  /** Sent only after the user picked a time option; cleared for a new question. */
  let chosenTimeMode = $state<TimeMode | undefined>(undefined)
  let timeMenuOpen = $state(false)

  // Judging.
  let header = $state<HeaderState>({ kind: 'none' })
  let judgeResult = $state<JudgeResult | null>(null)
  let judgedRunId = ''
  /** The judged order currently shown; `null` = local order. */
  let appliedOrder = $state<string[] | null>(null)
  let detailsOpen = $state(false)
  let feedbackSaved = $state<Record<string, 'fit' | 'unfit'>>({})
  let now = $state(Date.now())
  let clockTimer: ReturnType<typeof setInterval> | undefined
  /** Arrow keys, a click on a row, scrolling the list or opening a result since this Enter. */
  let interacted = false
  let judgeTicket: JudgeTicket | null = null
  let judgeSeq = 0

  // Zero hits and repair.
  let diagnosis = $state<Diagnosis | null>(null)
  let attempts = $state<Attempts | null>(null)
  let strip = $state<RepairStrip | null>(null)
  let repairBusy = $state(false)
  let repairNotice = $state<HeaderMessage | null>(null)
  let repaired = $state(false)
  /** 1-based wording numbers per hit (`hitKey`), from a regrouped search. */
  let hitGroups = $state<Map<string, number[]>>(new Map())

  let inflight: Inflight | null = null
  let enhanceToken = 0
  /** Diagnose and regrouped searches share the window's search ticket: never run two at once. */
  let hostChain: Promise<unknown> = Promise.resolve()

  let activity = $state<WorkflowEntry[]>([])
  let activitySequence = 0
  let startedAt = 0
  let copyStatus = $state('')
  let copyTimer: ReturnType<typeof setTimeout> | undefined

  /** Bumped by every new lookup, preview or stop; stale async work compares against it. */
  let requestSequence = 0
  let destroyed = false
  const cleanups: Array<() => void> = []

  let highlightTerms = $derived(parseHighlightTerms(mode === 'lookup' ? question : store.query))
  let baseSections = $derived(buildSections(store.hits, mode === 'lookup' ? lookupTime : null, settings.smartLookup.results.groupBy))
  let localHits = $derived(baseSections.flatMap((section) => section.hits))
  let sections = $derived(appliedOrder ? applyOrder(baseSections, appliedOrder) : baseSections)
  let orderedHits = $derived(sections.flatMap((section) => section.hits))
  let activeHit = $derived(orderedHits.find((hit) => hitKey(hit) === activeKey) ?? orderedHits[0] ?? null)
  let tiers = $derived(tiersById(judgeResult))
  let moved = $derived(appliedOrder && judgeResult
    ? movedFrom(localHits.map((hit) => resultIdOf(hit) ?? ''), appliedOrder, new Set(tiers.keys()))
    : new Map<string, { from: number; direction: 'up' | 'down' }>())
  let struckTerms = $derived((diagnosis?.terms ?? []).filter((term) => term.hits === 0).map((term) => term.term))
  let canExpand = $derived(Boolean(lookupRunId) && (store.hits.length === 0 || store.deepAvailable))
  let working = $derived(lookupBusy || store.loading || repairBusy)
  let activityText = $derived(
    repairBusy ? t('smartSearch.enhance.repairing')
      : lookupBusy || store.loading ? t('smartSearch.searching')
        : activity.at(-1)?.message ?? '',
  )
  let showConditions = $derived(mode === 'lookup' && !store.error && Boolean(lookupRunId))
  /** The judging criterion; regrouped (repaired) results are never judged. */
  let showCriterion = $derived(settings.smartLookup.enhance.enabled && !repaired && store.hits.length > 0)
  let headerText = $derived(headerLine(header, now))
  let showJudgeHeader = $derived(mode === 'lookup' && (headerText !== '' || repairBusy || repairNotice !== null))
  let attemptRows = $derived(attempts ? noMatchAttempts(attempts.original, attempts.rephrased, attempts.scan) : [])

  $effect(() => {
    const title = t('smartSearch.windowTitle')
    void appWindow.setTitle(title).catch(() => {})
  })

  $effect(() => {
    // The judging header shows seconds; tick only while judging.
    if (header.kind !== 'judging') return
    now = Date.now()
    const timer = setInterval(() => { now = Date.now() }, 1_000)
    clockTimer = timer
    return () => clearInterval(timer)
  })

  onMount(() => {
    void initialise()
  })

  onDestroy(() => {
    destroyed = true
    cancelPreview()
    clearTimeout(copyTimer)
    clearInterval(clockTimer)
    supersede()
    for (const cleanup of cleanups.splice(0)) cleanup()
  })

  function keep(cleanup: () => void): void {
    if (destroyed) cleanup()
    else cleanups.push(cleanup)
  }

  async function initialise(): Promise<void> {
    try {
      await Promise.all([loadLocale(), loadSettings()])
      keep(await watchLocaleChanges())
    } catch { /* Defaults stay in effect; lookup still works. */ }
    ready = true
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

  // ---- in-flight work ----

  function cancelPreview(): void {
    if (previewTimer) clearTimeout(previewTimer)
    previewTimer = undefined
  }

  /** Make every running lookup, preview, judgement and repair stale; cancel the host request. */
  function supersede(): number {
    requestSequence += 1
    lookupBusy = false
    stopEnhanceRequest()
    return requestSequence
  }

  /** Cancel the judge or repair request in flight (if any); returns it. */
  function stopEnhanceRequest(): Inflight | null {
    const current = inflight
    inflight = null
    judgeTicket = null
    repairBusy = false
    if (current) void smartSearchApi.cancel(current.runId).catch(() => {})
    return current
  }

  function serial<T>(work: () => Promise<T>): Promise<T> {
    const next = hostChain.then(work, work)
    hostChain = next.catch(() => {})
    return next
  }

  function resetDerivedWork(): void {
    lookupRunId = ''
    openError = ''
  }

  function resetJudgement(): void {
    header = { kind: 'none' }
    judgeResult = null
    judgedRunId = ''
    appliedOrder = null
    detailsOpen = false
    feedbackSaved = {}
  }

  function resetRepair(): void {
    diagnosis = null
    attempts = null
    strip = null
    repairNotice = null
    repaired = false
    hitGroups = new Map()
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
    closePopovers()
    supersede()
    resetDerivedWork()
    resetJudgement()
    resetRepair()
    resetActivity()
    lookupTime = null
    if (decision.kind === 'clear') {
      store.clear()
      mode = 'idle'
      question = ''
      activeKey = null
      recent = loadRecent()
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

  // ---- sections ----

  function resultIdOf(hit: SearchHit): string | undefined {
    return (hit as SmartSearchHit).resultId
  }

  /** Two time sections when the host grouped by a time phrase; otherwise source or date sections. */
  function buildSections(hits: SearchHit[], time: TimeWindow | null, groupBy: SmartLookupSettings['results']['groupBy']): ResultSection[] {
    if (time && time.mode === 'group' && time.inWindow > 0) {
      const split = Math.min(time.inWindow, hits.length)
      const result: ResultSection[] = [{ key: 'time:in', label: t('smartSearch.enhance.timeInRange'), hits: hits.slice(0, split) }]
      if (split < hits.length) result.push({ key: 'time:other', label: t('smartSearch.enhance.timeOther'), hits: hits.slice(split) })
      return result
    }
    return groupBy === 'date'
      ? dateSections(hits, t('smartSearch.dateUnknown'))
      : sourceSections(hits, groupLabel)
  }

  // ---- lookup (Enter), expanded lookup, time options ----

  /**
   * Starts a new result set for `submitted`. `keepZeroState` keeps the
   * diagnosis and the no-match attempts (expanding a zero-hit lookup).
   */
  function beginLookup(submitted: string, options: { keepActivity?: boolean; keepZeroState?: boolean } = {}): number {
    cancelPreview()
    closeMenu(false)
    closePopovers()
    const mine = supersede()
    store.cancel()
    resetDerivedWork()
    resetJudgement()
    const keptDiagnosis = diagnosis
    const keptAttempts = attempts
    resetRepair()
    if (options.keepZeroState) {
      diagnosis = keptDiagnosis
      attempts = keptAttempts
    }
    if (options.keepActivity) startedAt = performance.now()
    else resetActivity()
    interacted = false
    question = submitted
    mode = 'lookup'
    return mine
  }

  /** Enter. */
  async function submitLookup(): Promise<void> {
    const submitted = inputValue.trim()
    if (!submitted) return
    if (submitted !== question) chosenTimeMode = undefined
    recent = rememberRecent(submitted)
    const mine = beginLookup(submitted)
    const first = await runLocal(mine, submitted, false)
    if (!first) return
    attempts = { original: { hits: first.hits, tookMs: first.tookMs }, rephrased: null, scan: null }
    if (first.hits > 0) {
      await judgeLookup(mine, 'auto')
      return
    }
    await afterZeroHits(mine, settings.smartLookup.results.autoDeepOnZero)
  }

  /** Expand search: the existing deep lookup, as a new run. */
  async function expandLookup(): Promise<void> {
    const submitted = question
    if (!submitted) return
    const mine = beginLookup(submitted, { keepActivity: true, keepZeroState: true })
    const scan = await runLocal(mine, submitted, true)
    if (!scan) return
    if (attempts) attempts = { ...attempts, scan: { kind: 'scan', hits: scan.hits, tookMs: scan.tookMs } }
    if (scan.hits > 0) await judgeLookup(mine, 'user')
  }

  /** The time chip: search locally again with that time mode; never judges or repairs. */
  async function chooseTimeMode(timeMode: TimeMode): Promise<void> {
    timeMenuOpen = false
    const submitted = question
    if (!submitted) return
    chosenTimeMode = timeMode
    const mine = beginLookup(submitted, { keepActivity: true })
    const result = await runLocal(mine, submitted, false)
    if (result) attempts = { original: { hits: result.hits, tookMs: result.tookMs }, rephrased: null, scan: null }
    timeChipEl?.focus()
  }

  /** One `smart_lookup_local` call; shows its result. `null` when stale or failed. */
  async function runLocal(mine: number, submitted: string, deep: boolean): Promise<{ hits: number; tookMs: number } | null> {
    lookupBusy = true
    if (deep) appendActivity('search', 'active', t('smartSearch.activityDeepStart'))
    const limit = settings.smartLookup.results.limit
    const timeMode = chosenTimeMode ? { timeMode: chosenTimeMode } : {}
    try {
      const result = await smartSearchApi.localLookup(submitted, deep
        ? { limit, deep: true, timeoutMs: settings.smartLookup.results.deepTimeoutMs, ...timeMode }
        : { limit, deep: false, ...timeMode })
      if (mine !== requestSequence) return null
      showSearch(submitted, result.search, result.lookupRunId, result.time ?? null)
      logSearch(result.search)
      return { hits: result.search.hits.length, tookMs: result.search.tookMs }
    } catch (error) {
      if (mine !== requestSequence) return null
      const message = redactError(error)
      store.fail(submitted, message)
      activeKey = null
      appendActivity('search', 'error', `${t('smartSearch.searchError')}: ${message}`)
      return null
    } finally {
      if (mine === requestSequence) lookupBusy = false
    }
  }

  function showSearch(submitted: string, search: SmartSearchResponse, runId: string, time: TimeWindow | null, groups?: number[][]): void {
    store.apply(submitted, search)
    lookupRunId = runId
    lookupTime = time
    hitGroups = groups ? new Map(search.hits.map((hit, index) => [hitKey(hit), groups[index] ?? []])) : new Map()
    activeKey = orderedHits[0] ? hitKey(orderedHits[0]) : null
  }

  function logSearch(search: SmartSearchResponse): void {
    const n = search.hits.length
    const docs = new Set(search.hits.map((hit) => hit.path)).size
    appendActivity(
      'search',
      search.truncated ? 'warning' : 'success',
      t(search.truncated ? 'smartSearch.activitySearchPartial' : 'smartSearch.activitySearchDone', { n, docs }),
    )
  }

  /** Zero hits: diagnose locally, optionally search more broadly, then repair once if a model is set up. */
  async function afterZeroHits(mine: number, allowDeep: boolean): Promise<void> {
    const runId = lookupRunId
    const found = await serial(() => smartSearchApi.diagnose(runId)).catch(() => null)
    if (mine !== requestSequence) return
    diagnosis = found ?? null
    if (allowDeep) {
      // "Search more broadly when nothing is found": one deep lookup, a new run.
      const scan = await runLocal(mine, question, true)
      if (!scan) return
      if (attempts) attempts = { ...attempts, scan: { kind: 'scan', hits: scan.hits, tookMs: scan.tookMs } }
      if (scan.hits > 0) {
        await judgeLookup(mine, 'auto')
        return
      }
    }
    const keys = await smartSearchApi.keyStatus().catch(() => null)
    if (mine !== requestSequence || !keys) return
    if (shouldAutoRepair(store.hits.length, settings.smartLookup, keys)) await repairLookup(mine, 'auto')
  }

  // ---- judging ----

  function headerLine(state: HeaderState, at: number): string {
    if (state.kind === 'judging') {
      const message = judgingMessage(state, at)
      return t(message.key, message.params)
    }
    const message = headerMessage(state)
    return message ? t(message.key, message.params) : ''
  }

  async function judgeLookup(mine: number, trigger: Trigger): Promise<void> {
    if (mine !== requestSequence || mode !== 'lookup' || repaired) return
    const current = settings.smartLookup
    if (!current.enhance.enabled) return
    if (!current.enhance.jev.url.trim()) {
      // Computed here: no host call without an endpoint.
      header = { kind: 'degraded', status: 'notConfigured', host: null, statusClass: null, missing: 'url' }
      return
    }
    const local = localHits
    const displayOrder = local.map(resultIdOf)
    if (!displayOrder.length || displayOrder.some((id) => !id)) return
    const runId = lookupRunId
    stopEnhanceRequest()
    const ticket: JudgeTicket = { lookupRunId: runId, seq: ++judgeSeq }
    judgeTicket = ticket
    inflight = { runId, kind: 'judge', token: ++enhanceToken }
    header = { kind: 'judging', count: judgingCount(local), startedAt: Date.now() }
    detailsOpen = false
    let result: JudgeResult
    try {
      result = await smartSearchApi.judge(runId, displayOrder as string[], sectionBreaks(baseSections), jevRequestConfig(current), trigger)
    } catch (error) {
      if (judgeTicket !== ticket) return
      judgeTicket = null
      inflight = null
      header = { kind: 'none' }
      appendActivity('judge', 'error', `judge failed: ${redactError(error)}`)
      return
    }
    const next = headerOnArrival(judgeTicket, ticket, result, interacted)
    if (!next || mine !== requestSequence) return
    judgeTicket = null
    inflight = null
    header = next
    if (result.status === 'ok') {
      judgeResult = result
      judgedRunId = runId
      if (!interacted && result.rerankedCount > 0 && next.kind !== 'pending') {
        appliedOrder = result.order
        // Nothing was chosen yet, so the new top result becomes the current one.
        activeKey = orderedHits[0] ? hitKey(orderedHits[0]) : null
      }
    }
    appendActivity('judge', activityLevel(result.status), judgeLog(result), { usage: result.usage })
  }

  function activityLevel(status: JudgeResult['status']): WorkflowLevel {
    return status === 'ok' || status === 'skipped' ? 'success' : 'warning'
  }

  /** Status and counts only: never remote text, never the host. */
  function judgeLog(result: JudgeResult): string {
    const reason = result.skipReason ? ` (${result.skipReason})` : ''
    const code = result.statusClass ? ` ${result.statusClass}` : ''
    return `judge ${result.status}${reason}${code} · judged ${result.judgedCount} · reranked ${result.rerankedCount}`
      + ` · requests ${result.requestCount}${result.reused ? ' (reused)' : ''} · ${result.elapsedMs} ms`
  }

  function repairLog(result: RepairSuggestion): string {
    const reason = result.skipReason ? ` (${result.skipReason})` : ''
    const code = result.statusClass ? ` ${result.statusClass}` : ''
    return `repair ${result.status}${reason}${code} · groups ${result.groups.length}`
      + ` · requests ${result.requestCount} · ${result.elapsedMs} ms`
  }

  function stopJudging(): void {
    if (header.kind !== 'judging') return
    stopEnhanceRequest()
    header = cancelledHeader()
    appendActivity('judge', 'warning', 'judge cancelled')
  }

  function cancelledHeader(): HeaderState {
    return { kind: 'degraded', status: 'cancelled', host: null, statusClass: null, missing: null }
  }

  function markInteracted(): void {
    if (mode === 'lookup') interacted = true
  }

  async function applyJudgement(): Promise<void> {
    if (header.kind !== 'pending') return
    const result = header.result
    appliedOrder = result.order
    header = { kind: 'judged', result }
    await refocusActive()
  }

  async function restoreLocalOrder(): Promise<void> {
    if (!appliedOrder || !judgeResult) return
    appliedOrder = null
    header = { kind: 'pending', result: judgeResult }
    detailsOpen = false
    await refocusActive()
  }

  /** The selection is a `hitKey`, so it survives a reorder; move focus to its new row. */
  async function refocusActive(): Promise<void> {
    await tick()
    const index = activeHit ? orderedHits.indexOf(activeHit) : -1
    if (index < 0) return
    const row = listEl?.querySelector<HTMLElement>(`.result-row[data-index="${index}"]`)
    row?.focus()
    row?.scrollIntoView?.({ block: 'nearest' })
  }

  /** Change the stored lookup settings from this window: re-read first so other fields are not overwritten with stale values. */
  async function persistSmartLookup(change: (value: SmartLookupSettings) => void): Promise<void> {
    change(settings.smartLookup)
    try {
      await loadSettings()
      change(settings.smartLookup)
      await saveSettings()
    } catch { /* The in-memory value still applies to this window. */ }
  }

  async function allowHost(host: string | null): Promise<void> {
    if (!host) return
    const mine = requestSequence
    await persistSmartLookup((value) => { value.enhance.jev.consentHost = host })
    await judgeLookup(mine, 'user')
  }

  async function openEnhanceSettings(): Promise<void> {
    try {
      const { emitTo } = await import('@tauri-apps/api/event')
      await emitTo('main', OPEN_SETTINGS_TAB_EVENT, { tab: 'enhance' })
    } catch { /* Browser preview has no event bridge. */ }
  }

  async function correct(hit: SearchHit, verdict: 'fit' | 'unfit'): Promise<void> {
    const id = resultIdOf(hit)
    const runId = judgedRunId
    if (!id || !runId) return
    try {
      await smartSearchApi.feedback(runId, id, verdict)
      feedbackSaved = { ...feedbackSaved, [id]: verdict }
    } catch (error) {
      appendActivity('judge', 'error', `feedback failed: ${redactError(error)}`)
    }
  }

  // ---- repair ----

  function formatGroup(group: TermGroup): string {
    return [...group.terms, ...group.phrases.map((phrase) => `"${phrase}"`)].join(' ')
  }

  /** Words separated by spaces; a phrase in double quotes. */
  function parseGroup(text: string): TermGroup {
    const phrases: string[] = []
    const rest = text.replace(/"([^"]*)"/g, (_match, phrase: string) => {
      const value = phrase.trim().replace(/\s+/g, ' ')
      if (value) phrases.push(value)
      return ' '
    })
    return { terms: rest.split(/\s+/).map((term) => term.replace(/"/g, '')).filter(Boolean), phrases }
  }

  function openStrip(groups: TermGroup[]): void {
    const inputs = Array.from({ length: WORDING_SLOTS }, (_, index) => (groups[index] ? formatGroup(groups[index]) : ''))
    strip = { inputs, counts: null, error: '' }
  }

  function editWording(): void {
    openStrip([{ terms: store.extractedTerms.slice(0, 6), phrases: [] }])
  }

  async function repairLookup(mine: number, trigger: Trigger): Promise<void> {
    const runId = lookupRunId
    if (!runId) return
    stopEnhanceRequest()
    const token = ++enhanceToken
    inflight = { runId, kind: 'repair', token }
    repairBusy = true
    repairNotice = null
    let result: RepairSuggestion | null = null
    let failure = ''
    try {
      result = await smartSearchApi.repairSuggest(runId, chatRequestConfig(settings.smartLookup), trigger)
    } catch (error) {
      failure = redactError(error)
    }
    if (inflight?.token !== token || mine !== requestSequence) return
    inflight = null
    repairBusy = false
    if (!result) {
      appendActivity('repair', 'error', `repair failed: ${failure}`)
      return
    }
    appendActivity('repair', activityLevel(result.status), repairLog(result), { usage: result.usage })
    if (result.status === 'ok' && result.groups.length) {
      openStrip(result.groups)
      await searchWithGroups(mine, result.groups)
    } else if (result.status !== 'ok' && result.status !== 'skipped') {
      repairNotice = headerMessage({
        kind: 'degraded',
        status: result.status as DegradedStatus,
        host: result.endpointHost,
        statusClass: result.statusClass,
        missing: result.missing,
      })
    }
  }

  async function searchStripGroups(): Promise<void> {
    if (!strip) return
    const groups = strip.inputs.map(parseGroup).filter((group) => group.terms.length || group.phrases.length)
    if (!groups.length) return
    await searchWithGroups(requestSequence, groups)
  }

  /** Local search with the given wordings; the results are not judged. */
  async function searchWithGroups(mine: number, groups: TermGroup[]): Promise<void> {
    const runId = lookupRunId
    if (!runId) return
    stopEnhanceRequest()
    lookupBusy = true
    try {
      const result = await serial(() => smartSearchApi.searchGroups(runId, groups, settings.smartLookup.results.limit))
      if (mine !== requestSequence) return
      resetJudgement()
      repaired = true
      showSearch(question, result.search, result.lookupRunId, result.time ?? null, result.hitGroups)
      if (strip) strip = { ...strip, counts: result.groupCounts, error: '' }
      if (attempts) attempts = { ...attempts, rephrased: { kind: 'rephrased', hits: result.search.hits.length, tookMs: result.search.tookMs } }
      logSearch(result.search)
    } catch (error) {
      if (mine !== requestSequence) return
      const message = redactError(error)
      if (strip) strip = { ...strip, error: message }
      appendActivity('search', 'error', `${t('smartSearch.searchError')}: ${message}`)
    } finally {
      if (mine === requestSequence) lookupBusy = false
    }
  }

  function setStripInput(index: number, value: string): void {
    if (!strip) return
    const inputs = [...strip.inputs]
    inputs[index] = value
    strip = { ...strip, inputs }
  }

  async function rewriteQuestion(): Promise<void> {
    await tick()
    inputEl?.focus()
    inputEl?.select()
  }

  // ---- launch view ----

  async function dismissFirstRun(): Promise<void> {
    await persistSmartLookup((value) => { value.launch.firstRunSeen = true })
  }

  function runRecent(entry: string): void {
    inputValue = entry
    void tick().then(resizeInput)
    void submitLookup()
  }

  function clearRecentLookups(): void {
    clearRecent()
    recent = []
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

  /** Marks for one row. Pinned hits get none. */
  function rowMarks(hit: SearchHit): Array<{ kind: string; text: string }> {
    if (hit.pinned) return []
    const marks: Array<{ kind: string; text: string }> = []
    const id = resultIdOf(hit)
    const tier = id ? tiers.get(id) : undefined
    if (tier === 'fit') marks.push({ kind: 'fit', text: t('smartSearch.enhance.tierFit') })
    else if (tier === 'unfit') marks.push({ kind: 'unfit', text: t('smartSearch.enhance.tierUnfit') })
    const move = id ? moved.get(id) : undefined
    if (move) {
      marks.push({
        kind: 'moved',
        text: t(move.direction === 'up' ? 'smartSearch.enhance.movedUp' : 'smartSearch.enhance.movedDown', { n: move.from }),
      })
    }
    if (judgeResult && hit.level !== 'line') marks.push({ kind: 'not-judged', text: t('smartSearch.enhance.notJudged') })
    for (const group of hitGroups.get(hitKey(hit)) ?? []) {
      marks.push({ kind: 'wording', text: t('smartSearch.enhance.wordingLabel', { n: group }) })
    }
    return marks
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
      markInteracted()
      void focusHit(index + 1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      markInteracted()
      if (index === 0) inputEl?.focus()
      else void focusHit(index - 1)
    } else if (event.key === 'Home') {
      event.preventDefault()
      markInteracted()
      void focusHit(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      markInteracted()
      void focusHit(orderedHits.length - 1)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      void openHit(orderedHits[index])
    }
  }

  /** A pointer press on the scroll container itself (not a row) is a scrollbar drag. */
  function onListPointerDown(event: PointerEvent): void {
    if (event.target === event.currentTarget) markInteracted()
  }

  async function openHit(hit: SearchHit | undefined): Promise<void> {
    if (!hit) return
    markInteracted()
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

  /** ⌘ on macOS, Ctrl elsewhere, with no other modifier. */
  function shortcut(event: KeyboardEvent, letter: string): boolean {
    const primary = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
    return primary && !event.shiftKey && !event.altKey && event.key.toLowerCase() === letter
  }

  function isTextField(target: EventTarget | null): boolean {
    return target instanceof HTMLElement
      && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable)
  }

  function onInputKeydown(event: KeyboardEvent): void {
    if (ime.blocks(event)) return
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void submitLookup()
    } else if (event.key === 'ArrowDown' && !event.shiftKey && orderedHits.length && caretOnLastLine()) {
      event.preventDefault()
      markInteracted()
      void focusHit(0)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      if (!closePopovers()) void hideWindow()
    }
  }

  function onWindowKeydown(event: KeyboardEvent): void {
    if (isImeKey(event) || event.defaultPrevented) return
    if (shortcut(event, 'k')) {
      event.preventDefault()
      void toggleMenu()
      return
    }
    if (shortcut(event, 'z')) {
      // In a text field ⌘Z stays text undo.
      if (isTextField(event.target) || !appliedOrder) return
      event.preventDefault()
      void restoreLocalOrder()
      return
    }
    if (event.key !== 'Escape') return
    event.preventDefault()
    if (!closePopovers()) void hideWindow()
  }

  /** Close the details popover or the time menu; true when one was open. */
  function closePopovers(): boolean {
    const open = detailsOpen || timeMenuOpen
    detailsOpen = false
    timeMenuOpen = false
    return open
  }

  async function hideWindow(): Promise<void> {
    cancelPreview()
    closeMenu(false)
    closePopovers()
    if (lookupBusy || store.loading || inflight) {
      const stopped = inflight
      supersede()
      store.cancel()
      if (stopped?.kind === 'judge') header = cancelledHeader()
      appendActivity('search', 'warning', t('smartSearch.stopped'))
    }
    try { await invoke('hide_smart_search_window') } catch { /* Browser preview. */ }
  }

  // ---- actions menu ----

  async function toggleMenu(): Promise<void> {
    if (menuOpen) { closeMenu(); return }
    closePopovers()
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
    const target = event.target as Node | null
    if (menuOpen && !(target && (menuEl?.contains(target) || menuButton?.contains(target)))) closeMenu(false)
    if (timeMenuOpen && !(target instanceof Element && target.closest('.time-anchor'))) timeMenuOpen = false
    if (detailsOpen && !(target instanceof Element && target.closest('.judge-header, .judge-details'))) detailsOpen = false
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
    {#if showConditions && (showCriterion || lookupTime)}
      <div class="conditions">
        {#if showCriterion}
          <span class="chip criterion-chip">{t('smartSearch.enhance.criterion')}</span>
        {/if}
        {#if lookupTime}
          {@const time = lookupTime}
          {@const current = chosenTimeMode ?? time.mode}
          <div class="time-anchor">
            <button
              bind:this={timeChipEl}
              class="chip time-chip"
              aria-haspopup="menu"
              aria-expanded={timeMenuOpen}
              onclick={() => { detailsOpen = false; timeMenuOpen = !timeMenuOpen }}
            >{t('smartSearch.enhance.timeChip', { range: time.sourceText })} <span aria-hidden="true">▾</span></button>
            {#if timeMenuOpen}
              <div class="menu-panel time-menu" role="menu" aria-label={t('smartSearch.enhance.timeChip', { range: time.sourceText })}>
                {#each TIME_OPTIONS as [value, label] (value)}
                  <button
                    class="menu-row"
                    role="menuitemradio"
                    aria-checked={current === value}
                    onclick={() => void chooseTimeMode(value)}
                  >{t(label)}</button>
                {/each}
              </div>
            {/if}
          </div>
        {/if}
      </div>
    {/if}
    <div class="hint-row">
      <p class="hint">{t('smartSearch.inputHint')}</p>
      <span class="activity" role="status" aria-label={t('smartSearch.activityTitle')}>
        {#if working}<span class="spinner" aria-hidden="true"></span>{/if}
        <span class="activity-text">{activityText}</span>
        <span class="copy-status">{copyStatus}</span>
      </span>
    </div>
  </section>

  {#if mode === 'idle'}
    <div class="launch">
      {#if ready && !settings.smartLookup.launch.firstRunSeen}
        <section class="first-run" aria-label={t('smartSearch.enhance.firstRunTitle')}>
          <h2>{t('smartSearch.enhance.firstRunTitle')}</h2>
          <p>{t('smartSearch.enhance.firstRunBody')}</p>
          <button class="secondary-button" onclick={() => void dismissFirstRun()}>{t('smartSearch.enhance.firstRunDismiss')}</button>
        </section>
      {/if}
      {#if recent.length}
        <section class="recent" aria-label={t('smartSearch.enhance.recentTitle')}>
          <header class="recent-header">
            <h2>{t('smartSearch.enhance.recentTitle')}</h2>
            <button class="text-button" onclick={clearRecentLookups}>{t('smartSearch.enhance.recentClear')}</button>
          </header>
          <ul>
            {#each recent as entry (entry)}
              <li><button class="recent-item" onclick={() => runRecent(entry)}>{entry}</button></li>
            {/each}
          </ul>
        </section>
      {:else if ready && settings.smartLookup.launch.firstRunSeen}
        <div class="empty-launch">
          <h1>{t('smartSearch.emptyTitle')}</h1>
          <p>{t('smartSearch.emptyPrompt')}</p>
        </div>
      {/if}
    </div>
  {:else}
    <section class="workspace">
      <aside class="results-pane" aria-label={t('smartSearch.results')}>
        <header class="pane-header">
          <strong>{mode === 'lookup' ? t('smartSearch.localResults') : t('smartSearch.quickPreview')}</strong>
          <span>{t('smartSearch.resultsCount', { n: orderedHits.length })}</span>
        </header>
        {#if showJudgeHeader}
          <div class="judge-header">
            {#if repairBusy}
              <span class="spinner" aria-hidden="true"></span>
              <span class="judge-text" aria-live="polite">{t('smartSearch.enhance.repairing')}</span>
            {:else if repairNotice && header.kind === 'none'}
              <span class="judge-text" aria-live="polite">{t(repairNotice.key, repairNotice.params)}</span>
            {:else if header.kind === 'judging'}
              <span class="spinner" aria-hidden="true"></span>
              <span class="judge-text" aria-live="polite">{headerText}</span>
              <button class="text-button" onclick={stopJudging}>{t('smartSearch.enhance.stop')}</button>
            {:else if header.kind === 'judged' || header.kind === 'topTenUnfit'}
              <button
                class="judge-text details-toggle"
                aria-expanded={detailsOpen}
                onclick={() => { timeMenuOpen = false; detailsOpen = !detailsOpen }}
              >{headerText}</button>
              {#if header.kind === 'topTenUnfit'}
                <button class="text-button" onclick={() => void repairLookup(requestSequence, 'user')}>{t('smartSearch.enhance.rephrase')}</button>
              {/if}
            {:else if header.kind === 'pending'}
              <span class="judge-text" aria-live="polite">{headerText}</span>
              <button class="text-button" onclick={() => void applyJudgement()}>{t('smartSearch.enhance.apply')}</button>
            {:else if header.kind === 'degraded'}
              {@const state = header}
              <span class="judge-text" aria-live="polite">{headerText}</span>
              {#if state.status === 'notConfigured'}
                <button class="text-button" onclick={() => void openEnhanceSettings()}>{t('smartSearch.enhance.openSettings')}</button>
              {:else if state.status === 'noConsent' && state.host}
                <button class="text-button" onclick={() => void allowHost(state.host)}>{t('smartSearch.enhance.allow')}</button>
              {:else if state.status === 'timeout'}
                <button class="text-button" onclick={() => void judgeLookup(requestSequence, 'user')}>{t('smartSearch.enhance.retry')}</button>
              {/if}
            {:else if header.kind === 'indexUnavailable'}
              <span class="judge-text" aria-live="polite">{headerText}</span>
            {/if}
          </div>
          {#if detailsOpen && judgeResult && (header.kind === 'judged' || header.kind === 'topTenUnfit')}
            {@const result = judgeResult}
            <div class="judge-details" role="group" aria-label={headerText}>
              {#if result.endpointHost}<p>{t('smartSearch.enhance.detailsHost', { host: result.endpointHost })}</p>{/if}
              <p>{result.reused
                ? t('smartSearch.enhance.detailsReused')
                : t('smartSearch.enhance.detailsRequests', { n: result.requestCount, ms: result.elapsedMs })}</p>
              <p>{t('smartSearch.enhance.detailsSent', { n: result.sentBlocks, tokens: result.estimatedTokens })}</p>
              <p>{t('smartSearch.enhance.detailsUnsent', { rollups: result.skippedRollups, confidential: result.skippedConfidential })}</p>
              <p>{t('smartSearch.enhance.detailsScope', { n: result.judgedCount, pool: result.poolSize })}</p>
              {#if appliedOrder}
                <div class="details-actions">
                  <button class="secondary-button" onclick={() => void restoreLocalOrder()}>{t('smartSearch.enhance.restore')}</button>
                  <kbd>{restoreShortcut}</kbd>
                </div>
              {/if}
            </div>
          {/if}
        {/if}
        {#if strip && mode === 'lookup'}
          {@const current = strip}
          <form class="repair-strip" onsubmit={(event) => { event.preventDefault(); void searchStripGroups() }}>
            {#if struckTerms.length}
              <p class="struck">{t('smartSearch.enhance.repairStruck')}: {#each struckTerms as term, index (term)}{#if index > 0}{' '}{/if}<s>{term}</s>{/each}</p>
            {/if}
            {#each current.inputs as value, index (index)}
              <label class="wording">
                <span>{current.counts
                  ? t('smartSearch.enhance.repairGroup', { n: index + 1, count: current.counts[index] ?? 0 })
                  : t('smartSearch.enhance.wordingLabel', { n: index + 1 })}</span>
                <input {value} oninput={(event) => setStripInput(index, (event.currentTarget as HTMLInputElement).value)} />
              </label>
            {/each}
            {#if current.error}<p class="notice error" role="alert">{current.error}</p>{/if}
            <button class="secondary-button" type="submit" disabled={lookupBusy}>{t('smartSearch.enhance.repairSearch')}</button>
          </form>
        {/if}
        <!-- Wheel, touch and scrollbar presses only record that the user moved; they are not controls. -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="results-scroll"
          aria-busy={lookupBusy || store.loading}
          onwheel={markInteracted}
          ontouchmove={markInteracted}
          onpointerdown={onListPointerDown}
        >
          {#if store.error}
            <div class="state error" role="alert">
              <strong>{t('smartSearch.searchError')}</strong>
              <p>{store.error}</p>
              <button class="secondary-button" onclick={() => void submitLookup()}>{t('smartSearch.retry')}</button>
            </div>
          {:else if (lookupBusy || store.loading) && !orderedHits.length}
            <div class="state"><span class="spinner" aria-hidden="true"></span><p>{t('smartSearch.searching')}</p></div>
          {:else if !orderedHits.length && mode === 'lookup'}
            <div class="state no-match">
              <strong>{t('smartSearch.enhance.noMatchTitle')}</strong>
              <p>{t('smartSearch.noResultsHint')}</p>
              {#if struckTerms.length && !strip}
                <p class="struck">{t('smartSearch.enhance.repairStruck')}: {#each struckTerms as term, index (term)}{#if index > 0}{' '}{/if}<s>{term}</s>{/each}</p>
              {/if}
              {#if attemptRows.length}
                <ul class="attempts">
                  {#each attemptRows as attempt (attempt.kind)}
                    <li>
                      <span>{t(attempt.kind === 'original' ? 'smartSearch.enhance.attemptOriginal'
                        : attempt.kind === 'rephrased' ? 'smartSearch.enhance.attemptRephrased'
                          : 'smartSearch.enhance.attemptScan')}</span>
                      <span>{attempt.hits === null
                        ? t('smartSearch.enhance.attemptNotRun')
                        : t('smartSearch.enhance.attemptResult', { n: attempt.hits, ms: attempt.tookMs ?? 0 })}</span>
                    </li>
                  {/each}
                </ul>
              {/if}
              <div class="no-match-actions">
                <button class="secondary-button" onclick={() => void rewriteQuestion()}>{t('smartSearch.enhance.rewrite')}</button>
                <button class="secondary-button" onclick={editWording}>{t('smartSearch.enhance.editWording')}</button>
                {#if canExpand}
                  <button class="secondary-button" disabled={lookupBusy} onclick={() => void expandLookup()}>{t('smartSearch.expandSearch')}</button>
                {/if}
              </div>
            </div>
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
                    {@const marks = rowMarks(hit)}
                    <div
                      class="result-row"
                      class:active
                      role="option"
                      aria-selected={active}
                      tabindex={active ? 0 : -1}
                      data-index={index}
                      data-result-id={resultIdOf(hit)}
                      onclick={() => { markInteracted(); activeKey = hitKey(hit) }}
                      ondblclick={() => void openHit(hit)}
                      onkeydown={(event) => onRowKeydown(event, index)}
                    >
                      <strong class="result-title">{displayTitle(hit)}</strong>
                      <p class="result-snippet">{#each highlightParts(snippet(hit), highlightTerms) as part}{#if part.hit}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}</p>
                      {#if marks.length}
                        <div class="result-badges">
                          {#each marks as mark, markIndex (markIndex)}
                            <span class="result-badge {mark.kind}">{mark.text}</span>
                          {/each}
                        </div>
                      {/if}
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
          {#if activeHit}
            {@const hit = activeHit}
            {@const id = resultIdOf(hit)}
            <div class="preview-location">{hitReference(hit)}</div>
            <h1 class="preview-title">{displayTitle(hit)}</h1>
            {#if id && tiers.has(id) && !hit.pinned}
              <div class="correction">
                {#if feedbackSaved[id]}
                  <span role="status">{t('smartSearch.enhance.correctSaved')}</span>
                {:else}
                  <span>{t('smartSearch.enhance.correctPrompt')}</span>
                  <button class="secondary-button" onclick={() => void correct(hit, 'fit')}>{t('smartSearch.enhance.correctFit')}</button>
                  <button class="secondary-button" onclick={() => void correct(hit, 'unfit')}>{t('smartSearch.enhance.correctUnfit')}</button>
                {/if}
              </div>
            {/if}
            {#if hit.level !== 'line' || hit.text.length > PREVIEW_CHARS}
              <p class="preview-note">{t('smartSearch.previewLimited')}</p>
            {/if}
            <p class="preview-text">{#each highlightParts(previewText(hit), highlightTerms) as part}{#if part.hit}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}</p>
          {:else}
            <p class="state">{t('smartSearch.previewHint')}</p>
          {/if}
        </div>
      </article>
    </section>
  {/if}

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
          <button class="menu-row" role="menuitem" tabindex="-1" disabled={lookupBusy} onclick={() => menuAction(expandLookup)}>{t('smartSearch.expandSearch')}</button>
        {/if}
        {#if appliedOrder}
          <button class="menu-row" role="menuitem" tabindex="-1" onclick={() => menuAction(restoreLocalOrder)}>{t('smartSearch.enhance.restore')}</button>
        {/if}
        {#if activity.length}
          <button class="menu-row" role="menuitem" tabindex="-1" onclick={() => menuAction(() => copyText(formatWorkflowLog(activity)))}>{t('smartSearch.copyActivity')}</button>
        {/if}
      </div>
    </div>
  {/if}

  <footer class="footer">
    <button
      bind:this={menuButton}
      class="footer-actions more-actions"
      aria-haspopup="menu"
      aria-expanded={menuOpen}
      onclick={() => void toggleMenu()}
    >{t('smartSearch.enhance.footerActions', { key: actionsShortcut })}</button>
  </footer>
</main>

<style>
  :global(:root) {
    --lookup-accent: #0869ed;
    --lookup-border: color-mix(in srgb, CanvasText 12%, transparent);
    --lookup-muted: color-mix(in srgb, CanvasText 60%, transparent);
    --lookup-soft: color-mix(in srgb, CanvasText 4%, transparent);
    --lookup-fit: #1a7f37;
    --lookup-unfit: #9a6700;
  }
  button, textarea, input { font: inherit; color: inherit; }
  button:disabled { opacity: .4; }
  button:focus-visible, .result-row:focus-visible, textarea:focus-visible, input:focus-visible {
    outline: 3px solid color-mix(in srgb, var(--lookup-accent) 55%, transparent);
    outline-offset: 1px;
  }
  .lookup { position: relative; height: 100vh; display: flex; flex-direction: column; background: Canvas; color: CanvasText; overflow: hidden; }
  .query-bar { flex: 0 0 auto; padding: 16px 18px 8px; }
  .query-input {
    box-sizing: border-box; width: 100%; resize: none; min-height: 40px; max-height: 96px;
    padding: 9px 12px; border: 1px solid var(--lookup-border); border-radius: 10px;
    background: Canvas; font-size: 16px; line-height: 1.45; overflow-y: auto;
  }
  .conditions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 8px; }
  .chip { display: inline-flex; align-items: center; gap: 4px; padding: 2px 9px; border: 1px solid var(--lookup-border); border-radius: 999px; background: var(--lookup-soft); font-size: 11px; color: var(--lookup-muted); }
  button.chip { cursor: default; }
  button.chip:hover { color: CanvasText; }
  .time-anchor { position: relative; }
  .time-menu { position: absolute; left: 0; top: calc(100% + 4px); z-index: 12; display: flex; flex-direction: column; min-width: 140px; }
  .time-menu .menu-row, .actions-menu .menu-row { border: 0; background: transparent; text-align: left; min-height: 26px; }
  .time-menu .menu-row[aria-checked='true']::before { content: '✓ '; }
  .hint-row { display: flex; align-items: center; gap: 12px; margin: 6px 2px 0; min-height: 16px; }
  .hint { margin: 0; flex: 0 0 auto; font-size: 11px; color: var(--lookup-muted); }
  .activity { flex: 1; min-width: 0; display: flex; justify-content: flex-end; align-items: center; gap: 6px; font-size: 11px; color: var(--lookup-muted); }
  .activity-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .launch { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 16px; padding: 12px 18px 18px; border-top: 1px solid var(--lookup-border); }
  .first-run { padding: 12px 14px; border: 1px solid var(--lookup-border); border-radius: 10px; background: var(--lookup-soft); }
  .first-run h2, .recent h2 { margin: 0 0 6px; font-size: 13px; font-weight: 600; }
  .first-run p { margin: 0; font-size: 12px; line-height: 1.6; color: var(--lookup-muted); }
  .recent-header { display: flex; align-items: center; justify-content: space-between; }
  .recent-header h2 { margin: 0; }
  .recent ul { list-style: none; margin: 6px 0 0; padding: 0; }
  .recent-item { display: block; width: 100%; padding: 6px 8px; border: 0; border-radius: 6px; background: transparent; text-align: left; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .recent-item:hover, .recent-item:focus-visible { background: var(--lookup-soft); }
  .empty-launch { flex: 1; display: flex; flex-direction: column; justify-content: center; align-items: center; padding: 24px; text-align: center; }
  .empty-launch h1 { font-size: 19px; font-weight: 600; margin: 0 0 8px; }
  .empty-launch p { margin: 0; max-width: 380px; color: var(--lookup-muted); font-size: 13px; line-height: 1.6; }
  .workspace { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(260px, 42%) minmax(0, 1fr); border-top: 1px solid var(--lookup-border); }
  .results-pane, .preview-pane { min-width: 0; min-height: 0; display: flex; flex-direction: column; }
  .results-pane { border-right: 1px solid var(--lookup-border); }
  .pane-header { flex: 0 0 auto; min-height: 40px; display: flex; align-items: center; gap: 8px; padding: 0 12px 0 16px; border-bottom: 1px solid var(--lookup-border); }
  .pane-header strong { margin-right: auto; font-size: 12px; font-weight: 600; }
  .pane-header > span { color: var(--lookup-muted); font-size: 11px; white-space: nowrap; }
  .judge-header { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; min-height: 30px; padding: 0 12px 0 16px; border-bottom: 1px solid var(--lookup-border); background: var(--lookup-soft); font-size: 12px; }
  .judge-text { min-width: 0; margin-right: auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .details-toggle { padding: 0; border: 0; background: transparent; text-align: left; text-decoration: underline dotted; text-underline-offset: 3px; }
  .judge-details { flex: 0 0 auto; padding: 8px 16px 10px; border-bottom: 1px solid var(--lookup-border); font-size: 12px; color: var(--lookup-muted); }
  .judge-details p { margin: 0 0 3px; }
  .details-actions { display: flex; align-items: center; gap: 8px; }
  kbd { font: inherit; font-size: 11px; color: var(--lookup-muted); }
  .repair-strip { flex: 0 0 auto; display: flex; flex-direction: column; gap: 6px; padding: 8px 16px 10px; border-bottom: 1px solid var(--lookup-border); font-size: 12px; }
  .repair-strip .secondary-button { align-self: flex-start; margin-top: 0; }
  .wording { display: grid; grid-template-columns: max-content 1fr; align-items: center; gap: 8px; color: var(--lookup-muted); }
  .wording input { min-width: 0; padding: 4px 8px; border: 1px solid var(--lookup-border); border-radius: 6px; background: Canvas; color: CanvasText; }
  .struck { margin: 0; color: var(--lookup-muted); font-size: 12px; }
  s { color: CanvasText; }
  .menu-popover { position: absolute; left: 12px; bottom: 34px; z-index: 10; width: max-content; max-width: 280px; }
  .actions-menu { display: flex; flex-direction: column; }
  .results-scroll, .preview-scroll { flex: 1; min-height: 0; overflow-y: auto; }
  .result-group { padding: 6px 0; }
  .group-label { display: flex; gap: 6px; padding: 4px 16px; font-size: 11px; font-weight: 600; color: var(--lookup-muted); }
  .result-row { padding: 7px 16px; border-left: 3px solid transparent; cursor: default; }
  .result-row.active { background: color-mix(in srgb, var(--lookup-accent) 9%, Canvas); border-left-color: var(--lookup-accent); }
  .result-title { display: block; font-size: 13px; font-weight: 550; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .result-snippet { margin: 2px 0 0; font-size: 12px; line-height: 1.45; color: var(--lookup-muted); display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .result-badges { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
  .result-badge { padding: 0 6px; border-radius: 4px; background: var(--lookup-soft); font-size: 10.5px; line-height: 17px; color: var(--lookup-muted); }
  .result-badge.fit { color: var(--lookup-fit); background: color-mix(in srgb, var(--lookup-fit) 10%, transparent); }
  .result-badge.unfit { color: var(--lookup-unfit); background: color-mix(in srgb, var(--lookup-unfit) 10%, transparent); }
  mark { background: color-mix(in srgb, #f5c518 40%, transparent); color: inherit; border-radius: 2px; }
  .state { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 32px 20px; text-align: center; font-size: 13px; color: var(--lookup-muted); }
  .state strong { color: CanvasText; }
  .state p { margin: 0; }
  .state.error strong { color: #b42318; }
  .attempts { list-style: none; margin: 6px 0 0; padding: 0; min-width: 220px; font-size: 12px; }
  .attempts li { display: flex; justify-content: space-between; gap: 16px; padding: 3px 0; border-bottom: 1px solid var(--lookup-border); }
  .no-match-actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 6px; }
  .secondary-button { margin-top: 6px; padding: 5px 12px; border: 1px solid var(--lookup-border); border-radius: 7px; background: var(--lookup-soft); }
  .text-button { padding: 2px 4px; border: 0; background: transparent; color: var(--lookup-accent); font-size: 12px; white-space: nowrap; }
  .preview-scroll { padding: 14px 18px; }
  .preview-location { font-size: 11px; color: var(--lookup-muted); word-break: break-all; }
  .preview-title { margin: 4px 0 10px; font-size: 16px; font-weight: 600; }
  .correction { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 0 0 10px; font-size: 12px; color: var(--lookup-muted); }
  .correction .secondary-button { margin-top: 0; padding: 2px 10px; }
  .preview-note { margin: 0 0 8px; font-size: 12px; color: var(--lookup-muted); }
  .preview-text { margin: 0; font-size: 13px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
  .notice { margin: 0 0 12px; padding: 8px 10px; border-radius: 8px; background: var(--lookup-soft); font-size: 12px; line-height: 1.5; }
  .notice.error { background: color-mix(in srgb, #ce3030 8%, Canvas); }
  .footer { flex: 0 0 auto; display: flex; align-items: center; min-height: 28px; padding: 0 12px; border-top: 1px solid var(--lookup-border); }
  .footer-actions { padding: 2px 6px; border: 0; border-radius: 5px; background: transparent; font-size: 11px; color: var(--lookup-muted); }
  .footer-actions:hover { background: var(--lookup-soft); color: CanvasText; }
  .spinner { display: inline-block; flex-shrink: 0; width: 11px; height: 11px; border: 2px solid color-mix(in srgb, var(--lookup-accent) 18%, transparent); border-top-color: var(--lookup-accent); border-radius: 50%; animation: spin .8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (max-width: 719.98px) {
    .workspace { grid-template-columns: 1fr; grid-template-rows: minmax(0, 1fr) minmax(0, 1fr); }
    .results-pane { border-right: 0; border-bottom: 1px solid var(--lookup-border); }
  }
</style>
