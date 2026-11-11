<script lang="ts">
  // Smart Lookup window, answer-first (plan 2026-11-11). Typing previews and
  // Enter both read the local index at once. After an Enter the host gathers
  // evidence round by round and, once the rounds are done, the window asks
  // for a cited answer by itself (ruling A). The answer is on top, its cited
  // sources below it, and everything else behind 「其他结果」. Every run is
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
  import { loadSettings, settings } from './lib/settings.svelte'
  import { SmartSearchStore } from './lib/smart-search/store.svelte'
  import {
    smartSearchApi,
    type AnswerResult,
    type EnhanceStatus,
    type EvidenceItem,
    type EvidenceStepResult,
    type RepairSuggestion,
    type TermGroup,
    type Tier,
    type TimeWindow,
    type Trigger,
  } from './lib/smart-search/api'
  import { hitKey } from './lib/smart-search/hit-key'
  import { crumbAfterTitle, dateSections, hitReference, redactError, sourceSections, type ResultSection } from './lib/smart-search/lookup-view'
  import {
    chatAnswerConfig,
    chatRequestConfig,
    endpointHost,
    jevRequestConfig,
    repairMessage,
    shouldAutoRepair,
    type AttemptKind,
    type HeaderMessage,
    type HeaderState,
    type LookupAttempt,
  } from './lib/smart-search/enhance-flow'
  import {
    answerable,
    answerGate,
    answerParts,
    applyRound,
    confirmedCount,
    emptyEvidence,
    emptyTotals,
    evidenceReady,
    fitEvidence,
    headerFromStep,
    interruptRun,
    shouldStartEvidence,
    totalsOf,
    type AnswerGate,
    type EvidenceTotals,
    type EvidenceView,
  } from './lib/smart-search/evidence-flow'
  import {
    allJudgedUnfit,
    citedSources,
    confirmedSources,
    fallbackLine,
    footerLine,
    judgedAnything,
    lookupPhase,
    otherResults,
    statusChip,
    triedSteps,
    type LookupPhase,
    type NumberedSource,
  } from './lib/smart-search/answer-view'
  import { clearRecent, loadRecent, loadRecentCounts, rememberRecent, rememberRecentCount } from './lib/smart-search/recent'
  import LaunchView from './components/smart-lookup/LaunchView.svelte'
  import NoMatchPanel from './components/smart-lookup/NoMatchPanel.svelte'
  import RepairStrip from './components/smart-lookup/RepairStrip.svelte'
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
  /** The evidence run, repair or answer request the host is working on; `token` tells a newer one from an older one. */
  type Inflight = { runId: string; kind: 'evidence' | 'repair' | 'answer'; token: number }
  /** `order`: the attempts in the order they ran. */
  type Attempts = {
    original: LookupAttempt
    rephrased: LookupAttempt | null
    scan: LookupAttempt | null
    order: AttemptKind[]
  }
  /** A row of any list: evidence rows carry their item (and a source number) and open like local hits. */
  type Row = SearchHit & { evidence?: EvidenceItem; sourceId?: number }

  const PREVIEW_CHARS = 3_000
  const isMac = isApplePlatformSync()
  const actionsShortcut = isMac ? '⌘K' : 'Ctrl+K'

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

  let ready = $state(false)
  let mode = $state<ResultsMode>('idle')
  let question = $state('')
  let lookupBusy = $state(false)
  let lookupRunId = $state('')
  /** The row the user chose (path and line range); `null` follows the top row. */
  let activeKey = $state<string | null>(null)
  let menuOpen = $state(false)
  let openError = $state('')
  let recent = $state<string[]>(loadRecent())
  let recentCounts = $state<Record<string, number>>(loadRecentCounts())
  /** Recent lookup chosen with ↑/↓ from the empty input; -1 = none. */
  let recentIndex = $state(-1)
  /** The host's time phrase for this Enter: it groups and prioritises the local results. */
  let lookupTime = $state<TimeWindow | null>(null)

  // Evidence (spec H.8). `header` is how the latest step ended: a degraded state, a busy index, or none.
  let header = $state<HeaderState>({ kind: 'none' })
  let evidence = $state<EvidenceView>(emptyEvidence())
  /** The host refused a step outright (an error, not a status). */
  let evidenceError = $state(false)
  /** The lookup run the evidence belongs to; corrections are recorded on it. */
  let evidenceRunId = $state('')
  /** Whether that run is an expanded (deep) lookup; every round of it says so. */
  let evidenceDeep = $state(false)
  let evidenceBusy = $state(false)
  /** Local rows' tiers from the latest round (H.8: same path and line range as a scored block). */
  let localTiers = $state<Map<string, Tier>>(new Map())
  /** What this run sent, as the host totals it over the run. */
  let totals = $state<EvidenceTotals>(emptyTotals())
  /** When the evidence started, for 「正在找依据 · N 秒」; `null` when nothing runs. */
  let workStartedAt = $state<number | null>(null)
  /**
   * The automatic answer (ruling A). `answer.text` is the one remote text this
   * window shows, as plain text with numbered citations; it is never written
   * to the activity log.
   */
  let answer = $state<AnswerResult | null>(null)
  let answerBusy = $state(false)
  /** A host error for the answer request (nothing was sent, or the run expired), redacted, for the log only. */
  let answerError = $state('')
  /** The user stopped the answer; a late reply is dropped. */
  let answerStopped = $state(false)
  /** Why no answer was asked for: the answer model is not set up, or its host not allowed. */
  let answerBlocked = $state<AnswerGate | null>(null)
  /**
   * The answer host a request of this run was started with. The footer keeps
   * naming it after a stop or a hidden-window drop (final review I1): the
   * question and the passages may already have gone there. Cleared only for
   * a new run, or when the host refused the request before sending.
   */
  let answerSentHost = $state<string | null>(null)
  let otherOpen = $state(false)
  /** The narrow window shows the selected row's passage inline; Space folds it. */
  let inlineOpen = $state(true)
  let now = $state(Date.now())

  // Zero hits: rephrase once, then scan line by line (plan behaviour 6).
  let attempts = $state<Attempts | null>(null)
  let repairBusy = $state(false)
  let repairNotice = $state<HeaderMessage | null>(null)
  /** The results on screen came from other wordings: they are never judged. */
  let repaired = $state(false)
  let repairSource = $state<{ elapsedMs: number } | null>(null)
  /** The host the repair model's request went to, once one was sent. */
  let repairHost = $state<string | null>(null)
  /** The wordings of the regrouped search, and how many hits each found. */
  let lastGroups = $state<TermGroup[]>([])
  let groupCounts = $state<number[] | null>(null)
  /** Zero local hits and every automatic try ran. */
  let zeroHitsTried = $state(false)

  let inflight: Inflight | null = null
  let enhanceToken = 0
  /** Regrouped searches share the window's search ticket: never run two at once. */
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
  /** Local rows in display order, time groups first; rows tiered `unfit` are never shown in a lookup. */
  let sections = $derived(
    buildSections(store.hits, mode === 'lookup' ? lookupTime : null, settings.smartLookup.results.groupBy)
      .map((section) => ({ ...section, hits: mode === 'lookup' ? section.hits.filter((hit) => tierOf(hit) !== 'unfit') : section.hits }))
      .filter((section) => section.hits.length > 0),
  )
  let localRows = $derived<Row[]>(sections.flatMap((section) => section.hits))
  let working = $derived(evidenceBusy || answerBusy)
  let cited = $derived(citedSources(answer, evidence.shown))
  let phase = $derived<LookupPhase | null>(mode === 'lookup' && !store.error
    ? lookupPhase({ working, evidence, answer, cited: cited.length, hits: store.hits.length, zeroHitsTried })
    : null)
  let sources = $derived<NumberedSource[]>(phase === 'answer' ? cited : phase === 'sources' ? confirmedSources(evidence) : [])
  let sourceRows = $derived<Row[]>(sources.map((source) => ({ ...evidenceRow(source.item), sourceId: source.id })))
  let otherRows = $derived.by<Row[]>(() => {
    if (phase !== 'answer' && phase !== 'sources' && phase !== 'noAnswer') return []
    const other = otherResults({
      shown: evidence.shown,
      sources: sources.map((source) => source.item),
      local: store.hits,
      localTier: tierOf,
      includeUnfit: phase === 'noAnswer',
    })
    return [...other.evidence.map(evidenceRow), ...other.local]
  })
  /** Every selectable row, in screen order. */
  let rows = $derived.by<Row[]>(() => {
    if (phase === 'answer' || phase === 'sources') return [...sourceRows, ...(otherOpen ? otherRows : [])]
    if (phase === 'noAnswer') return otherOpen ? otherRows : []
    return localRows
  })
  let activeHit = $derived<Row | null>(rows.find((hit) => rowKey(hit) === activeKey) ?? rows[0] ?? null)
  let answerView = $derived(phase === 'answer' && answer?.text ? answerParts(answer.text, answer.sources) : [])
  let seconds = $derived(workStartedAt === null ? 0 : Math.max(0, Math.floor((now - workStartedAt) / 1000)))
  let searching = $derived(lookupBusy || store.loading || repairBusy)
  let chip = $derived(phase ? statusChip(phase, { seconds, sources: sources.length, busy: searching }) : null)
  let fallback = $derived(phase ? fallbackLine({
    phase,
    header,
    evidence,
    disabled: !settings.smartLookup.enhance.enabled && !repaired && store.hits.length > 0,
    evidenceError,
    jevHost: endpointHost(settings.smartLookup.enhance.jev.url),
    answerGate: answerBlocked,
    answer,
    answerStopped,
  }) : null)
  let confirmed = $derived(confirmedCount(evidence))
  let footer = $derived(mode === 'lookup' ? footerLine({
    working: working || repairBusy,
    hosts: [
      totals.host ?? (evidenceBusy ? endpointHost(settings.smartLookup.enhance.jev.url) : null),
      repairHost ?? (repairBusy ? endpointHost(settings.smartLookup.enhance.chat.url, 'chat') : null),
      answerBusy ? endpointHost(settings.smartLookup.enhance.chat.url, 'chat')
        : answer ? (answer.requestCount > 0 ? answer.endpointHost ?? endpointHost(settings.smartLookup.enhance.chat.url, 'chat') : null)
          : answerSentHost,
    ],
    sent: totals.sent,
  }, t('smartSearch.footer.hostSeparator')) : null)
  /**
   * The try whose hits the evidence rounds checked, when every one of them was judged unfit (final
   * review I4): hits the host never judged (confidential, over-long, beyond the candidates) are not "unrelated".
   */
  let judgedAttempt = $derived<AttemptKind | null>(judgedAnything(evidence) && allJudgedUnfit(store.hits, tierOf)
    ? (evidenceDeep ? 'scan' : 'original')
    : null)
  /** The no-answer view says 「都不相关」 only when every row behind 「其他结果」 was judged unfit. */
  let otherAllUnfit = $derived(phase === 'noAnswer' && allJudgedUnfit(otherRows, tierOf))
  let tried = $derived(attempts ? triedSteps(attempts, lastGroups, judgedAttempt, t('smartSearch.footer.hostSeparator')) : [])
  /** ⌘K 「扩大查找」, until the line-by-line scan has run for this question (automatically or from the menu). */
  let canExpand = $derived(Boolean(lookupRunId) && !attempts?.scan && (store.hits.length === 0 || store.deepAvailable))
  /** What is running locally; the activity log's own lines stay in the log (⌘K). */
  let activityText = $derived(
    repairBusy ? t('smartSearch.enhance.repairing')
      : lookupBusy || store.loading ? t('smartSearch.searching')
        : '',
  )

  $effect(() => {
    const title = t('smartSearch.windowTitle')
    void appWindow.setTitle(title).catch(() => {})
  })

  $effect(() => {
    // The status chip shows seconds; tick only while the evidence or the answer runs.
    if (!working) return
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

  /** Make every running lookup, preview, evidence run, repair and answer stale; cancel the host request. */
  function supersede(): number {
    requestSequence += 1
    lookupBusy = false
    stopEnhanceRequest()
    return requestSequence
  }

  /** Cancel the evidence run, repair or answer request in flight (if any); returns it. */
  function stopEnhanceRequest(): Inflight | null {
    const current = inflight
    inflight = null
    evidenceBusy = false
    repairBusy = false
    answerBusy = false
    workStartedAt = null
    if (current) void smartSearchApi.cancel(current.runId).catch(() => {})
    return current
  }

  function serial<T>(work: () => Promise<T>): Promise<T> {
    const next = hostChain.then(work, work)
    hostChain = next.catch(() => {})
    return next
  }

  function resetEvidence(): void {
    header = { kind: 'none' }
    evidence = emptyEvidence()
    evidenceError = false
    evidenceRunId = ''
    evidenceDeep = false
    evidenceBusy = false
    localTiers = new Map()
    totals = emptyTotals()
    workStartedAt = null
    otherOpen = false
    clearAnswer()
    answerSentHost = null
  }

  /** Drops the answer shown and cancels one in flight: it no longer matches the evidence. */
  function clearAnswer(): void {
    if (inflight?.kind === 'answer') stopEnhanceRequest()
    answer = null
    answerBusy = false
    answerError = ''
    answerStopped = false
    answerBlocked = null
  }

  function resetRepair(): void {
    attempts = null
    repairNotice = null
    repaired = false
    repairSource = null
    repairHost = null
    lastGroups = []
    groupCounts = null
    zeroHitsTried = false
  }

  function startAttempts(hits: number, tookMs: number): void {
    attempts = { original: { kind: 'original', hits, tookMs }, rephrased: null, scan: null, order: ['original'] }
  }

  function recordAttempt(kind: 'rephrased' | 'scan', hits: number, tookMs: number): void {
    if (!attempts) return
    const order = attempts.order.includes(kind) ? attempts.order : [...attempts.order, kind]
    attempts = { ...attempts, [kind]: { kind, hits, tookMs }, order }
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
    lookupRunId = ''
    openError = ''
    resetEvidence()
    resetRepair()
    resetActivity()
    lookupTime = null
    activeKey = null
    if (decision.kind === 'clear') {
      store.clear()
      mode = 'idle'
      question = ''
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

  // ---- rows ----

  function resultIdOf(hit: SearchHit): string | undefined {
    return (hit as SmartSearchHit).resultId
  }

  /** Selection identity: path and line range (H.8). A block is listed once, so this names one row. */
  function rowKey(hit: Pick<SearchHit, 'path' | 'line' | 'lineEnd'>): string {
    return hitKey(hit)
  }

  /**
   * An evidence item as a row: local vault text only. The host computes the
   * absolute path from the run's vault root, as for local hits.
   */
  function evidenceRow(item: EvidenceItem): Row {
    return {
      path: item.path,
      absPath: item.absPath,
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
  function correctionId(hit: Row | null): string | undefined {
    if (!hit || hit.pinned) return undefined
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

  // ---- lookup (Enter) and expanded lookup ----

  /**
   * Starts a new result set for `submitted`. `keepZeroState` keeps the
   * no-match attempts (expanding a zero-hit lookup).
   */
  function beginLookup(submitted: string, options: { keepActivity?: boolean; keepZeroState?: boolean } = {}): number {
    cancelPreview()
    closeMenu(false)
    const mine = supersede()
    store.cancel()
    lookupRunId = ''
    openError = ''
    resetEvidence()
    const keptAttempts = attempts
    resetRepair()
    if (options.keepZeroState) attempts = keptAttempts
    if (options.keepActivity) startedAt = performance.now()
    else resetActivity()
    activeKey = null
    question = submitted
    mode = 'lookup'
    return mine
  }

  /** Enter; pressing it again retries everything. */
  async function submitLookup(): Promise<void> {
    const submitted = inputValue.trim()
    if (!submitted) return
    recent = rememberRecent(submitted)
    const mine = beginLookup(submitted)
    const first = await runLocal(mine, submitted, false)
    if (!first) return
    startAttempts(first.hits, first.tookMs)
    if (first.hits > 0) {
      await startEvidence(mine, 'auto', false)
      return
    }
    await afterZeroHits(mine)
  }

  /** ⌘K 「扩大查找」: the existing deep lookup, as a new run. */
  async function expandLookup(): Promise<void> {
    const submitted = question
    if (!submitted) return
    const mine = beginLookup(submitted, { keepActivity: true, keepZeroState: true })
    const scan = await runLocal(mine, submitted, true)
    if (!scan) return
    recordAttempt('scan', scan.hits, scan.tookMs)
    if (scan.hits > 0) await startEvidence(mine, 'user', true)
    else zeroHitsTried = true
  }

  /** One `smart_lookup_local` call; shows its result. `null` when stale or failed. */
  async function runLocal(mine: number, submitted: string, deep: boolean): Promise<{ hits: number; tookMs: number } | null> {
    lookupBusy = true
    if (deep) appendActivity('search', 'active', t('smartSearch.activityDeepStart'))
    const limit = settings.smartLookup.results.limit
    try {
      const result = await smartSearchApi.localLookup(submitted, deep
        ? { limit, deep: true, timeoutMs: settings.smartLookup.results.deepTimeoutMs }
        : { limit, deep: false })
      if (mine !== requestSequence) return null
      // The question itself, not other wordings.
      repaired = false
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

  function showSearch(submitted: string, search: SmartSearchResponse, runId: string, time: TimeWindow | null): void {
    store.apply(submitted, search)
    lookupRunId = runId
    lookupTime = time
    activeKey = null
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

  /**
   * Zero hits (plan behaviour 6): rephrase once when a repair model is set up
   * and its host allowed (only the question and search terms are sent; without
   * that consent the rephrase is skipped, `shouldAutoRepair`); if that finds nothing
   * either, scan every file line by line when `autoDeepOnZero` is on. Hits
   * from the scan get evidence; hits from other wordings are never judged.
   */
  async function afterZeroHits(mine: number): Promise<void> {
    const keys = await smartSearchApi.keyStatus().catch(() => null)
    if (mine !== requestSequence) return
    // The rephrase sends the question to the answer model's host: never from a hidden window.
    const hidden = keys && shouldAutoRepair(store.hits.length, settings.smartLookup, keys) ? await windowHidden() : false
    if (mine !== requestSequence) return
    if (hidden) appendActivity('repair', 'warning', 'repair not requested (window hidden)')
    else if (keys && shouldAutoRepair(store.hits.length, settings.smartLookup, keys)) {
      await repairLookup(mine, 'auto')
      if (mine !== requestSequence) return
      if (repaired && store.hits.length > 0) return
    }
    if (settings.smartLookup.results.autoDeepOnZero) {
      const scan = await runLocal(mine, question, true)
      if (!scan) return
      recordAttempt('scan', scan.hits, scan.tookMs)
      if (scan.hits > 0) {
        await startEvidence(mine, 'auto', true)
        return
      }
    }
    zeroHitsTried = true
  }

  // ---- evidence ----

  /**
   * The evidence for the run on screen. It starts on its own (`auto`) only
   * when `shouldStartEvidence` holds; otherwise the fallback line says what is
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
   * user stops, or a newer lookup supersedes it. Never two steps on one run;
   * `auto` continues as `auto` only on the run it started on; a
   * `roundRunning` answer is ignored entirely. Rounds apply as they arrive. A
   * failed round is dropped whole: after a scored round with confirmed
   * evidence the answer is written from that evidence (I5), otherwise the
   * local results stay as they are. A stopped round is dropped. When the
   * rounds finish with confirmed evidence, the answer starts (ruling A).
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
      evidenceRunId = runId
    }
    header = { kind: 'none' }
    evidenceError = false
    // New rounds change the evidence an answer cites.
    clearAnswer()
    evidenceBusy = true
    workStartedAt = Date.now()
    const deep = evidenceDeep
    for (;;) {
      // A window hidden by the global shortcut is closed for the user: stop as Esc does, before anything more is sent.
      const hidden = await windowHidden()
      if (inflight?.token !== token || mine !== requestSequence) return
      if (hidden) {
        stopEvidence('window hidden')
        return
      }
      let result: EvidenceStepResult
      try {
        result = await smartSearchApi.evidenceStep(runId, jevRequestConfig(settings.smartLookup), trigger, deep)
      } catch (error) {
        if (inflight?.token !== token || mine !== requestSequence) return
        inflight = null
        evidenceBusy = false
        evidenceError = true
        appendActivity('judge', 'error', `evidence failed: ${redactError(error)}`)
        // A later round that fails keeps what the earlier ones confirmed (I5).
        evidence = interruptRun(evidence)
        if (answerable(evidence)) await startAnswer(mine)
        else workStartedAt = null
        return
      }
      // What the host sent is the run's, whether or not this result is still wanted: after
      // a stop the round that was already out is counted (final review I2). A roundRunning
      // answer predates the round that holds the run, so it says nothing new.
      if (mine === requestSequence && evidenceRunId === runId && result.skipReason !== 'roundRunning'
        && result.run.elapsedMs >= totals.elapsedMs) {
        totals = totalsOf(result)
      }
      if (inflight?.token !== token || mine !== requestSequence) return
      // Hidden while the round was out: drop it, as Esc drops a late round, and cancel the run.
      const hiddenNow = await windowHidden()
      if (inflight?.token !== token || mine !== requestSequence) return
      if (hiddenNow) {
        stopEvidence('window hidden')
        return
      }
      // The previous round still holds the run (a restart right after a stop): nothing was sent or applied.
      if (result.skipReason === 'roundRunning') break
      appendActivity('judge', activityLevel(result.status), evidenceLog(result), { usage: result.usage })
      evidence = applyRound(evidence, result)
      if (result.status === 'ok') localTiers = new Map(result.localTiers.map((verdict) => [verdict.resultId, verdict.tier]))
      header = headerFromStep(result)
      if (result.done || result.status !== 'ok') break
    }
    inflight = null
    evidenceBusy = false
    // Finished, or a later round failed after earlier ones confirmed evidence (I5): answer from it.
    if (answerable(evidence)) await startAnswer(mine)
    else workStartedAt = null
  }

  /** Ruling A: write the answer by itself when the answer model's host is allowed; otherwise say why not. */
  async function startAnswer(mine: number): Promise<void> {
    const gate = answerGate(settings.smartLookup)
    if (gate.kind !== 'start') {
      workStartedAt = null
      answerBlocked = gate
      appendActivity('answer', 'warning', `answer not requested (${gate.kind})`)
      return
    }
    // Nothing is sent from a hidden window: the run is cancelled as Esc would, and Return asks again.
    const hidden = await windowHidden()
    if (mine !== requestSequence) return
    if (hidden) {
      const runId = evidenceRunId
      workStartedAt = null
      answerStopped = true
      if (runId) void smartSearchApi.cancel(runId).catch(() => {})
      appendActivity('answer', 'warning', 'answer not requested (window hidden)')
      return
    }
    await generateAnswer(mine)
  }

  /**
   * Whether the window is hidden. The global shortcut hides it without
   * telling the page, so the window asks before each step and before the
   * answer. It fails closed: when the window cannot say (a missing
   * `core:window:allow-is-visible` permission, no Tauri window), it counts as
   * hidden and nothing more is sent.
   */
  async function windowHidden(): Promise<boolean> {
    try {
      return !(await appWindow.isVisible())
    } catch {
      return true
    }
  }

  /**
   * One call with the confirmed evidence on screen, in its order; the host
   * re-checks every passage, needs consent for the answer model's host and
   * sends at most three requests.
   */
  async function generateAnswer(mine: number): Promise<void> {
    const runId = evidenceRunId
    if (!runId || mine !== requestSequence) return
    const token = ++enhanceToken
    const shownIds = fitEvidence(evidence).map((item) => item.evidenceId)
    inflight = { runId, kind: 'answer', token }
    answer = null
    answerError = ''
    answerStopped = false
    answerBlocked = null
    answerBusy = true
    if (workStartedAt === null) workStartedAt = Date.now()
    answerSentHost = endpointHost(settings.smartLookup.enhance.chat.url, 'chat')
    let result: AnswerResult
    try {
      result = await smartSearchApi.answer(runId, chatAnswerConfig(settings.smartLookup), shownIds)
    } catch (error) {
      if (inflight?.token !== token || mine !== requestSequence) return
      // The host refuses before sending anything (a budget code, an expired run).
      answerSentHost = null
      inflight = null
      answerBusy = false
      workStartedAt = null
      answerError = redactError(error)
      appendActivity('answer', 'error', `answer failed: ${answerError}`)
      return
    }
    if (inflight?.token !== token || mine !== requestSequence) return
    // Hidden while the answer was written: drop it, as Esc drops a late answer.
    const hidden = await windowHidden()
    if (inflight?.token !== token || mine !== requestSequence) return
    if (hidden) {
      stopAnswer('window hidden')
      return
    }
    inflight = null
    answerBusy = false
    workStartedAt = null
    answer = result
    appendActivity('answer', result.status === 'ok' ? 'success' : 'warning', answerLog(result), { usage: result.usage })
  }

  /** Esc while answering: cancels the run's request; a late answer is dropped. */
  function stopAnswer(reason = ''): void {
    if (!answerBusy || inflight?.kind !== 'answer') return
    stopEnhanceRequest()
    answerStopped = true
    appendActivity('answer', 'warning', reason ? `answer cancelled (${reason})` : 'answer cancelled')
  }

  /** Status and counts only: never the answer, never the host, never note text. */
  function answerLog(result: AnswerResult): string {
    const code = result.statusClass ? ` ${result.statusClass}` : ''
    return `answer ${result.status}${code} · sources ${result.sources.length} · omitted ${result.omittedSources}`
      + ` · requests ${result.requestCount} · ${result.elapsedMs} ms`
  }

  /** A citation chip: select its source. */
  async function showCited(evidenceId: string): Promise<void> {
    const target = sourceRows.find((row) => row.evidence?.evidenceId === evidenceId)
    if (!target) return
    choose(target)
    await refocusActive()
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

  /** Esc while the rounds run: cancels this round and the later ones; no answer is written. Return retries. */
  function stopEvidence(reason = ''): void {
    if (!evidenceBusy) return
    stopEnhanceRequest()
    header = { kind: 'degraded', status: 'cancelled', host: null, statusClass: null, missing: null }
    appendActivity('judge', 'warning', reason ? `evidence cancelled (${reason})` : 'evidence cancelled')
  }

  /** The user picked a row: the selection follows it (path and line range) while it stays listed. */
  function choose(hit: Row): void {
    if (rowKey(hit) !== activeKey) inlineOpen = true
    activeKey = rowKey(hit)
  }

  async function refocusActive(): Promise<void> {
    await tick()
    const index = activeHit ? rows.indexOf(activeHit) : -1
    if (index < 0) return
    const row = listEl?.querySelector<HTMLElement>(`.result-row[data-index="${index}"]`)
    row?.focus()
    row?.scrollIntoView?.({ block: 'nearest' })
  }

  async function openEnhanceSettings(): Promise<void> {
    try {
      const { emitTo } = await import('@tauri-apps/api/event')
      await emitTo('main', OPEN_SETTINGS_TAB_EVENT, { tab: 'enhance' })
    } catch { /* Browser preview has no event bridge. */ }
  }

  /** ⌘K 「标为符合」/「标为不相关」 (ruling C): F.4 on the selected row, recorded on this device only. */
  async function correctActive(verdict: 'fit' | 'unfit'): Promise<void> {
    const id = correctionId(activeHit)
    const runId = evidenceRunId
    if (!id || !runId) return
    try {
      await smartSearchApi.feedback(runId, id, verdict)
      flash(t('smartSearch.enhance.correctSaved'))
    } catch (error) {
      appendActivity('judge', 'error', `feedback failed: ${redactError(error)}`)
    }
  }

  // ---- repair ----

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
    // Hidden while the rephrase was out: drop its wordings, as a late round or answer is dropped.
    const hidden = await windowHidden()
    if (inflight?.token !== token || mine !== requestSequence) return
    inflight = null
    repairBusy = false
    if (hidden) {
      appendActivity('repair', 'warning', 'repair dropped (window hidden)')
      return
    }
    if (!result) {
      appendActivity('repair', 'error', `repair failed: ${failure}`)
      return
    }
    if (result.requestCount > 0 && result.endpointHost) repairHost = result.endpointHost
    const empty = result.status === 'ok' && !result.groups.length
    appendActivity('repair', empty ? 'warning' : activityLevel(result.status), repairLog(result), { usage: result.usage })
    if (result.status === 'ok' && result.groups.length) {
      repairSource = { elapsedMs: result.elapsedMs }
      await searchWithGroups(mine, result.groups)
    } else {
      repairNotice = repairMessage(result)
    }
  }

  /** Local search with the repair model's wordings; the results get no evidence. */
  async function searchWithGroups(mine: number, groups: TermGroup[]): Promise<void> {
    const runId = lookupRunId
    if (!runId) return
    stopEnhanceRequest()
    lookupBusy = true
    try {
      const result = await serial(() => smartSearchApi.searchGroups(runId, groups, settings.smartLookup.results.limit))
      if (mine !== requestSequence) return
      resetEvidence()
      repaired = true
      lastGroups = groups
      groupCounts = result.groupCounts
      showSearch(question, result.search, result.lookupRunId, result.time ?? null)
      recordAttempt('rephrased', result.search.hits.length, result.search.tookMs)
      noteRecentCount(question, result.search.hits.length)
      logSearch(result.search)
    } catch (error) {
      if (mine !== requestSequence) return
      appendActivity('search', 'error', `${t('smartSearch.searchError')}: ${redactError(error)}`)
    } finally {
      if (mine === requestSequence) lookupBusy = false
    }
  }

  // ---- launch view ----

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

  function displayTitle(hit: Row): string {
    if (hit.evidence) return hit.evidence.title
    return hit.breadcrumb || basename(hit.path).replace(/\.(md|mdx|markdown)$/i, '')
  }

  function snippet(hit: SearchHit): string {
    return previewLine(hit.text, highlightTerms).text || hit.text.slice(0, 240)
  }

  function previewText(hit: SearchHit): string {
    return Array.from(hit.text.slice(0, PREVIEW_CHARS * 2)).slice(0, PREVIEW_CHARS).join('')
  }

  /** `notes/a.md · 第 42–44 行`. */
  function locationLabel(hit: SearchHit): string {
    const lines = hit.lineEnd > hit.line
      ? t('smartSearch.preview.lines', { from: hit.line, to: hit.lineEnd })
      : t('smartSearch.preview.line', { n: hit.line })
    return `${hit.path} · ${lines}`
  }

  async function focusHit(index: number): Promise<void> {
    if (!rows.length) return
    const next = Math.max(0, Math.min(index, rows.length - 1))
    choose(rows[next])
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
      void focusHit(rows.length - 1)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      void openHit(rows[index])
    } else if (event.key === ' ' && narrowWindow()) {
      // The narrow window folds the inline passage; the wide one leaves Space alone.
      event.preventDefault()
      inlineOpen = !inlineOpen
    }
  }

  /** The Compact board's layout: the same width as the stylesheet's narrow media query. */
  function narrowWindow(): boolean {
    try {
      return window.matchMedia?.('(max-width: 719.98px)').matches ?? false
    } catch {
      return false
    }
  }

  async function openHit(hit: Row | undefined): Promise<void> {
    if (!hit) return
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
      void focusHit(0)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      escape()
    }
  }

  /** Esc: stop the evidence rounds or the answer (the window stays), else hide the window. */
  function escape(): void {
    if (evidenceBusy) {
      stopEvidence()
      return
    }
    if (answerBusy) {
      stopAnswer()
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
    if (event.key !== 'Escape') return
    event.preventDefault()
    escape()
  }

  async function hideWindow(): Promise<void> {
    cancelPreview()
    closeMenu(false)
    // Esc stops the rounds or the answer before it gets here, so only a lookup or a repair can still run.
    if (lookupBusy || store.loading || inflight) {
      supersede()
      store.cancel()
      appendActivity('search', 'warning', t('smartSearch.stopped'))
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
    const target = event.target as Node | null
    if (menuOpen && !(target && (menuEl?.contains(target) || menuButton?.contains(target)))) closeMenu(false)
  }

  function menuAction(action: () => unknown): void {
    closeMenu()
    void action()
  }

  function flash(text: string): void {
    copyStatus = text
    clearTimeout(copyTimer)
    copyTimer = setTimeout(() => { copyStatus = '' }, 2_500)
  }

  async function copyText(value: string): Promise<void> {
    try {
      try {
        const { writeText } = await import('@tauri-apps/plugin-clipboard-manager')
        await writeText(value)
      } catch {
        await navigator.clipboard.writeText(value)
      }
      flash(t('smartSearch.copyDone'))
    } catch {
      flash(t('smartSearch.copyFailed'))
    }
  }
</script>

<svelte:window onkeydown={onWindowKeydown} onpointerdown={onWindowPointerDown} />

{#snippet resultRow(hit: Row)}
  {@const index = rows.indexOf(hit)}
  {@const active = activeHit === hit}
  {@const crumb = hit.evidence ? crumbAfterTitle(hit.evidence.title, hit.evidence.breadcrumb) : ''}
  <div
    class="result-row"
    class:active
    class:dim={phase === 'noAnswer' && tierOf(hit) === 'unfit'}
    class:source={hit.sourceId !== undefined}
    role="option"
    aria-selected={active}
    tabindex={active ? 0 : -1}
    id={hit.sourceId !== undefined ? `source-${hit.sourceId}` : undefined}
    data-index={index}
    data-result-id={hit.evidence ? undefined : resultIdOf(hit)}
    data-evidence-id={hit.evidence?.evidenceId}
    onclick={() => choose(hit)}
    ondblclick={() => void openHit(hit)}
    onkeydown={(event) => onRowKeydown(event, index)}
  >
    {#if hit.sourceId !== undefined}<span class="num" aria-hidden="true">{hit.sourceId}</span>{/if}
    <span class="row-body">
      <span class="title-line">
        <strong class="result-title">{displayTitle(hit)}</strong>
        {#if crumb}<span class="result-crumb">› {crumb}</span>{/if}
      </span>
      <span class="result-snippet">{#each highlightParts(snippet(hit), highlightTerms) as part}{#if part.hit}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}</span>
      {#if active && inlineOpen && mode === 'lookup'}
        <!-- The narrow window (Compact board): the passage expands in place of the preview pane. -->
        <span class="inline-passage">
          <span class="inline-text">{previewText(hit)}</span>
          <span class="inline-actions">
            <button class="text-button" onclick={(event) => { event.stopPropagation(); void openHit(hit) }}>{t('smartSearch.openEditor')} ↗</button>
            <span class="inline-hint"><kbd>␣</kbd> {t('smartSearch.inline.collapse')}</span>
          </span>
        </span>
      {/if}
    </span>
  </div>
{/snippet}

{#snippet localList(label: string)}
  <span class="list-label">{label}</span>
  <div class="result-list local-list" role="listbox" aria-label={label}>
    {#each sections as section (section.key)}
      <div class="result-group" role="group" aria-label={section.label}>
        <div class="group-label" aria-hidden="true">{section.label}<span>{section.hits.length}</span></div>
        {#each section.hits as hit (rowKey(hit))}
          {@render resultRow(hit)}
        {/each}
      </div>
    {/each}
  </div>
{/snippet}

{#snippet otherDisclosure(label: string)}
  {#if otherRows.length}
    <button class="more" aria-expanded={otherOpen} onclick={() => { otherOpen = !otherOpen }}>
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" aria-hidden="true"><path d={otherOpen ? 'M6 9l6 6 6-6' : 'M9 6l6 6-6 6'}></path></svg>
      {label}
    </button>
    {#if otherOpen}
      <div class="result-list other-list" role="listbox" aria-label={label}>
        {#each otherRows as hit (rowKey(hit))}
          {@render resultRow(hit)}
        {/each}
      </div>
    {/if}
  {/if}
{/snippet}

<main class="lookup">
  <section class="query-bar" aria-label={t('smartSearch.windowTitle')}>
    <div class="query-row">
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
      {#if chip}
        <span class="status-chip" class:working={phase === 'working'} class:grounded={phase === 'answer' || phase === 'sources'} role="status">
          {#if phase === 'working'}<span class="spinner" aria-hidden="true"></span>
          {:else if phase === 'answer' || phase === 'sources'}<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l4 4 10-10"></path></svg>{/if}
          {t(chip.key, chip.params)}
        </span>
      {/if}
    </div>
    <div class="hint-row">
      <p class="hint">{t('smartSearch.inputHint')}</p>
      <span class="activity" role="status" aria-label={t('smartSearch.activityTitle')}>
        {#if searching}<span class="spinner" aria-hidden="true"></span>{/if}
        <span class="activity-text">{activityText}</span>
        <span class="copy-status">{copyStatus}</span>
      </span>
    </div>
  </section>

  {#if mode === 'idle'}
    <LaunchView
      showEmpty={ready}
      {recent}
      counts={recentCounts}
      selected={recentIndex}
      onRun={runRecent}
      onClear={clearRecentLookups}
    />
  {:else}
    <section class="workspace">
      <aside class="results-pane" aria-label={phase === 'answer' || phase === 'working' ? t('smartSearch.answer.label') : t('smartSearch.results')}>
        {#if mode === 'preview'}
          <header class="pane-header">
            <strong>{t('smartSearch.quickPreview')}</strong>
            <span>{t('smartSearch.resultsCount', { n: localRows.length })}</span>
          </header>
        {/if}
        <div bind:this={listEl} class="results-scroll" aria-busy={searching}>
          {#if store.error}
            <div class="state error" role="alert">
              <strong>{t('smartSearch.searchError')}</strong>
              <p>{store.error}</p>
              <button class="secondary-button" onclick={() => void submitLookup()}>{t('smartSearch.retry')}</button>
            </div>
          {:else if mode === 'preview'}
            {#if localRows.length}
              {@render localList(t('smartSearch.quickPreview'))}
            {:else if store.loading}
              <div class="state"><span class="spinner" aria-hidden="true"></span><p>{t('smartSearch.searching')}</p></div>
            {:else}
              <div class="state"><strong>{t('search.noResults')}</strong><p>{t('smartSearch.noResultsHint')}</p></div>
            {/if}
          {:else}
            <div class="answer-area">
              {#if fallback}
                <p class="fallback-line" role="status">
                  {t(fallback.key, fallback.reason ? { ...fallback.params, reason: t(fallback.reason) } : fallback.params)}
                  {#if fallback.settings}<button class="text-button" onclick={() => void openEnhanceSettings()}>{t('smartSearch.enhance.openSettings')}</button>{/if}
                </p>
              {/if}
              {#if phase === 'working'}
                <section class="answer-box progress" aria-label={t('smartSearch.answer.label')}>
                  <span class="list-label">{t('smartSearch.answer.label')}</span>
                  <ol class="steps">
                    <li class="step done"><span class="dot" aria-hidden="true"></span>{t('smartSearch.progress.local', { n: store.hits.length })}</li>
                    <li class="step" class:on={evidenceBusy} class:done={!evidenceBusy}><span class="dot" aria-hidden="true"></span>{confirmed === null
                      ? t('smartSearch.progress.check')
                      : t('smartSearch.progress.checkConfirmed', { n: confirmed })}</li>
                    <li class="step" class:on={answerBusy}><span class="dot" aria-hidden="true"></span>{t('smartSearch.progress.write')}</li>
                  </ol>
                </section>
                {#if localRows.length}{@render localList(t('smartSearch.answer.localFirst'))}{/if}
              {:else if phase === 'answer' || phase === 'sources'}
                {#if phase === 'answer' && answer}
                  <section class="answer-block" aria-label={t('smartSearch.answer.label')}>
                    <span class="list-label">{t('smartSearch.answer.label')}</span>
                    <!-- Plain text only (H.4): interpolation escapes everything; only cited numbers become chips. -->
                    <p class="answer-text">{#each answerView as part}{#if part.kind === 'cite'}<a
                      class="cite"
                      href={`#source-${part.id}`}
                      data-cite={part.evidenceId}
                      aria-label={t('smartSearch.answer.cite', { n: part.id })}
                      onclick={(event) => { event.preventDefault(); void showCited(part.evidenceId) }}
                    >{part.text}</a>{:else}{part.text}{/if}{/each}</p>
                    {#if answer.omittedSources > 0}
                      <p class="answer-note">{t('smartSearch.answer.omitted', { count: answer.omittedSources })}</p>
                    {/if}
                  </section>
                {/if}
                <span class="list-label">{t('smartSearch.answer.sources')}</span>
                <div class="result-list source-list" role="listbox" aria-label={t('smartSearch.answer.sources')}>
                  {#each sourceRows as hit (rowKey(hit))}
                    {@render resultRow(hit)}
                  {/each}
                </div>
                {@render otherDisclosure(t('smartSearch.answer.other', { n: otherRows.length }))}
              {:else if phase === 'noAnswer'}
                <NoMatchPanel
                  steps={tried}
                  notice={repairNotice ? t(repairNotice.key, repairNotice.params) : ''}
                  confidential={totals.skippedConfidential}
                />
                {@render otherDisclosure(t(otherAllUnfit ? 'smartSearch.answer.otherUnrelated' : 'smartSearch.answer.other', { n: otherRows.length }))}
              {:else if localRows.length}
                {#if repaired && attempts}
                  <RepairStrip
                    summary={{ originalHits: attempts.original.hits ?? 0, originalMs: attempts.original.tookMs ?? 0, resultHits: store.hits.length }}
                    groups={lastGroups}
                    counts={groupCounts}
                    source={repairSource}
                  />
                {/if}
                {@render localList(t('smartSearch.localResults'))}
              {:else if searching}
                <div class="state"><span class="spinner" aria-hidden="true"></span><p>{activityText}</p></div>
              {:else}
                <div class="state"><strong>{t('search.noResults')}</strong><p>{t('smartSearch.noResultsHint')}</p></div>
              {/if}
            </div>
          {/if}
        </div>
      </aside>

      <article class="preview-pane" aria-label={t('smartSearch.currentResult')}>
        <header class="pane-header preview-header">
          {#if activeHit}
            {@const hit = activeHit}
            <span class="preview-location">{locationLabel(hit)}</span>
            <button class="text-button" onclick={() => void openHit(hit)}>{t('smartSearch.openEditor')} ↗</button>
          {:else}
            <strong>{t('smartSearch.previewTab')}</strong>
          {/if}
        </header>
        <div class="preview-scroll">
          {#if openError}<p class="notice error" role="alert">{openError}</p>{/if}
          {#if activeHit}
            {@const hit = activeHit}
            <h1 class="preview-title">{displayTitle(hit)}</h1>
            {#if hit.level !== 'line' || hit.text.length > PREVIEW_CHARS}
              <p class="preview-note">{t('smartSearch.previewLimited')}</p>
            {/if}
            <p class="preview-text" class:cited={hit.sourceId !== undefined}>{#each highlightParts(previewText(hit), highlightTerms) as part}{#if part.hit}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}</p>
          {:else if phase === 'noAnswer'}
            <p class="state">{t('smartSearch.answer.noPassage')}</p>
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
        {#if evidenceRunId && correctionId(activeHit)}
          <button class="menu-row" role="menuitem" tabindex="-1" onclick={() => menuAction(() => correctActive('fit'))}>{t('smartSearch.menu.markFit')}</button>
          <button class="menu-row" role="menuitem" tabindex="-1" onclick={() => menuAction(() => correctActive('unfit'))}>{t('smartSearch.menu.markUnfit')}</button>
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
    {#if footer}
      <span class="footer-line wide">{t(footer.wide.key, footer.wide.params)}</span>
      <span class="footer-line compact" aria-hidden="true">{t(footer.compact.key, footer.compact.params)}</span>
    {/if}
    <span class="spacer"></span>
    {#if mode === 'idle' && ready && evidenceReady(settings.smartLookup)}
      <button class="enhance-chip" onclick={() => void openEnhanceSettings()}><span class="dot" aria-hidden="true"></span>{t('smartSearch.launch.enhanceOn')}</button>
    {/if}
    <span class="footer-hint"><kbd>esc</kbd> {working ? t('smartSearch.footer.escStop') : t('smartSearch.footer.escClose')}</span>
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
  }
  /* Shared by the child views (launch, repair strip, no-answer panel). */
  .lookup :global(button), .lookup :global(textarea), .lookup :global(input) { font: inherit; color: inherit; }
  .lookup :global(button:disabled) { opacity: .4; }
  .lookup :global(button:focus-visible), .result-row:focus-visible, .lookup :global(textarea:focus-visible), .lookup :global(input:focus-visible) {
    outline: 3px solid color-mix(in srgb, var(--lookup-accent) 55%, transparent);
    outline-offset: 1px;
  }
  .lookup :global(.list-label) { display: block; padding: 0 0 4px; font-size: 11px; font-weight: 650; letter-spacing: .03em; color: var(--lookup-muted); }
  .lookup { position: relative; height: 100vh; display: flex; flex-direction: column; background: Canvas; color: CanvasText; overflow: hidden; }
  .query-bar { flex: 0 0 auto; padding: 16px 18px 8px; }
  .query-row { display: flex; align-items: center; gap: 12px; }
  .query-input {
    box-sizing: border-box; flex: 1; min-width: 0; resize: none; min-height: 40px; max-height: 96px;
    padding: 9px 12px; border: 1px solid var(--lookup-border); border-radius: 10px;
    background: Canvas; font-size: 16px; line-height: 1.45; overflow-y: auto;
  }
  .status-chip { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--lookup-muted); white-space: nowrap; }
  .status-chip.working { color: var(--lookup-accent); }
  .status-chip.grounded { color: var(--lookup-fit); }
  .hint-row { display: flex; align-items: center; gap: 12px; margin: 6px 2px 0; min-height: 16px; }
  .hint { margin: 0; flex: 0 0 auto; font-size: 11px; color: var(--lookup-muted); }
  .activity { flex: 1; min-width: 0; display: flex; justify-content: flex-end; align-items: center; gap: 6px; font-size: 11px; color: var(--lookup-muted); }
  .activity-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .workspace { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(280px, 51%) minmax(0, 1fr); border-top: 1px solid var(--lookup-border); }
  .results-pane, .preview-pane { min-width: 0; min-height: 0; display: flex; flex-direction: column; }
  .results-pane { border-right: 1px solid var(--lookup-border); }
  .pane-header { flex: 0 0 auto; min-height: 40px; display: flex; align-items: center; gap: 8px; padding: 0 12px 0 16px; border-bottom: 1px solid var(--lookup-border); }
  .pane-header strong { margin-right: auto; font-size: 12px; font-weight: 600; }
  .pane-header > span { color: var(--lookup-muted); font-size: 11px; white-space: nowrap; }
  kbd { font: inherit; font-size: 11px; color: var(--lookup-muted); }
  .menu-popover { position: absolute; right: 12px; bottom: 34px; z-index: 10; width: max-content; max-width: 280px; }
  .actions-menu { display: flex; flex-direction: column; }
  .actions-menu .menu-row { border: 0; background: transparent; text-align: left; min-height: 26px; }
  .results-scroll, .preview-scroll { flex: 1; min-height: 0; overflow-y: auto; }
  .answer-area { display: flex; flex-direction: column; gap: 14px; padding: 16px 16px 12px 18px; }
  .fallback-line { margin: 0; padding: 8px 10px; border-radius: 8px; background: var(--lookup-soft); font-size: 12.5px; line-height: 1.5; }
  .answer-box { display: flex; flex-direction: column; gap: 8px; padding: 12px 14px; border-radius: 10px; background: color-mix(in srgb, var(--lookup-accent) 4%, Canvas); border: 1px solid color-mix(in srgb, var(--lookup-accent) 14%, transparent); }
  .answer-box .list-label { padding: 0; }
  .steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
  .step { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--lookup-muted); }
  .step.on { color: CanvasText; }
  .dot { flex: none; width: 8px; height: 8px; border-radius: 4px; background: var(--lookup-border); }
  .step.done .dot { background: var(--lookup-fit); }
  .step.on .dot { background: var(--lookup-accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--lookup-accent) 18%, transparent); }
  .answer-block { display: flex; flex-direction: column; }
  .answer-text { margin: 0; font-size: 15px; line-height: 1.65; white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; }
  .answer-note { margin: 4px 0 0; font-size: 11px; color: var(--lookup-muted); }
  .cite {
    display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 17px; padding: 0 4px; margin: 0 1px;
    border-radius: 4px; background: color-mix(in srgb, var(--lookup-accent) 12%, Canvas); color: var(--lookup-accent);
    font-size: 11px; font-weight: 700; text-decoration: none; vertical-align: 1px; font-variant-numeric: tabular-nums;
  }
  .cite:hover { background: color-mix(in srgb, var(--lookup-accent) 20%, Canvas); }
  .result-list { display: flex; flex-direction: column; gap: 2px; }
  .result-group { display: flex; flex-direction: column; gap: 2px; }
  .group-label { display: flex; gap: 6px; padding: 4px 10px; font-size: 11px; font-weight: 600; color: var(--lookup-muted); }
  .result-row { display: flex; gap: 8px; padding: 8px 10px; border-radius: 8px; cursor: default; }
  .result-row.active { background: color-mix(in srgb, var(--lookup-accent) 9%, Canvas); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--lookup-accent) 30%, transparent); }
  .result-row.dim .result-title, .result-row.dim .result-snippet { opacity: .6; }
  .num { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 20px; border-radius: 5px; background: var(--lookup-soft); font-size: 11.5px; font-weight: 700; }
  .result-row.active .num { background: var(--lookup-accent); color: #fff; }
  .row-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .title-line { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .result-title { display: block; min-width: 0; font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .result-crumb { min-width: 0; font-size: 12px; color: var(--lookup-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .result-snippet { font-size: 12.5px; line-height: 1.45; color: var(--lookup-muted); display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .inline-passage { display: none; }
  .more { display: flex; align-items: center; gap: 6px; height: 32px; padding: 0 10px; border: 0; border-radius: 8px; background: transparent; font-size: 12.5px; text-align: left; }
  .more:hover { background: var(--lookup-soft); }
  mark { background: color-mix(in srgb, #f5c518 40%, transparent); color: inherit; border-radius: 2px; }
  .state { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 32px 20px; text-align: center; font-size: 13px; color: var(--lookup-muted); }
  .state strong { color: CanvasText; }
  .state p { margin: 0; }
  .state.error strong { color: #b42318; }
  .secondary-button { margin-top: 6px; padding: 5px 12px; border: 1px solid var(--lookup-border); border-radius: 7px; background: var(--lookup-soft); }
  .text-button { padding: 2px 4px; border: 0; background: transparent; color: var(--lookup-accent); font-size: 12px; white-space: nowrap; }
  .preview-scroll { padding: 14px 20px; }
  .preview-location { flex: 1; min-width: 0; font-size: 12px; color: var(--lookup-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .preview-title { margin: 4px 0 10px; font-size: 18px; font-weight: 650; }
  .preview-note { margin: 0 0 8px; font-size: 12px; color: var(--lookup-muted); }
  .preview-text { margin: 0; font-size: 13.5px; line-height: 1.7; white-space: pre-wrap; word-break: break-word; }
  .preview-text.cited { border-left: 3px solid var(--lookup-accent); padding-left: 12px; margin-left: -15px; }
  .notice { margin: 0 0 12px; padding: 8px 10px; border-radius: 8px; background: var(--lookup-soft); font-size: 12px; line-height: 1.5; }
  .notice.error { background: color-mix(in srgb, #ce3030 8%, Canvas); }
  .footer { flex: 0 0 auto; display: flex; align-items: center; gap: 12px; min-height: 34px; padding: 0 12px 0 18px; border-top: 1px solid var(--lookup-border); background: var(--lookup-soft); }
  .footer-line { min-width: 0; font-size: 11.5px; color: var(--lookup-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .footer-line.compact { display: none; }
  .spacer { flex: 1; }
  .enhance-chip { display: inline-flex; align-items: center; gap: 7px; height: 24px; padding: 0 10px; border: 1px solid var(--lookup-border); border-radius: 12px; background: Canvas; font: inherit; font-size: 12px; color: var(--lookup-muted); }
  .enhance-chip .dot { width: 7px; height: 7px; border-radius: 50%; background: #28a745; }
  .footer-hint { font-size: 11.5px; color: var(--lookup-muted); white-space: nowrap; }
  .footer-actions { padding: 2px 6px; border: 0; border-radius: 5px; background: transparent; font-size: 11px; color: var(--lookup-muted); }
  .footer-actions:hover { background: var(--lookup-soft); color: CanvasText; }
  .spinner { display: inline-block; flex-shrink: 0; width: 11px; height: 11px; border: 2px solid color-mix(in srgb, var(--lookup-accent) 18%, transparent); border-top-color: var(--lookup-accent); border-radius: 50%; animation: spin .8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  /* The narrow window (Compact board): one column, answer → sources → other results; the selected row expands inline. */
  @media (max-width: 719.98px) {
    .workspace { grid-template-columns: 1fr; }
    .results-pane { border-right: 0; }
    .preview-pane { display: none; }
    .inline-passage { display: flex; flex-direction: column; gap: 6px; margin-top: 4px; }
    .inline-text { font-size: 12.5px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
    .inline-actions { display: flex; align-items: center; gap: 8px; }
    .inline-hint { margin-left: auto; font-size: 11px; color: var(--lookup-muted); }
    .result-row.active .result-snippet { display: none; }
    .footer-line.wide { display: none; }
    .footer-line.compact { display: inline; }
  }
</style>
