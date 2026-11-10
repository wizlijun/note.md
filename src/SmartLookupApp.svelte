<script lang="ts">
  // Smart Lookup window. Local-first: typing previews and Enter both read the
  // local index at once. After an Enter the host may gather evidence round by
  // round (spec H.8: an 「证据」 section above the local results, whose order the
  // model never changes) or, on zero hits, suggest other wording; both are
  // bound to the lookup run the host retained.
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
    type EnhanceStatus,
    type EvidenceItem,
    type EvidenceStepResult,
    type RepairSuggestion,
    type TermGroup,
    type Tier,
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
    chatRequestConfig,
    endpointHost,
    headerMessage,
    jevRequestConfig,
    noMatchAttempts,
    repairMessage,
    shouldAutoRepair,
    type HeaderMessage,
    type AttemptKind,
    type HeaderState,
    type LookupAttempt,
  } from './lib/smart-search/enhance-flow'
  import {
    absolutePath,
    addTotals,
    applyPending,
    applyRound,
    emptyEvidence,
    emptyTotals,
    evidenceNotice,
    headerFromStep,
    restoreRound,
    roundLabel,
    shouldStartEvidence,
    startOffered,
    type EvidenceRound,
    type EvidenceTotals,
    type EvidenceView,
  } from './lib/smart-search/evidence-flow'
  import { clearRecent, loadRecent, loadRecentCounts, rememberRecent, rememberRecentCount } from './lib/smart-search/recent'
  import LaunchView from './components/smart-lookup/LaunchView.svelte'
  import NoMatchPanel from './components/smart-lookup/NoMatchPanel.svelte'
  import RepairStrip from './components/smart-lookup/RepairStrip.svelte'
  import { wordingLetter } from './components/smart-lookup/format'
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
  /** The evidence run or repair request the host is working on; `token` tells a newer one from an older one. */
  type Inflight = { runId: string; kind: 'evidence' | 'repair'; token: number }
  type StripState = { inputs: string[]; counts: number[] | null; error: string }
  /** `order`: the attempts in the order they ran (ledger ruling). */
  type Attempts = {
    original: { hits: number; tookMs: number }
    rephrased: LookupAttempt | null
    scan: LookupAttempt | null
    order: AttemptKind[]
  }
  /** The local result and its evidence before a regrouped search, for 「只用原问题」. */
  type OriginalView = {
    search: SmartSearchResponse
    runId: string
    time: TimeWindow | null
    header: HeaderState
    evidence: EvidenceView
    totals: EvidenceTotals
    evidenceRunId: string
    evidenceDeep: boolean
    localTiers: Map<string, Tier>
    offerStart: boolean
  }
  /** A row of either list: evidence rows carry their item and are opened like local hits. */
  type Row = SearchHit & { evidence?: EvidenceItem }

  const PREVIEW_CHARS = 3_000
  const TIME_OPTIONS: ReadonlyArray<readonly [TimeMode, 'smartSearch.enhance.timeGroup' | 'smartSearch.enhance.timeWindow' | 'smartSearch.enhance.timeIgnore']> = [
    ['group', 'smartSearch.enhance.timeGroup'],
    ['window', 'smartSearch.enhance.timeWindow'],
    ['ignore', 'smartSearch.enhance.timeIgnore'],
  ]
  const WORDING_SLOTS = 2
  const isMac = isApplePlatformSync()
  const actionsShortcut = isMac ? '⌘K' : 'Ctrl+K'
  const applyShortcut = isMac ? '⌘R' : 'Ctrl+R'
  const rewriteShortcut = isMac ? '⌘L' : 'Ctrl+L'

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
  let recentCounts = $state<Record<string, number>>(loadRecentCounts())
  /** Recent lookup chosen with ↑/↓ from the empty input; -1 = none. */
  let recentIndex = $state(-1)

  // Conditions of the current Enter.
  let lookupTime = $state<TimeWindow | null>(null)
  /** Sent only after the user picked a time option; cleared for a new question. */
  let chosenTimeMode = $state<TimeMode | undefined>(undefined)
  let timeMenuOpen = $state(false)

  // Evidence (spec H.8). `header` is the status line: degraded states and the start offer.
  let header = $state<HeaderState>({ kind: 'none' })
  let evidence = $state<EvidenceView>(emptyEvidence())
  /** The lookup run the evidence belongs to; corrections are recorded on it. */
  let evidenceRunId = ''
  /** Whether that run is an expanded (deep) lookup; every round of it says so. */
  let evidenceDeep = false
  /** The round in flight, for the progress line; `null` when none runs. */
  let evidenceRound = $state<{ hop: number; startedAt: number } | null>(null)
  /** Local rows' tiers from the latest round (H.8: same path and line range as a scored block). */
  let localTiers = $state<Map<string, Tier>>(new Map())
  /** 「查找证据」: the evidence did not start on its own (route, slot) or was stopped. */
  let offerStart = $state(false)
  /** What this run sent and left out, for the details popover (F.3 without the reorder lines). */
  let totals = $state<EvidenceTotals>(emptyTotals())
  let detailsOpen = $state(false)
  let feedbackSaved = $state<Record<string, 'fit' | 'unfit'>>({})
  let now = $state(Date.now())
  /** Arrow keys, a click on a row, scrolling the list or opening a result since this Enter. */
  let interacted = false

  // Zero hits and repair.
  let diagnosis = $state<Diagnosis | null>(null)
  let attempts = $state<Attempts | null>(null)
  let strip = $state<StripState | null>(null)
  let stripView = $state<ReturnType<typeof RepairStrip>>()
  let repairBusy = $state(false)
  let repairNotice = $state<HeaderMessage | null>(null)
  let repaired = $state(false)
  /** Set when the current wordings came from the repair model. */
  let repairSource = $state<{ elapsedMs: number } | null>(null)
  /** The wordings of the last regrouped search. */
  let lastGroups = $state<TermGroup[]>([])
  let originalView = $state<OriginalView | null>(null)
  /** The last result of `smart_lookup_local` for this question (not regrouped). */
  let lastLocal: { search: SmartSearchResponse; runId: string; time: TimeWindow | null } | null = null
  /** Model requests made for this Enter: `judge` counts Jev requests (the evidence rounds), `repair` the repair model's. */
  let modelRequests = $state({ judge: 0, repair: 0 })
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
  let sections = $derived(buildSections(store.hits, mode === 'lookup' ? lookupTime : null, settings.smartLookup.results.groupBy))
  /** The local rows in display order; the model never reorders them (H.8). */
  let orderedHits = $derived(sections.flatMap((section) => section.hits))
  let evidenceRows = $derived(mode === 'lookup' ? evidence.shown.map(evidenceRow) : [])
  /** Every selectable row: the evidence above, then the local rows. */
  let rows = $derived<Row[]>([...evidenceRows, ...orderedHits])
  let activeHit = $derived<Row | null>(rows.find((hit) => rowKey(hit) === activeKey) ?? rows[0] ?? null)
  let noticeKey = $derived(evidenceNotice(evidence))
  let expansionRounds = $derived(evidence.rounds.filter((round) => round.hop > 0 && round.terms.length > 0))
  let showEvidence = $derived(mode === 'lookup' && (evidenceRound !== null || evidence.rounds.length > 0 || noticeKey !== null))
  let progressText = $derived(evidenceRound ? progressLine(evidenceRound, now) : '')
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
  let headerText = $derived(headerLine(header))
  let showStart = $derived(offerStart && evidenceRound === null && !repaired)
  let showJudgeHeader = $derived(mode === 'lookup' && (headerText !== '' || repairBusy || showStart))
  /** A failed 「换个说法」: its own line, whatever the judge header shows (F.3: every degraded state is visible). */
  let showRepairNotice = $derived(mode === 'lookup' && repairNotice !== null && !repairBusy)
  let attemptRows = $derived(attempts ? orderedAttempts(attempts) : [])
  let noMatchVisible = $derived(mode === 'lookup' && !store.error && !lookupBusy && !store.loading && !orderedHits.length)

  $effect(() => {
    const title = t('smartSearch.windowTitle')
    void appWindow.setTitle(title).catch(() => {})
  })

  $effect(() => {
    // The progress line shows seconds; tick only while a round runs.
    if (!evidenceRound) return
    now = Date.now()
    const timer = setInterval(() => { now = Date.now() }, 1_000)
    return () => clearInterval(timer)
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

  /** Make every running lookup, preview, evidence run and repair stale; cancel the host request. */
  function supersede(): number {
    requestSequence += 1
    lookupBusy = false
    stopEnhanceRequest()
    return requestSequence
  }

  /** Cancel the evidence run or repair request in flight (if any); returns it. */
  function stopEnhanceRequest(): Inflight | null {
    const current = inflight
    inflight = null
    evidenceRound = null
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

  function resetEvidence(): void {
    header = { kind: 'none' }
    evidence = emptyEvidence()
    evidenceRunId = ''
    evidenceDeep = false
    evidenceRound = null
    localTiers = new Map()
    offerStart = false
    totals = emptyTotals()
    detailsOpen = false
    feedbackSaved = {}
  }

  function resetRepair(): void {
    diagnosis = null
    attempts = null
    strip = null
    repairNotice = null
    repaired = false
    repairSource = null
    lastGroups = []
    originalView = null
    hitGroups = new Map()
  }

  function startAttempts(hits: number, tookMs: number): void {
    attempts = { original: { hits, tookMs }, rephrased: null, scan: null, order: ['original'] }
  }

  function recordAttempt(kind: 'rephrased' | 'scan', hits: number, tookMs: number): void {
    if (!attempts) return
    const order = attempts.order.includes(kind) ? attempts.order : [...attempts.order, kind]
    attempts = { ...attempts, [kind]: { kind, hits, tookMs }, order }
  }

  /** Attempts in the order they ran, then the ones that did not run. */
  function orderedAttempts(value: Attempts): LookupAttempt[] {
    const rows = noMatchAttempts(value.original, value.rephrased, value.scan)
    const rank = (kind: AttemptKind) => {
      const index = value.order.indexOf(kind)
      return index < 0 ? value.order.length + rows.findIndex((row) => row.kind === kind) : index
    }
    return [...rows].sort((a, b) => rank(a.kind) - rank(b.kind))
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
    resetEvidence()
    resetRepair()
    resetActivity()
    lookupTime = null
    if (decision.kind === 'clear') {
      store.clear()
      mode = 'idle'
      question = ''
      activeKey = null
      recent = loadRecent()
      recentCounts = loadRecentCounts()
      recentIndex = -1
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

  /** Selection identity: path and line range (H.8), kept apart for an evidence row and a local row of the same block. */
  function rowKey(hit: Row): string {
    return hit.evidence ? `evidence\0${hitKey(hit)}` : hitKey(hit)
  }

  /**
   * An evidence item as a row: local vault text only. The host sends the
   * vault path; the absolute one comes from the run's local hits, and an
   * empty one makes opening report a stale target.
   */
  function evidenceRow(item: EvidenceItem): Row {
    return {
      path: item.path,
      absPath: absolutePath(item.path, store.hits) ?? '',
      line: item.line,
      lineEnd: item.lineEnd,
      text: item.text,
      breadcrumb: item.breadcrumb,
      level: 'line',
      score: 0,
      docDate: null,
      sourceRef: `${item.path}#L${item.line}`,
      agentBy: null,
      humanVerified: false,
      origin: 'unlabeled',
      conceptType: null,
      pinned: false,
      evidence: item,
    }
  }

  /** An evidence row's tier, or a local row's from the latest round. */
  function tierOf(hit: Row): Tier | undefined {
    if (hit.evidence) return hit.evidence.tier
    const id = resultIdOf(hit)
    return id && !hit.pinned ? localTiers.get(id) : undefined
  }

  /** What a correction names: the evidence id, or the result id of a tiered local row. */
  function correctionId(hit: Row): string | undefined {
    if (hit.evidence) return hit.evidence.evidenceId
    return tierOf(hit) ? resultIdOf(hit) : undefined
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
    resetEvidence()
    const keptDiagnosis = diagnosis
    const keptAttempts = attempts
    resetRepair()
    if (options.keepZeroState) {
      diagnosis = keptDiagnosis
      attempts = keptAttempts
    } else {
      modelRequests = { judge: 0, repair: 0 }
    }
    lastLocal = null
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
    startAttempts(first.hits, first.tookMs)
    if (first.hits > 0) {
      await startEvidence(mine, 'auto', false)
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
    recordAttempt('scan', scan.hits, scan.tookMs)
    if (scan.hits > 0) await startEvidence(mine, 'user', true)
  }

  /** The time chip: search locally again with that time mode; never gathers evidence or repairs. */
  async function chooseTimeMode(timeMode: TimeMode): Promise<void> {
    timeMenuOpen = false
    const submitted = question
    if (!submitted) return
    chosenTimeMode = timeMode
    const mine = beginLookup(submitted, { keepActivity: true })
    const result = await runLocal(mine, submitted, false)
    if (result) startAttempts(result.hits, result.tookMs)
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
      lastLocal = { search: result.search, runId: result.lookupRunId, time: result.time ?? null }
      showSearch(submitted, result.search, result.lookupRunId, result.time ?? null)
      noteRecentCount(submitted, result.search.hits.length)
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
    activeKey = rows[0] ? rowKey(rows[0]) : null
  }

  function noteRecentCount(submitted: string, hits: number): void {
    recentCounts = rememberRecentCount(submitted, hits)
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
      recordAttempt('scan', scan.hits, scan.tookMs)
      if (scan.hits > 0) {
        await startEvidence(mine, 'auto', true)
        return
      }
    }
    const keys = await smartSearchApi.keyStatus().catch(() => null)
    if (mine !== requestSequence || !keys) return
    if (shouldAutoRepair(store.hits.length, settings.smartLookup, keys)) await repairLookup(mine, 'auto')
  }

  // ---- evidence ----

  function headerLine(state: HeaderState): string {
    const message = headerMessage(state)
    return message ? t(message.key, message.params) : ''
  }

  /** 正在检索原文 (round 0) or 正在扩展检索（第 N 轮）, with whole seconds since the round started. */
  function progressLine(round: { hop: number; startedAt: number }, at: number): string {
    const phase = round.hop === 0
      ? t('smartSearch.evidence.searching')
      : t('smartSearch.evidence.expanding', { hop: round.hop })
    const s = Math.max(0, Math.floor((at - round.startedAt) / 1000))
    return `${phase} · ${t('smartSearch.enhance.durationSeconds', { s })}`
  }

  /**
   * The evidence for the run on screen. It starts on its own (`auto`) only
   * when `shouldStartEvidence` holds; otherwise the window says what is
   * missing without calling the host (no endpoint, no consent for its host).
   * Regrouped (repaired) results are never judged.
   */
  async function startEvidence(mine: number, trigger: Trigger, deep: boolean): Promise<void> {
    if (mine !== requestSequence || mode !== 'lookup' || repaired || !lookupRunId || !store.hits.length) return
    const current = settings.smartLookup
    if (!current.enhance.enabled) return
    if (evidenceRunId !== lookupRunId) evidenceDeep = deep
    const jev = current.enhance.jev
    if (!jev.url.trim() || !jev.model.trim()) {
      header = { kind: 'degraded', status: 'notConfigured', host: null, statusClass: null, missing: jev.url.trim() ? 'model' : 'url' }
      return
    }
    if (trigger === 'auto' && !shouldStartEvidence(store.hits.length, 'judge', current)) {
      const host = endpointHost(jev.url)
      header = host
        ? { kind: 'degraded', status: 'noConsent', host, statusClass: null, missing: null }
        // A URL without a host is not an endpoint.
        : { kind: 'degraded', status: 'notConfigured', host: null, statusClass: null, missing: 'url' }
      return
    }
    await runEvidence(mine, trigger)
  }

  /**
   * One round at a time on the current run until the host says done, the
   * user stops, or a newer lookup supersedes it. Task 8 rulings: never two
   * steps on one run; `auto` continues as `auto` only on the run it started
   * on; a `skipped`/`roundRunning` answer is ignored entirely. A failed or
   * stopped round leaves the local results and the shown evidence as they are.
   */
  async function runEvidence(mine: number, trigger: Trigger): Promise<void> {
    const runId = lookupRunId
    if (!runId) return
    stopEnhanceRequest()
    const token = ++enhanceToken
    inflight = { runId, kind: 'evidence', token }
    if (evidenceRunId !== runId) {
      evidence = emptyEvidence()
      localTiers = new Map()
      totals = emptyTotals()
      feedbackSaved = {}
      evidenceRunId = runId
    }
    header = { kind: 'none' }
    offerStart = false
    repairNotice = null
    const deep = evidenceDeep
    for (;;) {
      evidenceRound = { hop: nextHop(evidence), startedAt: Date.now() }
      let result: EvidenceStepResult
      try {
        result = await smartSearchApi.evidenceStep(runId, jevRequestConfig(settings.smartLookup), trigger, deep)
      } catch (error) {
        if (inflight?.token !== token || mine !== requestSequence) return
        inflight = null
        evidenceRound = null
        offerStart = !evidence.done
        appendActivity('judge', 'error', `evidence failed: ${redactError(error)}`)
        return
      }
      if (inflight?.token !== token || mine !== requestSequence) return
      // The previous round still holds the run (a restart right after a stop): nothing was
      // sent or applied; the start stays offered.
      if (result.skipReason === 'roundRunning') {
        offerStart = true
        break
      }
      modelRequests = { ...modelRequests, judge: modelRequests.judge + result.requestCount }
      appendActivity('judge', activityLevel(result.status), evidenceLog(result), { usage: result.usage })
      totals = addTotals(totals, result)
      evidence = applyRound(evidence, result, interacted)
      if (result.status === 'ok') localTiers = new Map(result.localTiers.map((verdict) => [verdict.resultId, verdict.tier]))
      header = headerFromStep(result)
      offerStart = startOffered(result)
      // Nothing was chosen yet, so the top row becomes the current one.
      if (!interacted) activeKey = rows[0] ? rowKey(rows[0]) : null
      if (result.done || result.status !== 'ok') break
    }
    inflight = null
    evidenceRound = null
  }

  function nextHop(view: EvidenceView): number {
    const last = view.rounds.at(-1)
    return last ? last.hop + 1 : 0
  }

  function activityLevel(status: EnhanceStatus): WorkflowLevel {
    return status === 'ok' || status === 'skipped' ? 'success' : 'warning'
  }

  /** Status and counts only: never remote text, never the host, never note text. */
  function evidenceLog(result: EvidenceStepResult): string {
    const reason = result.skipReason ? ` (${result.skipReason})` : ''
    const stop = result.stop ? ` stop ${result.stop}` : ''
    const code = result.statusClass ? ` ${result.statusClass}` : ''
    return `evidence ${result.status}${reason}${stop}${code} · hop ${result.hop} · evidence ${result.evidence.length}`
      + ` · pool ${result.poolSize} · sent ${result.sentBlocks} · requests ${result.requestCount} · ${result.elapsedMs} ms`
  }

  function repairLog(result: RepairSuggestion): string {
    const reason = result.skipReason ? ` (${result.skipReason})` : ''
    const code = result.statusClass ? ` ${result.statusClass}` : ''
    return `repair ${result.status}${reason}${code} · groups ${result.groups.length}`
      + ` · requests ${result.requestCount} · ${result.elapsedMs} ms`
  }

  /** 「停止」/ Esc: cancels this round and the later ones; what is shown stays. Continuing is a user action. */
  function stopEvidence(): void {
    if (!evidenceRound) return
    stopEnhanceRequest()
    header = cancelledHeader()
    offerStart = true
    appendActivity('judge', 'warning', 'evidence cancelled')
  }

  function cancelledHeader(): HeaderState {
    return { kind: 'degraded', status: 'cancelled', host: null, statusClass: null, missing: null }
  }

  function markInteracted(): void {
    if (mode === 'lookup') interacted = true
  }

  /** 「顺序有更新 · 应用」/ ⌘R: show the list the latest round produced. */
  async function applyEvidence(): Promise<void> {
    if (!evidence.pending) return
    evidence = applyPending(evidence)
    await refocusActive()
  }

  /** 「恢复到第 N 轮」: that round's snapshot; no request. */
  async function restoreTo(hop: number): Promise<void> {
    evidence = restoreRound(evidence, hop)
    await refocusActive()
  }

  function isShown(round: EvidenceRound): boolean {
    return round.items.length === evidence.shown.length
      && round.items.every((item, index) => item.evidenceId === evidence.shown[index].evidenceId)
  }

  /** The selection is a row key (path and line range), so it survives a new list; move focus to its row. */
  async function refocusActive(): Promise<void> {
    await tick()
    const index = activeHit ? rows.indexOf(activeHit) : -1
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
    } catch {
      // The in-memory value still applies to this window. No error text: it may name local paths.
      change(settings.smartLookup)
      appendActivity('settings', 'error', t('smartSearch.enhance.settingsSaveFailed'))
    }
  }

  async function allowHost(host: string | null): Promise<void> {
    if (!host) return
    const mine = requestSequence
    await persistSmartLookup((value) => { value.enhance.jev.consentHost = host })
    await startEvidence(mine, 'user', evidenceDeep)
  }

  async function openEnhanceSettings(): Promise<void> {
    try {
      const { emitTo } = await import('@tauri-apps/api/event')
      await emitTo('main', OPEN_SETTINGS_TAB_EVENT, { tab: 'enhance' })
    } catch { /* Browser preview has no event bridge. */ }
  }

  /** F.4 on an evidence row (its evidence id) or a local row tiered by the evidence (its result id). */
  async function correct(hit: Row, verdict: 'fit' | 'unfit'): Promise<void> {
    const id = correctionId(hit)
    const runId = evidenceRunId
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

  async function editWording(): Promise<void> {
    if (!strip) openStrip([{ terms: store.extractedTerms.slice(0, 6), phrases: [] }])
    await tick()
    stripView?.focusFirst()
  }

  /** 「只用原问题」: back to the local result (and its evidence) from before the regrouped search. */
  async function useOriginal(): Promise<void> {
    const view = originalView
    if (!view) return
    stopEnhanceRequest()
    requestSequence += 1
    lookupBusy = false
    repaired = false
    strip = null
    repairSource = null
    repairNotice = null
    originalView = null
    lastGroups = []
    showSearch(question, view.search, view.runId, view.time)
    header = view.header
    evidence = view.evidence
    totals = view.totals
    evidenceRunId = view.evidenceRunId
    evidenceDeep = view.evidenceDeep
    localTiers = view.localTiers
    offerStart = view.offerStart
    activeKey = rows[0] ? rowKey(rows[0]) : null
    noteRecentCount(question, view.search.hits.length)
    await tick()
    inputEl?.focus()
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
    modelRequests = { ...modelRequests, repair: modelRequests.repair + result.requestCount }
    const empty = result.status === 'ok' && !result.groups.length
    appendActivity('repair', empty ? 'warning' : activityLevel(result.status), repairLog(result), { usage: result.usage })
    if (result.status === 'ok' && result.groups.length) {
      openStrip(result.groups)
      repairSource = { elapsedMs: result.elapsedMs }
      await searchWithGroups(mine, result.groups)
    } else {
      repairNotice = repairMessage(result)
    }
  }

  async function searchStripGroups(): Promise<void> {
    if (!strip) return
    const groups = strip.inputs.map(parseGroup).filter((group) => group.terms.length || group.phrases.length)
    if (!groups.length) return
    // Edited by the user: no longer the repair model's words.
    repairSource = null
    await searchWithGroups(requestSequence, groups)
  }

  /** Local search with the given wordings; the results get no evidence. */
  async function searchWithGroups(mine: number, groups: TermGroup[]): Promise<void> {
    const runId = lookupRunId
    if (!runId) return
    // A round stopped here can be continued after 「只用原问题」.
    const stoppedRound = evidenceRound !== null
    stopEnhanceRequest()
    lookupBusy = true
    try {
      const result = await serial(() => smartSearchApi.searchGroups(runId, groups, settings.smartLookup.results.limit))
      if (mine !== requestSequence) return
      if (!repaired && lastLocal) {
        originalView = {
          ...lastLocal, header, evidence, totals, evidenceRunId, evidenceDeep, localTiers, offerStart: offerStart || stoppedRound,
        }
      }
      resetEvidence()
      repaired = true
      lastGroups = groups
      showSearch(question, result.search, result.lookupRunId, result.time ?? null, result.hitGroups)
      if (strip) strip = { ...strip, counts: result.groupCounts, error: '' }
      recordAttempt('rephrased', result.search.hits.length, result.search.tookMs)
      noteRecentCount(question, result.search.hits.length)
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

  /** Marks for one row: an evidence row's round, then the tier (`tiers.*`); pinned hits get none. */
  function rowMarks(hit: Row): Array<{ kind: string; text: string }> {
    if (hit.pinned) return []
    const marks: Array<{ kind: string; text: string }> = []
    if (hit.evidence) marks.push({ kind: 'round', text: t(roundLabel(hit.evidence.foundRound)) })
    const tier = tierOf(hit)
    if (tier === 'fit') marks.push({ kind: 'fit', text: t('smartSearch.enhance.tierFit') })
    else if (tier === 'unfit') marks.push({ kind: 'unfit', text: t('smartSearch.enhance.tierUnfit') })
    if (hit.evidence) return marks
    const groups = hitGroups.get(hitKey(hit)) ?? []
    if (groups.length === 1) {
      marks.push({ kind: 'wording', text: t('smartSearch.enhance.wordingLabel', { n: wordingLetter(groups[0] - 1) }) })
    } else if (groups.length > 1) {
      marks.push({ kind: 'wording', text: groups.map((group) => wordingLetter(group - 1)).join(' + ') })
    }
    return marks
  }

  /** `10/1–10/31`; the year is added when the range spans two years. Dates are inclusive. */
  function dateRange(time: TimeWindow): string {
    const parts = (iso: string) => /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
    const after = parts(time.after)
    const before = parts(time.before)
    if (!after || !before) return `${time.after}–${time.before}`
    const withYear = after[1] !== before[1]
    const format = (match: RegExpExecArray) => `${withYear ? `${match[1]}/` : ''}${Number(match[2])}/${Number(match[3])}`
    return time.after === time.before ? format(after) : `${format(after)}–${format(before)}`
  }

  function timeModeLabel(value: TimeMode): (typeof TIME_OPTIONS)[number][1] {
    return TIME_OPTIONS.find(([option]) => option === value)?.[1] ?? 'smartSearch.enhance.timeGroup'
  }

  /** The model's verdict as the preselected correction; unsure preselects nothing. */
  function modelChoice(tier: string | undefined): 'fit' | 'unfit' | null {
    return tier === 'fit' ? 'fit' : tier === 'unfit' ? 'unfit' : null
  }

  async function focusHit(index: number): Promise<void> {
    if (!rows.length) return
    const next = Math.max(0, Math.min(index, rows.length - 1))
    activeKey = rowKey(rows[next])
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
      void focusHit(rows.length - 1)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      void openHit(rows[index])
    }
  }

  /** A pointer press on the scroll container itself (not a row) is a scrollbar drag. */
  function onListPointerDown(event: PointerEvent): void {
    if (event.target === event.currentTarget) markInteracted()
  }

  async function openHit(hit: Row | undefined): Promise<void> {
    if (!hit) return
    markInteracted()
    const preview = previewLine(hit.text, highlightTerms)
    openError = ''
    if (!hit.absPath) {
      openError = t('smartSearch.staleNavigation')
      return
    }
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

  function onInputKeydown(event: KeyboardEvent): void {
    if (ime.blocks(event)) return
    const onLaunch = mode === 'idle' && recent.length > 0 && inputValue.trim() === ''
    if (onLaunch && (event.key === 'ArrowDown' || event.key === 'ArrowUp') && !event.shiftKey) {
      event.preventDefault()
      recentIndex = event.key === 'ArrowDown'
        ? Math.min(recent.length - 1, recentIndex + 1)
        : Math.max(-1, recentIndex - 1)
    } else if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      if (onLaunch && recentIndex >= 0) runRecent(recent[recentIndex])
      else void submitLookup()
    } else if (event.key === 'ArrowDown' && !event.shiftKey && rows.length && caretOnLastLine()) {
      event.preventDefault()
      markInteracted()
      void focusHit(0)
    } else if (event.key === 'Tab' && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey
      && mode === 'lookup' && noMatchVisible) {
      // ⇥ from the no-match panel: edit the wordings. Over real results Tab moves focus as usual.
      event.preventDefault()
      void editWording()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      escape()
    }
  }

  /** Esc: close a popover, else stop the evidence run (the window stays), else hide the window. */
  function escape(): void {
    if (closePopovers()) return
    if (evidenceRound) {
      stopEvidence()
      return
    }
    void hideWindow()
  }

  function onWindowKeydown(event: KeyboardEvent): void {
    if (isImeKey(event) || event.defaultPrevented) return
    if (shortcut(event, 'k')) {
      event.preventDefault()
      void toggleMenu()
      return
    }
    if (shortcut(event, 'r')) {
      if (!evidence.pending) return
      event.preventDefault()
      void applyEvidence()
      return
    }
    if (shortcut(event, 'l')) {
      if (!noMatchVisible) return
      event.preventDefault()
      void rewriteQuestion()
      return
    }
    if (event.key !== 'Escape') return
    event.preventDefault()
    escape()
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
      if (stopped?.kind === 'evidence') {
        header = cancelledHeader()
        offerStart = true
      }
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
    if (detailsOpen && !(target instanceof Element && target.closest('.evidence-head'))) detailsOpen = false
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

{#snippet resultRow(hit: Row)}
  {@const index = rows.indexOf(hit)}
  {@const active = activeHit === hit}
  {@const marks = rowMarks(hit)}
  <div
    class="result-row"
    class:active
    class:dim={tierOf(hit) === 'unfit'}
    role="option"
    aria-selected={active}
    tabindex={active ? 0 : -1}
    data-index={index}
    data-result-id={hit.evidence ? undefined : resultIdOf(hit)}
    data-evidence-id={hit.evidence?.evidenceId}
    onclick={() => { markInteracted(); activeKey = rowKey(hit) }}
    ondblclick={() => void openHit(hit)}
    onkeydown={(event) => onRowKeydown(event, index)}
  >
    <span class="title-line">
      <strong class="result-title">{hit.evidence ? hit.evidence.title : displayTitle(hit)}</strong>
      {#if hit.evidence?.breadcrumb}<span class="result-crumb">{hit.evidence.breadcrumb}</span>{/if}
    </span>
    <p class="result-snippet">{#each highlightParts(snippet(hit), highlightTerms) as part}{#if part.hit}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}</p>
    {#if marks.length}
      <div class="result-badges">
        {#each marks as mark, markIndex (markIndex)}
          <span class="result-badge {mark.kind}">{mark.text}</span>
        {/each}
      </div>
    {/if}
  </div>
{/snippet}

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
          {@const chipText = t('smartSearch.enhance.timeChip', { range: `${time.sourceText} · ${dateRange(time)}` })}
          <div class="time-anchor chip">
            <button
              bind:this={timeChipEl}
              class="time-chip"
              aria-haspopup="menu"
              aria-expanded={timeMenuOpen}
              onclick={() => { detailsOpen = false; timeMenuOpen = !timeMenuOpen }}
            >{chipText} <small class="time-mode">{t(timeModeLabel(current))}</small></button>
            {#if current !== 'ignore'}
              <button
                class="time-clear"
                aria-label={t('smartSearch.enhance.timeIgnore')}
                title={t('smartSearch.enhance.timeIgnore')}
                onclick={() => void chooseTimeMode('ignore')}
              ><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"></path></svg></button>
            {/if}
            {#if timeMenuOpen}
              <div class="menu-panel time-menu" role="menu" aria-label={chipText}>
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
    <LaunchView
      showFirstRun={ready && !settings.smartLookup.launch.firstRunSeen}
      showEmpty={ready && settings.smartLookup.launch.firstRunSeen}
      {recent}
      counts={recentCounts}
      selected={recentIndex}
      onDismissFirstRun={() => void dismissFirstRun()}
      onRun={runRecent}
      onClear={clearRecentLookups}
    />
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
            {:else}
              <span class="judge-text" aria-live="polite">{headerText}</span>
              {#if header.kind === 'degraded'}
                {@const state = header}
                {#if state.status === 'notConfigured'}
                  <button class="text-button" onclick={() => void openEnhanceSettings()}>{t('smartSearch.enhance.openSettings')}</button>
                {:else if state.status === 'noConsent' && state.host}
                  <button class="text-button" onclick={() => void allowHost(state.host)}>{t('smartSearch.enhance.allow')}</button>
                {:else if state.status === 'timeout'}
                  <button class="text-button" onclick={() => void startEvidence(requestSequence, 'user', evidenceDeep)}>{t('smartSearch.enhance.retry')}</button>
                {:else if state.status === 'keyInvalid' || state.status === 'unreachable'}
                  <button class="text-button" onclick={() => void openEnhanceSettings()}>{t('smartSearch.enhance.openSettingsAction')}</button>
                {/if}
              {/if}
              {#if showStart}
                <button class="text-button" onclick={() => void startEvidence(requestSequence, 'user', evidenceDeep)}>{t('smartSearch.evidence.start')}</button>
              {/if}
            {/if}
          </div>
        {/if}
        {#if showRepairNotice && repairNotice}
          <div class="judge-header repair-notice">
            <span class="judge-text" aria-live="polite">{t(repairNotice.key, repairNotice.params)}</span>
          </div>
        {/if}
        {#if strip && mode === 'lookup'}
          <RepairStrip
            bind:this={stripView}
            {struckTerms}
            inputs={strip.inputs}
            counts={strip.counts}
            error={strip.error}
            busy={lookupBusy}
            summary={strip.counts && attempts
              ? { originalHits: attempts.original.hits, originalMs: attempts.original.tookMs, resultHits: store.hits.length, groups: lastGroups.length }
              : null}
            source={repairSource}
            canUseOriginal={Boolean(originalView)}
            onInput={setStripInput}
            onSearch={() => void searchStripGroups()}
            onUseOriginal={() => void useOriginal()}
          />
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
            <NoMatchPanel
              attempts={attemptRows}
              groups={lastGroups}
              struckTerms={strip ? [] : struckTerms}
              timeGrouped={lookupTime && (chosenTimeMode ?? lookupTime.mode) === 'group' ? lookupTime.sourceText : null}
              modelCalls={{ total: modelRequests.judge + modelRequests.repair, judged: modelRequests.judge > 0 }}
              {canExpand}
              busy={lookupBusy}
              {rewriteShortcut}
              onRewrite={() => void rewriteQuestion()}
              onEditWording={() => void editWording()}
              onExpand={() => void expandLookup()}
            />
          {:else if !orderedHits.length}
            <div class="state">
              <strong>{t('search.noResults')}</strong>
              <p>{t('smartSearch.noResultsHint')}</p>
            </div>
          {:else}
            <div bind:this={listEl} class="result-lists">
              {#if showEvidence}
                <section class="evidence" aria-label={t('smartSearch.evidence.title')}>
                  <div class="evidence-head">
                    <button
                      class="evidence-title group-label details-toggle"
                      aria-expanded={detailsOpen}
                      onclick={() => { timeMenuOpen = false; detailsOpen = !detailsOpen }}
                    >{t('smartSearch.evidence.title')}<span>{evidence.shown.length}</span></button>
                    {#if detailsOpen}
                      <div class="judge-details" role="dialog" aria-label={t('smartSearch.enhance.detailsTitle')}>
                        <div class="details-title">{t('smartSearch.enhance.detailsTitle')}</div>
                        {#if totals.host}<p>{t('smartSearch.enhance.detailsHost', { host: totals.host })}</p>{/if}
                        <p>{t('smartSearch.enhance.detailsRequests', { n: totals.requests, ms: totals.elapsedMs })}</p>
                        <p>{t('smartSearch.enhance.detailsSent', { n: totals.sent, tokens: totals.tokens })}</p>
                        <p>{t('smartSearch.enhance.detailsUnsent', { confidential: totals.confidential, stale: totals.stale, long: totals.long })}</p>
                      </div>
                    {/if}
                    {#if evidenceRound}
                      <div class="evidence-status">
                        <span class="spinner" aria-hidden="true"></span>
                        <span class="judge-text" aria-live="polite">{progressText}</span>
                        <button class="text-button" onclick={stopEvidence}>{t('smartSearch.enhance.stop')}</button>
                      </div>
                    {/if}
                    {#if evidence.pending}
                      <div class="evidence-status">
                        <button class="text-button" onclick={() => void applyEvidence()}>{t('smartSearch.evidence.updated')}</button>
                        <kbd>{applyShortcut}</kbd>
                      </div>
                    {/if}
                    {#if noticeKey && !evidenceRound}
                      <div class="evidence-status">
                        <span class="judge-text" aria-live="polite">{t(noticeKey)}</span>
                        {#if noticeKey === 'smartSearch.evidence.none' && !repaired}
                          <button class="text-button" onclick={() => void repairLookup(requestSequence, 'user')}>{t('smartSearch.enhance.rephrase')}</button>
                        {/if}
                      </div>
                    {/if}
                    {#each expansionRounds as round (round.hop)}
                      <p class="evidence-terms">
                        <span class="result-badge round">{t(roundLabel(round.hop))}</span>
                        {t('smartSearch.evidence.terms', { terms: round.terms.map((term) => term.label).join(', ') })}
                      </p>
                    {/each}
                    {#if !evidenceRound && evidence.rounds.length > 1}
                      <div class="evidence-restore">
                        {#each evidence.rounds as round (round.hop)}
                          {#if !isShown(round)}
                            <button class="text-button" onclick={() => void restoreTo(round.hop)}>{round.hop === 0
                              ? t('smartSearch.evidence.restoreLocal')
                              : t('smartSearch.evidence.restore', { hop: round.hop })}</button>
                          {/if}
                        {/each}
                      </div>
                    {/if}
                  </div>
                  {#if evidenceRows.length}
                    <div class="evidence-list" role="listbox" aria-label={t('smartSearch.evidence.title')}>
                      {#each evidenceRows as hit (rowKey(hit))}
                        {@render resultRow(hit)}
                      {/each}
                    </div>
                  {/if}
                </section>
              {/if}
              <div class="result-list" role="listbox" aria-label={t('smartSearch.results')}>
                {#each sections as section (section.key)}
                  <div class="result-group" role="group" aria-label={section.label}>
                    <div class="group-label" aria-hidden="true">{section.label}<span>{section.hits.length}</span></div>
                    {#each section.hits as hit (hitKey(hit))}
                      {@render resultRow(hit)}
                    {/each}
                  </div>
                {/each}
              </div>
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
            {@const id = correctionId(hit)}
            <div class="preview-location">{hitReference(hit)}</div>
            <h1 class="preview-title">{displayTitle(hit)}</h1>
            {#if id && !hit.pinned}
              {@const chosen = feedbackSaved[id] ?? modelChoice(tierOf(hit))}
              <div class="correction">
                <span>{t('smartSearch.enhance.correctPrompt')}</span>
                <span class="segmented" role="radiogroup" aria-label={t('smartSearch.enhance.correctGroup')}>
                  <button role="radio" class:on-fit={chosen === 'fit'} aria-checked={chosen === 'fit'} onclick={() => void correct(hit, 'fit')}>{t('smartSearch.enhance.correctFit')}</button>
                  <button role="radio" class:on-unfit={chosen === 'unfit'} aria-checked={chosen === 'unfit'} onclick={() => void correct(hit, 'unfit')}>{t('smartSearch.enhance.correctUnfit')}</button>
                </span>
                <span class="correction-note" role="status">{feedbackSaved[id]
                  ? t('smartSearch.enhance.correctSaved')
                  : t('smartSearch.enhance.correctNote')}</span>
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
        {#if activity.length}
          <button class="menu-row" role="menuitem" tabindex="-1" onclick={() => menuAction(() => copyText(formatWorkflowLog(activity)))}>{t('smartSearch.copyActivity')}</button>
        {/if}
      </div>
    </div>
  {/if}

  <footer class="footer">
    {#if evidenceRound}
      <span class="footer-hint"><kbd>esc</kbd> {t('smartSearch.enhance.escStop')}</span>
    {/if}
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
  /* Shared by the child views (launch, repair strip, no-match panel). */
  .lookup :global(button), .lookup :global(textarea), .lookup :global(input) { font: inherit; color: inherit; }
  .lookup :global(button:disabled) { opacity: .4; }
  .lookup :global(button:focus-visible), .result-row:focus-visible, .lookup :global(textarea:focus-visible), .lookup :global(input:focus-visible) {
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
  .time-anchor { position: relative; gap: 2px; padding-right: 4px; }
  .time-chip { padding: 0; border: 0; background: transparent; color: inherit; font: inherit; }
  .time-mode { margin-left: 4px; opacity: .8; }
  .time-clear { display: grid; place-items: center; width: 16px; height: 16px; padding: 0; border: 0; border-radius: 50%; background: transparent; color: inherit; }
  .time-clear:hover { background: var(--lookup-soft); color: CanvasText; }
  .time-menu { position: absolute; left: 0; top: calc(100% + 4px); z-index: 12; display: flex; flex-direction: column; min-width: 140px; }
  .time-menu .menu-row, .actions-menu .menu-row { border: 0; background: transparent; text-align: left; min-height: 26px; }
  .time-menu .menu-row[aria-checked='true']::before { content: '✓ '; }
  .hint-row { display: flex; align-items: center; gap: 12px; margin: 6px 2px 0; min-height: 16px; }
  .hint { margin: 0; flex: 0 0 auto; font-size: 11px; color: var(--lookup-muted); }
  .activity { flex: 1; min-width: 0; display: flex; justify-content: flex-end; align-items: center; gap: 6px; font-size: 11px; color: var(--lookup-muted); }
  .activity-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .workspace { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(260px, 42%) minmax(0, 1fr); border-top: 1px solid var(--lookup-border); }
  .results-pane, .preview-pane { min-width: 0; min-height: 0; display: flex; flex-direction: column; }
  .results-pane { border-right: 1px solid var(--lookup-border); }
  .pane-header { flex: 0 0 auto; min-height: 40px; display: flex; align-items: center; gap: 8px; padding: 0 12px 0 16px; border-bottom: 1px solid var(--lookup-border); }
  .pane-header strong { margin-right: auto; font-size: 12px; font-weight: 600; }
  .pane-header > span { color: var(--lookup-muted); font-size: 11px; white-space: nowrap; }
  .judge-header { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; min-height: 30px; padding: 0 12px 0 16px; border-bottom: 1px solid var(--lookup-border); background: var(--lookup-soft); font-size: 12px; }
  .judge-text { min-width: 0; margin-right: auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  kbd { font: inherit; font-size: 11px; color: var(--lookup-muted); }
  .menu-popover { position: absolute; left: 12px; bottom: 34px; z-index: 10; width: max-content; max-width: 280px; }
  .actions-menu { display: flex; flex-direction: column; }
  .results-scroll, .preview-scroll { flex: 1; min-height: 0; overflow-y: auto; }
  .result-group { padding: 6px 0; }
  .evidence { padding: 6px 0; border-bottom: 1px solid var(--lookup-border); background: color-mix(in srgb, var(--lookup-accent) 3%, Canvas); }
  .evidence-head { display: flex; flex-direction: column; gap: 2px; padding-bottom: 2px; }
  .evidence-title { border: 0; background: transparent; text-align: left; }
  .details-toggle { text-decoration: underline dotted; text-underline-offset: 3px; }
  .judge-details { padding: 6px 16px 8px; font-size: 12px; color: var(--lookup-muted); }
  .judge-details p { margin: 0 0 3px; }
  .details-title { margin-bottom: 4px; font-weight: 600; color: CanvasText; }
  .evidence-status { display: flex; align-items: center; gap: 8px; min-height: 22px; padding: 0 12px 0 16px; font-size: 12px; }
  .evidence-terms { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 0; padding: 0 16px; font-size: 11px; color: var(--lookup-muted); }
  .evidence-restore { display: flex; flex-wrap: wrap; gap: 2px; padding: 0 12px; }
  .result-crumb { min-width: 0; font-size: 11px; color: var(--lookup-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .group-label { display: flex; gap: 6px; padding: 4px 16px; font-size: 11px; font-weight: 600; color: var(--lookup-muted); }
  .result-row { padding: 7px 16px; border-left: 3px solid transparent; cursor: default; }
  .result-row.active { background: color-mix(in srgb, var(--lookup-accent) 9%, Canvas); border-left-color: var(--lookup-accent); }
  .result-row.dim .result-title, .result-row.dim .result-snippet { opacity: .55; }
  .title-line { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .result-title { display: block; min-width: 0; font-size: 13px; font-weight: 550; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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
  .secondary-button { margin-top: 6px; padding: 5px 12px; border: 1px solid var(--lookup-border); border-radius: 7px; background: var(--lookup-soft); }
  .text-button { padding: 2px 4px; border: 0; background: transparent; color: var(--lookup-accent); font-size: 12px; white-space: nowrap; }
  .preview-scroll { padding: 14px 18px; }
  .preview-location { font-size: 11px; color: var(--lookup-muted); word-break: break-all; }
  .preview-title { margin: 4px 0 10px; font-size: 16px; font-weight: 600; }
  .correction { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 0 0 10px; font-size: 12px; color: var(--lookup-muted); }
  .segmented { display: inline-flex; border: 1px solid var(--lookup-border); border-radius: 7px; overflow: hidden; }
  .segmented button { padding: 2px 10px; border: 0; background: transparent; font-size: 12px; }
  .segmented button + button { border-left: 1px solid var(--lookup-border); }
  .segmented .on-fit { background: color-mix(in srgb, var(--lookup-fit) 14%, transparent); color: var(--lookup-fit); }
  .segmented .on-unfit { background: color-mix(in srgb, var(--lookup-unfit) 14%, transparent); color: var(--lookup-unfit); }
  .correction-note { margin-left: auto; font-size: 11px; }
  .preview-note { margin: 0 0 8px; font-size: 12px; color: var(--lookup-muted); }
  .preview-text { margin: 0; font-size: 13px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
  .notice { margin: 0 0 12px; padding: 8px 10px; border-radius: 8px; background: var(--lookup-soft); font-size: 12px; line-height: 1.5; }
  .notice.error { background: color-mix(in srgb, #ce3030 8%, Canvas); }
  .footer-hint { margin-right: 10px; font-size: 11px; color: var(--lookup-muted); }
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
