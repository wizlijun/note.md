// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import type { SearchHit, SmartSearchHit, SmartSearchResponse } from './lib/search/api'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  writeText: vi.fn(async (_text: string) => {}),
  setTitle: vi.fn(async () => {}),
  emitTo: vi.fn(async (_target: string, _event: string, _payload?: unknown) => {}),
  focusChanged: null as ((event: { payload: boolean }) => Promise<void> | void) | null,
  listeners: new Map<string, Array<() => unknown>>(),
  storedSmartLookup: undefined as unknown,
  preview: 'normal' as 'normal' | 'empty',
  local: 'normal' as 'normal' | 'empty',
  localGate: null as Promise<void> | null,
  localError: null as string | null,
  customHits: null as SmartSearchHit[] | null,
  /** Hits for `smart_lookup_local` by question; falls back to the `local` fixture. */
  localByQuestion: {} as Record<string, SmartSearchHit[]>,
  localTime: null as unknown,
  runCounter: 0,
  /** Evidence step results handed out in call order; the default is a finished run without evidence. */
  evidenceQueue: [] as unknown[],
  evidenceGates: [] as Array<Promise<void> | null>,
  keys: { jev: true, chat: false },
  repair: null as unknown,
  /** `smart_lookup_answer` results handed out in call order. */
  answers: [] as unknown[],
  groups: null as unknown,
  saveError: false,
  /** What `isVisible()` answers: the global shortcut hides the window without telling the page. A function is asked each time. */
  visible: true as boolean | (() => boolean),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (event: string, handler: () => unknown) => {
    const handlers = mocks.listeners.get(event) ?? []
    handlers.push(handler)
    mocks.listeners.set(event, handlers)
    return () => {
      mocks.listeners.set(event, (mocks.listeners.get(event) ?? []).filter((h) => h !== handler))
    }
  }),
  emit: vi.fn(async () => {}),
  emitTo: mocks.emitTo,
}))
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    setTitle: mocks.setTitle,
    isVisible: vi.fn(async () => (typeof mocks.visible === 'function' ? mocks.visible() : mocks.visible)),
    onFocusChanged: vi.fn(async (callback: (event: { payload: boolean }) => Promise<void>) => {
      mocks.focusChanged = callback
      return () => { mocks.focusChanged = null }
    }),
  }),
}))
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({ writeText: mocks.writeText }))
vi.mock('@tauri-apps/plugin-store', () => ({
  Store: {
    load: vi.fn(async () => ({
      get: vi.fn(async (key: string) => key === 'smartLookup' ? mocks.storedSmartLookup : undefined),
      set: vi.fn(async (key: string, value: unknown) => {
        if (key === 'smartLookup') mocks.storedSmartLookup = structuredClone(value)
      }),
      delete: vi.fn(async () => {}),
      save: vi.fn(async () => { if (mocks.saveError) throw new Error('disk full at /Users/me/settings.json') }),
    })),
  },
}))

import SmartLookupApp from './SmartLookupApp.svelte'
import { settings } from './lib/settings.svelte'
import type { AnswerResult, EvidenceItem, EvidenceStepResult } from './lib/smart-search/api'

let component: ReturnType<typeof mount> | null = null

function hit(name: string, line: number, docDate: string | null = '2026-08-20'): SmartSearchHit {
  return {
    path: `notes/${name}.md`,
    absPath: `/vault/notes/${name}.md`,
    line,
    lineEnd: line,
    text: `PRIVATE_BODY_${name} release risk`,
    breadcrumb: name,
    level: 'line' as SearchHit['level'],
    score: 1,
    docDate,
    sourceRef: `notes/${name}.md#L${line}`,
    agentBy: null,
    humanVerified: false,
    origin: 'human' as const,
    conceptType: null,
    pinned: false,
    resultId: `result-${name}`,
    fusedScore: 0.8,
    relevanceReasons: ['strict_query'],
    matchedQueries: ['q1'],
  }
}

function searchResponse(kind: 'normal' | 'empty' | 'single'): SmartSearchResponse {
  const hits = kind === 'empty'
    ? []
    : kind === 'single'
      ? [hit('new-result', 21)]
      : mocks.customHits ?? [hit('alpha', 4), hit('beta', 8), hit('gamma', 12)]
  return {
    route: 'smart-fts',
    tookMs: 2,
    total: hits.length,
    hits,
    truncated: false,
    deepAvailable: hits.length === 0,
    extractedTerms: ['release', 'risk'],
    subqueries: [],
  }
}

function rh(id: string, extra: Partial<SmartSearchHit> = {}): SmartSearchHit {
  return { ...hit(id, 10), resultId: id, ...extra }
}

function response(hits: SmartSearchHit[]): SmartSearchResponse {
  return {
    route: 'smart-fts', tookMs: 7, total: hits.length, hits, truncated: false,
    deepAvailable: hits.length === 0, extractedTerms: ['release', 'risk'], subqueries: [],
  }
}

/** The host's run totals; a test that reads the details sets them as the host would. */
function runTotals(partial: Partial<EvidenceStepResult['run']> = {}): EvidenceStepResult['run'] {
  return {
    endpointHost: 'api.typesafe.ai', requests: 1, elapsedMs: 420, sentBlocks: 3, tokens: 900,
    skippedConfidential: 0, skippedStale: 0, skippedLong: 0, skippedOversize: 0, ...partial,
  }
}

function step(partial: Partial<EvidenceStepResult> = {}): EvidenceStepResult {
  return {
    status: 'ok', stop: null, skipReason: null, missing: null, endpointHost: 'api.typesafe.ai', statusClass: null, hop: 0,
    terms: [], evidence: [], localTiers: [], done: false, requestCount: 1, poolSize: 3, candidates: 3, sentBlocks: 3,
    skippedConfidential: 0, skippedStale: 0, skippedLong: 0, skippedOversize: 0, estimatedTokens: 900, tokensUsed: 900,
    usage: { inputTokens: 900, outputTokens: 12 }, elapsedMs: 420, nextHop: (partial.hop ?? 0) + 1, run: runTotals(), ...partial,
  }
}

/** Evidence with local vault text, as the host returns it. */
function ev(id: string, foundRound: number, extra: Partial<EvidenceItem> = {}): EvidenceItem {
  return {
    evidenceId: id, path: `notes/${id}.md`, absPath: `/vault/notes/${id}.md`, line: 3, lineEnd: 3, title: id, breadcrumb: `${id} heading`,
    text: `LOCAL_PASSAGE_${id} release risk`, foundRound, tier: 'fit', localResultId: null, ...extra,
  }
}

function answered(partial: Partial<AnswerResult> = {}): AnswerResult {
  return {
    status: 'ok', skipReason: null, missing: null, endpointHost: 'chat.example', statusClass: null, text: null, sources: [],
    omittedSources: 0, requestCount: 1, elapsedMs: 900, usage: { inputTokens: 300, outputTokens: 40 }, ...partial,
  }
}

const JEV = { url: 'https://api.typesafe.ai/v1', model: 'jev-1', authMode: 'bearer', consentHost: 'api.typesafe.ai' }
const CHAT = { url: 'https://chat.example/v1', model: 'small' }
const CHAT_ALLOWED = { ...CHAT, consentHost: 'chat.example' }

/** Stored lookup settings: the first-run note seen and the automatic scan on, unless the test says otherwise. */
function stored(value: { results?: Record<string, unknown>; enhance?: Record<string, unknown>; launch?: Record<string, unknown> }): unknown {
  return {
    ...value,
    results: { autoDeepOnZero: true, ...value.results },
    launch: { firstRunSeen: true, ...value.launch },
  }
}

function installInvokeMock(): void {
  mocks.invoke.mockImplementation(async (command: string, args?: Record<string, any>) => {
    if (command === 'notemd_smart_search') {
      return searchResponse(args?.deep === true ? 'normal' : mocks.preview)
    }
    if (command === 'smart_lookup_local') {
      const gate = mocks.localGate
      mocks.localGate = null
      if (gate) await gate
      if (mocks.localError) throw new Error(mocks.localError)
      const question = String(args?.question ?? '')
      const custom = mocks.localByQuestion[question]
      const search = args?.deep === true
        ? searchResponse('normal')
        : custom ? response(custom)
          : question === 'new question' ? searchResponse('single') : searchResponse(mocks.local)
      return { search, lookupRunId: `run-${++mocks.runCounter}`, time: mocks.localTime }
    }
    if (command === 'smart_lookup_evidence_step') {
      const queued = mocks.evidenceQueue.shift()
      const gate = mocks.evidenceGates.shift()
      if (gate) await gate
      if (queued instanceof Error) throw queued
      return queued ?? step({ done: true, stop: 'maxHops' })
    }
    if (command === 'smart_lookup_key_status') return mocks.keys
    if (command === 'smart_lookup_repair_suggest') return mocks.repair
    if (command === 'smart_lookup_answer') {
      const next = mocks.answers.shift()
      // A function is called at request time, so a rejection is only made once it is awaited.
      return typeof next === 'function' ? next() : next
    }
    if (command === 'smart_lookup_search_groups') return mocks.groups
    return undefined
  })
}

/** The argument objects of every `invoke(command, args)` call, in order. */
function calls(command: string): any[] {
  return mocks.invoke.mock.calls.filter((call) => call[0] === command).map((call) => call[1])
}

function agentCommands(name: string) {
  return mocks.invoke.mock.calls.filter((call) => (
    call[0] === 'plugin_v2_execute' && call[1]?.command === name
  ))
}

async function mountReady(): Promise<HTMLTextAreaElement> {
  component = mount(SmartLookupApp, { target: document.body })
  await vi.waitFor(() => {
    expect(document.querySelector('.query-input')).not.toBeNull()
    // Settings are loaded and the window is fully initialised.
    expect(mocks.focusChanged).not.toBeNull()
  })
  await tick()
  return document.querySelector<HTMLTextAreaElement>('.query-input')!
}

function setQuery(input: HTMLTextAreaElement, value: string): void {
  input.value = value
  input.setSelectionRange(value.length, value.length)
  input.dispatchEvent(new InputEvent('input', { bubbles: true, data: value }))
}

function key(target: EventTarget, name: string, init: KeyboardEventInit = {}): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, ...init }))
}

/** Enter, then wait for `rows` local results (or, with 0, for the lookup to settle on no local results). */
async function submit(input: HTMLTextAreaElement, value = 'release risk', rows = 3): Promise<void> {
  setQuery(input, value)
  key(input, 'Enter')
  await vi.waitFor(() => expect(calls('smart_lookup_local').some((call) => call.question === value.trim())).toBe(true))
  if (rows === 0) {
    await vi.waitFor(() => expect(document.querySelector('.no-match, .state')).not.toBeNull())
    return
  }
  // The answer view may already have replaced the local list.
  await vi.waitFor(() => expect(
    document.querySelectorAll('.local-list .result-row').length === rows || document.querySelector('.source-list, .no-match') !== null,
  ).toBe(true))
}

function buttonNamed(label: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
    .find((candidate) => candidate.textContent?.trim() === label)
  expect(button, `Button named "${label}"`).toBeDefined()
  return button!
}

async function openMenu(): Promise<HTMLElement> {
  if (!document.querySelector('.actions-menu')) document.querySelector<HTMLButtonElement>('.more-actions')!.click()
  await vi.waitFor(() => expect(document.querySelector('.actions-menu[role="menu"]')).not.toBeNull())
  return document.querySelector<HTMLElement>('.actions-menu')!
}

function menuItem(label: string): HTMLButtonElement {
  const item = Array.from(document.querySelectorAll<HTMLButtonElement>('.actions-menu button.menu-row[role="menuitem"]'))
    .find((candidate) => candidate.textContent?.trim() === label)
  expect(item, `Menu item "${label}"`).toBeDefined()
  return item!
}

async function chooseMenuAction(label: string): Promise<void> {
  await openMenu()
  await vi.waitFor(() => expect(menuItem(label).disabled).toBe(false))
  menuItem(label).click()
  await tick()
  expect(document.querySelector('.actions-menu')).toBeNull()
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

beforeEach(() => {
  localStorage.clear()
  document.body.innerHTML = ''
  vi.clearAllMocks()
  mocks.listeners.clear()
  mocks.focusChanged = null
  mocks.preview = 'normal'
  mocks.local = 'normal'
  mocks.localGate = null
  mocks.localError = null
  mocks.customHits = null
  mocks.localByQuestion = {}
  mocks.localTime = null
  mocks.runCounter = 0
  mocks.evidenceQueue = []
  mocks.evidenceGates = []
  mocks.keys = { jev: true, chat: false }
  mocks.repair = null
  mocks.answers = []
  mocks.groups = null
  mocks.saveError = false
  mocks.visible = true
  // No endpoint by default: a lookup shows local results only. `autoDeepOnZero` is set either way,
  // so the tests do not depend on its default.
  mocks.storedSmartLookup = stored({})
  Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true })
  installInvokeMock()
})

afterEach(async () => {
  if (component) await unmount(component)
  component = null
  document.body.innerHTML = ''
  localStorage.clear()
})

// ---- helpers for the answer-first window ----

const LOCAL = ['r1', 'r2', 'r3']

function useLocal(ids: string[] = LOCAL, question = 'release risk'): void {
  mocks.localByQuestion[question] = ids.map((id) => rh(id))
}

/** Rows of one list, by their result or evidence id. */
function ids(list: 'local' | 'source' | 'other'): Array<string | null> {
  return [...document.querySelectorAll(`.${list}-list .result-row`)]
    .map((row) => row.getAttribute('data-evidence-id') ?? row.getAttribute('data-result-id'))
}

function activeId(): string | null | undefined {
  const row = document.querySelector('.result-row.active')
  return row?.getAttribute('data-evidence-id') ?? row?.getAttribute('data-result-id')
}

function chip(): string {
  return document.querySelector('.status-chip')?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
}

function fallback(): string {
  return document.querySelector('.fallback-line')?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
}

function footerLineText(): string {
  return document.querySelector('.footer-line.wide')?.textContent?.trim() ?? ''
}

function footer(): string {
  return document.querySelector('footer')?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
}

function answerText(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.answer-text')
}

function noMatchPanel(): string {
  return document.querySelector('.no-match')?.textContent?.replace(/\s+/g, ' ') ?? ''
}

function gateEvidence(): () => void {
  let release!: () => void
  mocks.evidenceGates.push(new Promise<void>((resolve) => { release = resolve }))
  return release
}

function click(element: HTMLElement): void {
  element.click()
}

function recentItem(label: string): HTMLButtonElement {
  const item = [...document.querySelectorAll<HTMLButtonElement>('.recent-item')]
    .find((candidate) => candidate.querySelector('.recent-question')?.textContent?.trim() === label)
  expect(item, `Recent ${label}`).toBeDefined()
  return item!
}

/** ⌘K 「复制活动日志」, then what reached the clipboard. */
async function copiedLog(): Promise<string> {
  const before = mocks.writeText.mock.calls.length
  await chooseMenuAction('Copy activity log')
  await vi.waitFor(() => expect(mocks.writeText.mock.calls.length).toBeGreaterThan(before))
  return String(mocks.writeText.mock.calls.at(-1)?.[0] ?? '')
}

/** Jev and the answer model both set up and allowed. */
function configureBoth(chat: Record<string, unknown> = CHAT_ALLOWED): void {
  mocks.storedSmartLookup = stored({ enhance: { jev: { ...JEV }, chat: { ...chat } } })
}

describe('SmartLookupApp', () => {
  it('typing previews locally without any agent task', async () => {
    const input = await mountReady()
    setQuery(input, 'release risk')
    await vi.waitFor(() => expect(document.querySelectorAll('.result-row')).toHaveLength(3), { timeout: 1_500 })

    const previews = calls('notemd_smart_search')
    expect(previews).toHaveLength(1)
    expect(previews[0]).toEqual(expect.objectContaining({ query: 'release risk', deep: false, limit: 50 }))
    expect(document.querySelector('.results-pane .pane-header')?.textContent).toContain('Local preview')
    expect(agentCommands('run-task')).toHaveLength(0)
    expect(calls('smart_lookup_local')).toHaveLength(0)
    expect(chip()).toBe('')
  })

  it('does not preview or submit while an IME composition is open', async () => {
    const input = await mountReady()
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    input.value = 'fabu'
    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'fabu', isComposing: true }))
    key(input, 'Enter', { isComposing: true })
    await wait(600)
    expect(calls('notemd_smart_search')).toHaveLength(0)
    expect(calls('smart_lookup_local')).toHaveLength(0)
  })

  it('Enter shows local results immediately with zero model calls and never sends a time mode', async () => {
    const input = await mountReady()
    await submit(input)

    expect(calls('smart_lookup_local')).toHaveLength(1)
    expect(calls('smart_lookup_local')[0]).toEqual(expect.objectContaining({
      question: 'release risk', deep: false, limit: 50,
    }))
    // The time chip and its menu are gone: the window leaves the host's own time handling alone.
    expect(calls('smart_lookup_local')[0].timeMode).toBeUndefined()
    expect(agentCommands('run-task')).toHaveLength(0)
    expect(calls('smart_lookup_evidence_step')).toHaveLength(0)
    expect(document.querySelector('.result-row.active')?.textContent).toContain('alpha')
    expect(document.querySelector('.preview-header')?.textContent).toContain('notes/alpha.md · line 4')
    // No endpoint: one line above the local results, with the settings link.
    expect(fallback()).toBe("Lookup enhancement isn't set up yet; showing local results only. Settings")
    expect(chip()).toBe('Local results only')
    expect(footer()).toBe('esc Close ⌘K Actions')
    expect(document.querySelector('.hint')?.textContent).toBe('Return to answer · Shift-Return for a new line')
  })

  it('Enter does not wait for the preview debounce', async () => {
    const input = await mountReady()
    await submit(input)
    await wait(600)
    expect(calls('notemd_smart_search')).toHaveLength(0)
    expect(document.querySelectorAll('.result-row')).toHaveLength(3)
  })

  it('a late response for a superseded question is ignored', async () => {
    let release!: () => void
    mocks.localGate = new Promise<void>((resolve) => { release = resolve })
    const input = await mountReady()
    setQuery(input, 'old question')
    key(input, 'Enter')
    await vi.waitFor(() => expect(calls('smart_lookup_local')).toHaveLength(1))

    await submit(input, 'new question', 1)
    release()
    await wait(20)
    await tick()

    expect(document.body.textContent).toContain('new-result')
    expect(document.body.textContent).not.toContain('alpha')
    expect(document.querySelectorAll('.result-row')).toHaveLength(1)
  })

  it('index not ready shows retry and keeps the input usable', async () => {
    mocks.localError = 'search index not ready'
    const input = await mountReady()
    setQuery(input, 'release risk')
    key(input, 'Enter')

    await vi.waitFor(() => expect(document.querySelector('.state.error')?.textContent).toContain('search index not ready'))
    expect(input.disabled).toBe(false)
    expect(document.querySelector('.spinner')).toBeNull()
    expect(document.querySelectorAll('.result-row')).toHaveLength(0)

    mocks.localError = null
    buttonNamed('Try again').click()
    await vi.waitFor(() => expect(document.querySelectorAll('.result-row')).toHaveLength(3))
    expect(document.querySelector('.state.error')).toBeNull()
  })

  it('arrow keys navigate results and Enter opens the active hit', async () => {
    const input = await mountReady()
    await submit(input)

    key(input, 'ArrowDown')
    await vi.waitFor(() => expect(document.activeElement?.textContent).toContain('alpha'))
    key(document.activeElement!, 'ArrowDown')
    await vi.waitFor(() => expect(document.activeElement?.textContent).toContain('beta'))
    expect(document.activeElement?.getAttribute('aria-selected')).toBe('true')
    key(document.activeElement!, 'End')
    await vi.waitFor(() => expect(document.activeElement?.textContent).toContain('gamma'))
    key(document.activeElement!, 'Home')
    await vi.waitFor(() => expect(document.activeElement?.textContent).toContain('alpha'))
    key(document.activeElement!, 'ArrowDown')
    await vi.waitFor(() => expect(document.activeElement?.textContent).toContain('beta'))
    key(document.activeElement!, 'Enter')

    await vi.waitFor(() => expect(calls('editor_show_and_reveal_search_hit')).toHaveLength(1))
    expect(calls('editor_show_and_reveal_search_hit')[0]).toEqual(expect.objectContaining({
      path: '/vault/notes/beta.md', line: 8,
    }))
    await vi.waitFor(() => expect(calls('hide_smart_search_window')).toHaveLength(1))
  })

  it('opens the current hit from the preview header', async () => {
    const input = await mountReady()
    await submit(input)
    document.querySelector<HTMLButtonElement>('.preview-header .text-button')!.click()
    await vi.waitFor(() => expect(calls('editor_show_and_reveal_search_hit')[0]).toEqual(
      expect.objectContaining({ path: '/vault/notes/alpha.md', line: 4 }),
    ))
  })

  it('Escape hides the window', async () => {
    const input = await mountReady()
    key(input, 'Escape')
    await vi.waitFor(() => expect(calls('hide_smart_search_window')).toHaveLength(1))
  })

  it('copy reference copies path and line', async () => {
    const input = await mountReady()
    await submit(input)
    await chooseMenuAction('Copy reference')
    await vi.waitFor(() => expect(mocks.writeText).toHaveBeenCalledWith('notes/alpha.md:4'))
  })

  it('copy activity log includes elapsed time', async () => {
    const input = await mountReady()
    await submit(input)
    const lines = (await copiedLog()).split('\n').map((line) => JSON.parse(line))
    const search = lines.find((entry) => entry.stage === 'search')
    expect(search).toMatchObject({ level: 'success', usage: null })
    expect(typeof search.elapsedMs).toBe('number')
    expect(search.elapsedMs).toBeGreaterThanOrEqual(0)
  })

  it('the actions menu offers no answer, research or correction rows without evidence', async () => {
    const input = await mountReady()
    await submit(input, 'release risk')
    await openMenu()
    const rows = [...document.querySelectorAll('[role="menuitem"]')].map((row) => row.textContent?.trim())
    expect(rows).toEqual(['Copy reference', 'Copy activity log'])
    expect(mocks.invoke.mock.calls.map(([cmd]) => cmd)).not.toContain('plugin_v2_execute')
  })

  it('groups by month when settings ask for date grouping, and reloads on settings change', async () => {
    mocks.customHits = [hit('alpha', 4, '2026-08-20'), hit('beta', 8, null), hit('gamma', 12, '2026-10-02')]
    const input = await mountReady()
    await submit(input)
    expect(document.querySelectorAll('[role="listbox"] [role="group"]')).toHaveLength(1)

    mocks.storedSmartLookup = stored({ results: { groupBy: 'date' } })
    for (const handler of mocks.listeners.get('settings://changed') ?? []) await handler()
    await vi.waitFor(() => {
      const groups = Array.from(document.querySelectorAll('[role="listbox"] [role="group"]'))
      expect(groups.map((group) => group.getAttribute('aria-label'))).toEqual(['2026-10', '2026-08', 'Date unknown'])
    })
  })

  it('a time phrase still groups the local results, with no chip or menu', async () => {
    useLocal()
    mocks.localTime = { sourceText: '上周', after: '2026-11-02', before: '2026-11-09', mode: 'group', inWindow: 1 }
    const input = await mountReady()
    await submit(input)
    const groups = [...document.querySelectorAll('.local-list [role="group"]')].map((group) => group.getAttribute('aria-label'))
    expect(groups).toEqual(['In range', 'Other dates'])
    expect(document.querySelector('.time-chip, .time-anchor, .criterion-chip')).toBeNull()
    expect(document.body.textContent).not.toContain('Time: 上周')
  })

  it('selects the query text when the window regains focus', async () => {
    const input = await mountReady()
    setQuery(input, 'release risk')
    input.setSelectionRange(3, 3)
    await mocks.focusChanged?.({ payload: true })
    await vi.waitFor(() => {
      expect(input.selectionStart).toBe(0)
      expect(input.selectionEnd).toBe('release risk'.length)
    })
  })
})

describe('SmartLookupApp answer', () => {
  it('answers by itself once the rounds are done, from the fit evidence on screen', async () => {
    useLocal()
    configureBoth()
    mocks.evidenceGates.push(null)
    const releaseRound = gateEvidence()
    mocks.evidenceQueue.push(
      step({ hop: 0, evidence: [ev('e1', 0), ev('e2', 0, { tier: 'unfit' })], localTiers: [{ resultId: 'r3', tier: 'unfit' }] }),
      step({
        hop: 1, done: true, stop: 'maxHops', evidence: [ev('e1', 0), ev('e3', 1), ev('e2', 0, { tier: 'unfit' })],
        localTiers: [{ resultId: 'r3', tier: 'unfit' }], run: runTotals({ sentBlocks: 74 }),
      }),
    )
    let releaseAnswer!: (value: AnswerResult) => void
    mocks.answers.push(new Promise<AnswerResult>((resolve) => { releaseAnswer = resolve }))
    const input = await mountReady()
    await submit(input, 'release risk', 2)

    // Working board: the rounds run; nothing is answered yet.
    await vi.waitFor(() => expect(document.querySelector('.steps')?.textContent).toContain('1 confirmed'))
    const steps = () => [...document.querySelectorAll('.steps .step')].map((item) => item.textContent?.trim())
    expect(steps()).toEqual(['Found 3 on this device', 'Checking each passage for evidence · 1 confirmed', 'Write the answer'])
    expect(chip()).toBe('Finding evidence · 0 s')
    expect(document.querySelector('.local-list')?.getAttribute('aria-label')).toBe('Local results · read these meanwhile')
    // A local row the rounds judged unfit is no longer listed.
    expect(ids('local')).toEqual(['r1', 'r2'])
    expect(footerLineText()).toBe('Sending to api.typesafe.ai · confidential notes are not sent')
    expect(footer()).toContain('esc Stop')
    expect(calls('smart_lookup_answer')).toHaveLength(0)

    releaseRound()
    await vi.waitFor(() => expect(calls('smart_lookup_answer')).toHaveLength(1))
    // Only the fit passages, in their order on screen.
    expect(calls('smart_lookup_answer')[0]).toEqual({
      lookupRunId: 'run-1', chat: { url: CHAT.url, model: CHAT.model, consentHost: 'chat.example' }, evidenceIds: ['e1', 'e3'],
    })
    await vi.waitFor(() => expect(document.querySelector('.step.on')?.textContent).toContain('Write the answer'))
    expect(footerLineText()).toBe('Sending to api.typesafe.ai, chat.example · confidential notes are not sent')
    expect(ids('local')).toEqual(['r1', 'r2'])

    releaseAnswer(answered({
      text: 'ANSWER_TEXT decided by Alice [2].\n<b>bold</b> **star** [1, 2] [9] [2](http://x)',
      sources: [{ id: 1, evidenceId: 'e1' }, { id: 2, evidenceId: 'e3' }],
      omittedSources: 1,
    }))
    await vi.waitFor(() => expect(answerText()).not.toBeNull())
    // Plain text: no HTML or Markdown is rendered; each cited number is a chip.
    expect(answerText()!.textContent).toBe('ANSWER_TEXT decided by Alice 2.\n<b>bold</b> **star** 12 [9] [2](http://x)')
    expect(answerText()!.querySelector('b, strong, em')).toBeNull()
    const chips = [...answerText()!.querySelectorAll<HTMLAnchorElement>('a.cite')]
    expect(chips.map((link) => [link.textContent, link.dataset.cite, link.getAttribute('aria-label')])).toEqual([
      ['2', 'e3', 'Source 2'], ['1', 'e1', 'Source 1'], ['2', 'e3', 'Source 2'],
    ])
    expect(document.querySelector('.answer-block')?.textContent).toContain('1 passage(s) over the budget were not sent')
    // 依据: the cited sources in citation-number order, numbered to match.
    expect(ids('source')).toEqual(['e1', 'e3'])
    expect([...document.querySelectorAll('.source-list .num')].map((num) => num.textContent)).toEqual(['1', '2'])
    expect(document.querySelector('.local-list')).toBeNull()
    expect(chip()).toBe('Grounded · 2 source(s)')
    expect(footerLineText()).toBe('Sent to api.typesafe.ai, chat.example · 74 passages in all · no confidential notes sent')
    expect(footer()).toContain('esc Close')
    expect(fallback()).toBe('')
    // The top source is current, and its passage is marked in the preview.
    expect(activeId()).toBe('e1')
    expect(document.querySelector('.preview-text.cited')?.textContent).toContain('LOCAL_PASSAGE_e1')

    // The activity log has the status and counts, never the answer or a host.
    const log = await copiedLog()
    const entry = log.split('\n').map((line) => JSON.parse(line)).find((e) => e.stage === 'answer')
    expect(entry).toMatchObject({ level: 'success', usage: { inputTokens: 300, outputTokens: 40 } })
    expect(entry.message).toContain('answer ok')
    expect(log).not.toContain('ANSWER_TEXT')
    expect(log).not.toContain('chat.example')
    expect(log).not.toContain('api.typesafe.ai')
    expect(log).not.toContain('LOCAL_PASSAGE')
  })

  it('a citation chip or a source row shows that passage in the preview, marked', async () => {
    useLocal()
    configureBoth()
    mocks.evidenceQueue.push(step({ done: true, stop: 'maxHops', evidence: [ev('e1', 0), ev('e2', 1, { line: 7, lineEnd: 9 })] }))
    mocks.answers.push(answered({ text: 'A [1]. B [2].', sources: [{ id: 1, evidenceId: 'e1' }, { id: 2, evidenceId: 'e2' }] }))
    const input = await mountReady()
    await submit(input)
    await vi.waitFor(() => expect(ids('source')).toEqual(['e1', 'e2']))

    click(document.querySelectorAll<HTMLAnchorElement>('.answer-text a.cite')[1])
    await vi.waitFor(() => expect(activeId()).toBe('e2'))
    expect(document.querySelector('.preview-header')?.textContent).toContain('notes/e2.md · lines 7–9')
    expect(document.querySelector('.preview-text.cited')?.textContent).toContain('LOCAL_PASSAGE_e2')
    click(document.querySelector<HTMLElement>('.source-list .result-row[data-evidence-id="e1"]')!)
    await vi.waitFor(() => expect(activeId()).toBe('e1'))
    // Arrow keys move between the sources; Return opens the passage in the editor.
    key(document.querySelector('.source-list .result-row.active')!, 'ArrowDown')
    await vi.waitFor(() => expect(activeId()).toBe('e2'))
    key(document.activeElement!, 'Enter')
    await vi.waitFor(() => expect(calls('editor_show_and_reveal_search_hit')[0]).toMatchObject({ path: '/vault/notes/e2.md' }))
    expect(calls('smart_lookup_answer')).toHaveLength(1)
  })

  it('other results: uncited fit evidence first, then local results, each block once and never an unfit row', async () => {
    useLocal()
    configureBoth()
    mocks.evidenceQueue.push(step({
      done: true, stop: 'maxHops',
      // e1 is the same block as local r1; e2 the same block as local r2.
      evidence: [
        ev('e1', 0, { path: 'notes/r1.md', line: 10, lineEnd: 10, localResultId: 'r1' }),
        ev('e2', 0, { path: 'notes/r2.md', line: 10, lineEnd: 10, localResultId: 'r2' }),
        ev('e4', 1, { tier: 'unfit' }),
        ev('e5', 1, { tier: 'unsure' }),
      ],
      localTiers: [{ resultId: 'r1', tier: 'fit' }, { resultId: 'r2', tier: 'fit' }, { resultId: 'r3', tier: 'unfit' }],
    }))
    mocks.answers.push(answered({ text: 'Answer [1].', sources: [{ id: 1, evidenceId: 'e1' }, { id: 2, evidenceId: 'e2' }] }))
    useLocal(['r1', 'r2', 'r3', 'r4'])
    const input = await mountReady()
    await submit(input, 'release risk', 4)
    await vi.waitFor(() => expect(ids('source')).toEqual(['e1']))

    const more = buttonNamed('3 other results')
    expect(more.getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelector('.other-list')).toBeNull()
    click(more)
    await vi.waitFor(() => expect(ids('other')).toEqual(['e2', 'e5', 'r4']))
    // Nowhere: the unfit evidence, the unfit local row, and the local copies of e1 and e2.
    expect(document.querySelector('[data-evidence-id="e4"], [data-result-id="r3"], [data-result-id="r1"], [data-result-id="r2"]')).toBeNull()
    // The other rows are selectable after the sources.
    key(document.querySelector('.source-list .result-row')!, 'ArrowDown')
    await vi.waitFor(() => expect(activeId()).toBe('e2'))
  })

  it('a round that arrives keeps the selection on its row while that row is still listed', async () => {
    useLocal()
    configureBoth({ ...CHAT })
    mocks.evidenceGates.push(null)
    const release = gateEvidence()
    mocks.evidenceQueue.push(
      step({ hop: 0, evidence: [ev('e1', 0)] }),
      step({ hop: 1, done: true, stop: 'maxHops', evidence: [ev('e1', 0)], localTiers: [{ resultId: 'r1', tier: 'unfit' }] }),
    )
    const input = await mountReady()
    await submit(input)
    await vi.waitFor(() => expect(calls('smart_lookup_evidence_step')).toHaveLength(2))
    key(input, 'ArrowDown')
    key(document.querySelector('.local-list .result-row.active')!, 'ArrowDown')
    await vi.waitFor(() => expect(activeId()).toBe('r2'))
    release()
    // The round applied at once (no 「应用」): r1 is now unfit and gone; r2 stays selected until the answer phase.
    await vi.waitFor(() => expect(document.querySelector('.source-list')).not.toBeNull())
    expect(document.body.textContent).not.toContain('Order updated')
    click(buttonNamed('2 other results'))
    await vi.waitFor(() => expect(ids('other')).toEqual(['r2', 'r3']))
    expect(activeId()).toBe('r2')
  })

  it('no answer request without consent for the answer host: the confirmed sources and one line', async () => {
    useLocal()
    configureBoth({ ...CHAT })
    mocks.evidenceQueue.push(step({ done: true, stop: 'maxHops', evidence: [ev('e1', 0), ev('e2', 0, { tier: 'unfit' })] }))
    const input = await mountReady()
    await submit(input)
    await vi.waitFor(() => expect(fallback()).toBe('Sending to chat.example is not allowed, so no answer was written. Settings'))
    expect(calls('smart_lookup_answer')).toHaveLength(0)
    expect(ids('source')).toEqual(['e1'])
    expect(answerText()).toBeNull()
    expect(chip()).toBe('Grounded · 1 source(s)')
    expect(footerLineText()).toBe('Sent to api.typesafe.ai · 3 passages in all · no confidential notes sent')
    click(buttonNamed('Settings'))
    await vi.waitFor(() => expect(mocks.emitTo).toHaveBeenCalledWith('main', 'settings://open-tab', { tab: 'enhance' }))
  })

  it('no answer request without an answer endpoint', async () => {
    useLocal()
    mocks.storedSmartLookup = stored({ enhance: { jev: { ...JEV } } })
    mocks.evidenceQueue.push(step({ done: true, stop: 'maxHops', evidence: [ev('e1', 0)] }))
    const input = await mountReady()
    await submit(input)
    await vi.waitFor(() => expect(fallback()).toBe('No endpoint for writing answers is set up, so no answer was written. Settings'))
    expect(calls('smart_lookup_answer')).toHaveLength(0)
    expect(ids('source')).toEqual(['e1'])
  })

  it.each([
    ['invalid citations', () => answered({ status: 'invalidCitations', requestCount: 3, sources: [{ id: 1, evidenceId: 'e1' }] }), 'api.typesafe.ai, chat.example'],
    ['a timeout', () => answered({ status: 'timeout' }), 'api.typesafe.ai, chat.example'],
    // The host refused before sending: the answer host is not named.
    ['a host budget code', () => Promise.reject('sourceTooLarge'), 'api.typesafe.ai'],
  ])('a failed answer (%s) shows the confirmed sources under one line, never remote text', async (_name, reply, hosts) => {
    useLocal()
    configureBoth()
    mocks.evidenceQueue.push(step({ done: true, stop: 'maxHops', evidence: [ev('e1', 0)] }))
    mocks.answers.push(reply)
    const input = await mountReady()
    await submit(input)
    await vi.waitFor(() => expect(fallback()).toBe("Couldn't write a grounded answer; below are the confirmed sources."))
    expect(answerText()).toBeNull()
    expect(ids('source')).toEqual(['e1'])
    expect(document.body.textContent).not.toContain('sourceTooLarge')
    expect(document.querySelectorAll('.fallback-line button')).toHaveLength(0)
    expect(footerLineText()).toBe(`Sent to ${hosts} · 3 passages in all · no confidential notes sent`)
  })

  it('no answer request when nothing shown is fit: the no-answer view', async () => {
    useLocal()
    configureBoth()
    mocks.evidenceQueue.push(step({
      done: true, stop: 'maxHops',
      evidence: [ev('e1', 0, { tier: 'unfit' }), ev('e2', 0, { tier: 'unsure' })],
      localTiers: [{ resultId: 'r1', tier: 'unfit' }],
    }))
    const input = await mountReady()
    await submit(input)
    await vi.waitFor(() => expect(document.querySelector('.no-match')).not.toBeNull())
    expect(calls('smart_lookup_answer')).toHaveLength(0)
    // Local hits but nothing fit: no repair and no scan (their results would not be verified).
    expect(calls('smart_lookup_repair_suggest')).toHaveLength(0)
    expect(calls('smart_lookup_local')).toHaveLength(1)
    expect(noMatchPanel()).toContain('Nothing in your notes answers this question.')
    expect(noMatchPanel()).toContain('Ask again with words you remember from the note; that may find it faster.')
    const tried = [...document.querySelectorAll('.no-match .attempt')].map((row) => row.textContent?.replace(/\s+/g, ' ').trim())
    expect(tried).toEqual(['Searched the original question on this device3 · all unrelated'])
    expect(document.querySelectorAll('.no-match button')).toHaveLength(0)
    expect(chip()).toBe('No evidence')
    expect(document.querySelector('.preview-pane')?.textContent).toContain('No passage can serve as evidence')
    // The unrelated rows wait behind one closed disclosure.
    click(buttonNamed('5 other results (all unrelated)'))
    await vi.waitFor(() => expect(ids('other')).toEqual(['e1', 'e2', 'r1', 'r2', 'r3']))
    expect(document.querySelector('.other-list .result-row')?.classList.contains('dim')).toBe(true)
  })

  it('⌘K marks the selected row as fitting or unrelated, on this device only', async () => {
    useLocal()
    configureBoth()
    mocks.evidenceQueue.push(step({ done: true, stop: 'maxHops', evidence: [ev('e1', 0)] }))
    mocks.answers.push(answered({ text: 'A [1].', sources: [{ id: 1, evidenceId: 'e1' }] }))
    const input = await mountReady()
    await submit(input)
    await vi.waitFor(() => expect(ids('source')).toEqual(['e1']))
    // The preview pane has no correction any more.
    expect(document.querySelector('.correction')).toBeNull()
    expect(document.body.textContent).not.toContain('Is this judgement right?')

    key(window, 'k', { metaKey: true })
    await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).toBeTruthy())
    const rows = [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent?.trim())
    expect(rows).toEqual(['Copy reference', 'Mark as fitting', 'Mark as unrelated', 'Copy activity log'])
    click(menuItem('Mark as unrelated'))
    await vi.waitFor(() => expect(calls('smart_lookup_feedback')).toEqual([{ lookupRunId: 'run-1', resultId: 'e1', verdict: 'unfit' }]))
    await vi.waitFor(() => expect(document.querySelector('.copy-status')?.textContent).toBe('Recorded on this device only'))
    await chooseMenuAction('Mark as fitting')
    await vi.waitFor(() => expect(calls('smart_lookup_feedback').at(-1)).toEqual({ lookupRunId: 'run-1', resultId: 'e1', verdict: 'fit' }))
    // Nothing else is sent: the correction is local.
    expect(calls('smart_lookup_answer')).toHaveLength(1)
  })

  it('Esc while the rounds run stops them, keeps the window and writes no answer; the next Esc hides it', async () => {
    useLocal()
    configureBoth()
    mocks.evidenceGates.push(null)
    const release = gateEvidence()
    mocks.evidenceQueue.push(step({ evidence: [ev('e1', 0)] }), step({ hop: 1, done: true, stop: 'maxHops', evidence: [ev('e1', 0), ev('e2', 1)] }))
    const input = await mountReady()
    await submit(input)
    await vi.waitFor(() => expect(calls('smart_lookup_evidence_step')).toHaveLength(2))
    expect(footer()).toContain('esc Stop')

    key(input, 'Escape')
    await vi.waitFor(() => expect(fallback()).toBe('Stopped finding evidence; showing local results only. Press Return again to retry.'))
    expect(calls('smart_lookup_cancel')).toEqual([{ lookupRunId: 'run-1' }])
    expect(calls('hide_smart_search_window')).toHaveLength(0)
    expect(footer()).toContain('esc Close')
    release()
    await wait(20)
    // The late round is dropped and no answer starts.
    expect(calls('smart_lookup_answer')).toHaveLength(0)
    expect(ids('local')).toEqual(LOCAL)
    expect(document.querySelectorAll('.fallback-line button')).toHaveLength(0)

    key(document.body, 'Escape')
    await vi.waitFor(() => expect(calls('hide_smart_search_window')).toHaveLength(1))
    expect(calls('smart_lookup_cancel')).toHaveLength(1)
  })

  it('Esc while the answer is written stops it and drops the late answer; Return asks again', async () => {
    useLocal()
    configureBoth()
    mocks.evidenceQueue.push(step({ done: true, stop: 'maxHops', evidence: [ev('e1', 0)] }))
    let release!: (value: AnswerResult) => void
    mocks.answers.push(new Promise<AnswerResult>((resolve) => { release = resolve }))
    const input = await mountReady()
    await submit(input)
    await vi.waitFor(() => expect(calls('smart_lookup_answer')).toHaveLength(1))
    await vi.waitFor(() => expect(document.querySelector('.step.on')?.textContent).toContain('Write the answer'))

    key(input, 'Escape')
    await vi.waitFor(() => expect(calls('smart_lookup_cancel')).toEqual([{ lookupRunId: 'run-1' }]))
    expect(calls('hide_smart_search_window')).toHaveLength(0)
    await vi.waitFor(() => expect(fallback()).toBe('Stopped writing the answer; below are the confirmed sources.'))
    expect(ids('source')).toEqual(['e1'])
    // The question and the passages may already have gone to the answer host: the footer still names it.
    expect(footerLineText()).toBe('Sent to api.typesafe.ai, chat.example · 3 passages in all · no confidential notes sent')
    release(answered({ text: 'LATE_ANSWER [1]', sources: [{ id: 1, evidenceId: 'e1' }] }))
    await wait(20)
    expect(answerText()).toBeNull()
    expect(document.body.textContent).not.toContain('LATE_ANSWER')
    expect(footerLineText()).toBe('Sent to api.typesafe.ai, chat.example · 3 passages in all · no confidential notes sent')

    // Return retries: a new lookup run, its own evidence, its own answer.
    mocks.evidenceQueue.push(step({ done: true, stop: 'maxHops', evidence: [ev('e1', 0)] }))
    mocks.answers.push(answered({ text: 'AGAIN [1]', sources: [{ id: 1, evidenceId: 'e1' }] }))
    key(input, 'Enter')
    await vi.waitFor(() => expect(answerText()?.textContent).toBe('AGAIN 1'))
    expect(calls('smart_lookup_evidence_step').map((call) => [call.lookupRunId, call.trigger])).toEqual([['run-1', 'auto'], ['run-2', 'auto']])
    expect(calls('smart_lookup_answer').map((call) => call.lookupRunId)).toEqual(['run-1', 'run-2'])
  })

  it('a window hidden once the rounds are done sends no answer: the run is cancelled as Esc would', async () => {
    useLocal()
    configureBoth()
    mocks.evidenceQueue.push(step({ done: true, stop: 'maxHops', evidence: [ev('e1', 0)] }))
    // Shown before and after the round; hidden by the time the answer would be asked for.
    let asked = 0
    mocks.visible = () => ++asked <= 2
    const input = await mountReady()
    await submit(input)
    await vi.waitFor(() => expect(calls('smart_lookup_cancel')).toEqual([{ lookupRunId: 'run-1' }]))
    await wait(20)
    expect(calls('smart_lookup_answer')).toHaveLength(0)
    expect(fallback()).toBe('Stopped writing the answer; below are the confirmed sources.')
  })

  it('a round that returns after the window was hidden is dropped, and nothing of it shows when the window reopens', async () => {
    useLocal()
    configureBoth()
    const release = gateEvidence()
    mocks.evidenceQueue.push(step({
      done: true, stop: 'maxHops', evidence: [ev('e1', 0)], localTiers: [{ resultId: 'r3', tier: 'unfit' }],
    }))
    const input = await mountReady()
    await submit(input)
    await vi.waitFor(() => expect(calls('smart_lookup_evidence_step')).toHaveLength(1))
    mocks.visible = false
    release()
    await vi.waitFor(() => expect(calls('smart_lookup_cancel')).toEqual([{ lookupRunId: 'run-1' }]))
    mocks.visible = true
    await mocks.focusChanged?.({ payload: true })
    await wait(20)
    // Not applied: no sources, no tiers (r3 is still listed), no answer.
    expect(document.querySelector('.source-list')).toBeNull()
    expect(ids('local')).toEqual(LOCAL)
    expect(document.body.textContent).not.toContain('LOCAL_PASSAGE_e1')
    expect(calls('smart_lookup_answer')).toHaveLength(0)
    expect(fallback()).toBe('Stopped finding evidence; showing local results only. Press Return again to retry.')
  })

  it('an answer that returns after the window was hidden is dropped', async () => {
    useLocal()
    configureBoth()
    mocks.evidenceQueue.push(step({ done: true, stop: 'maxHops', evidence: [ev('e1', 0)] }))
    let release!: (value: AnswerResult) => void
    mocks.answers.push(new Promise<AnswerResult>((resolve) => { release = resolve }))
    const input = await mountReady()
    await submit(input)
    await vi.waitFor(() => expect(calls('smart_lookup_answer')).toHaveLength(1))
    mocks.visible = false
    release(answered({ text: 'HIDDEN_ANSWER [1]', sources: [{ id: 1, evidenceId: 'e1' }] }))
    await vi.waitFor(() => expect(calls('smart_lookup_cancel')).toEqual([{ lookupRunId: 'run-1' }]))
    mocks.visible = true
    await mocks.focusChanged?.({ payload: true })
    await wait(20)
    expect(answerText()).toBeNull()
    expect(document.body.textContent).not.toContain('HIDDEN_ANSWER')
    expect(fallback()).toBe('Stopped writing the answer; below are the confirmed sources.')
    expect(footerLineText()).toBe('Sent to api.typesafe.ai, chat.example · 3 passages in all · no confidential notes sent')
  })

  it('a window hidden between rounds sends no further step', async () => {
    useLocal()
    configureBoth()
    const release = gateEvidence()
    mocks.evidenceQueue.push(step({ hop: 0, evidence: [ev('e1', 0)] }), step({ hop: 1, done: true, stop: 'maxHops', evidence: [ev('e1', 0)] }))
    const input = await mountReady()
    await submit(input)
    await vi.waitFor(() => expect(calls('smart_lookup_evidence_step')).toHaveLength(1))
    mocks.visible = false
    release()
    await vi.waitFor(() => expect(calls('smart_lookup_cancel')).toEqual([{ lookupRunId: 'run-1' }]))
    await wait(20)
    expect(calls('smart_lookup_evidence_step')).toHaveLength(1)
    expect(calls('smart_lookup_answer')).toHaveLength(0)
    expect(fallback()).toBe('Stopped finding evidence; showing local results only. Press Return again to retry.')
    // Shown again, Return retries on a new run.
    mocks.visible = true
    mocks.evidenceQueue.push(step({ done: true, stop: 'maxHops', evidence: [ev('e1', 0)] }))
    mocks.answers.push(answered({ text: 'OK [1]', sources: [{ id: 1, evidenceId: 'e1' }] }))
    key(input, 'Enter')
    await vi.waitFor(() => expect(answerText()?.textContent).toBe('OK 1'))
  })

  it.each([
    ['evidenceTooLarge', 'skipped'],
    ['budget', 'ok'],
    ['noTerms', 'skipped'],
    ['candidatesEmpty', 'ok'],
  ] as const)('a run that ends with %s before judging anything shows the local results, not "no answer"', async (stop, status) => {
    useLocal()
    configureBoth()
    mocks.evidenceQueue.push(step({ status, stop, done: true, requestCount: 0, sentBlocks: 0, evidence: [] }))
    const input = await mountReady()
    await submit(input)
    await vi.waitFor(() => expect(fallback()).toBe('There were no passages to check this time; below are the local results.'))
    expect(chip()).toBe('Local results only')
    expect(document.querySelector('.no-match')).toBeNull()
    expect(document.body.textContent).not.toContain('all unrelated')
    expect(ids('local')).toEqual(LOCAL)
    expect(document.querySelectorAll('.local-list .result-row.dim')).toHaveLength(0)
    expect(calls('smart_lookup_answer')).toHaveLength(0)
  })

  it('a source row shows its heading path without repeating the title', async () => {
    useLocal()
    configureBoth()
    mocks.evidenceQueue.push(step({
      done: true, stop: 'maxHops',
      evidence: [ev('e1', 0, { title: 'Decision log', breadcrumb: 'Decision log > 6.1110 on time?' })],
    }))
    mocks.answers.push(answered({ text: 'A [1].', sources: [{ id: 1, evidenceId: 'e1' }] }))
    const input = await mountReady()
    await submit(input)
    await vi.waitFor(() => expect(ids('source')).toEqual(['e1']))
    const row = document.querySelector('.source-list .result-row')!
    expect(row.querySelector('.result-title')?.textContent).toBe('Decision log')
    expect(row.querySelector('.result-crumb')?.textContent).toBe('› 6.1110 on time?')
  })

  it('the narrow window: the selected source expands inline, Space folds it, and the footer is short', async () => {
    useLocal()
    configureBoth()
    mocks.evidenceQueue.push(step({ done: true, stop: 'maxHops', evidence: [ev('e1', 0), ev('e2', 1)], run: runTotals({ sentBlocks: 74 }) }))
    mocks.answers.push(answered({ text: 'A [1] B [2].', sources: [{ id: 1, evidenceId: 'e1' }, { id: 2, evidenceId: 'e2' }] }))
    const original = window.matchMedia
    let narrow = false
    window.matchMedia = ((query: string) => ({ matches: narrow && query.includes('max-width'), media: query })) as unknown as typeof window.matchMedia
    try {
      const input = await mountReady()
      await submit(input)
      await vi.waitFor(() => expect(ids('source')).toEqual(['e1', 'e2']))
      const inline = () => document.querySelectorAll('.source-list .result-row .inline-passage')
      // Only the selected row carries its passage, with 打开原文 and 收起.
      expect(inline()).toHaveLength(1)
      const passage = document.querySelector('.source-list .result-row.active .inline-passage')!
      expect(passage.textContent).toContain('LOCAL_PASSAGE_e1')
      expect(passage.textContent).toContain('Open original ↗')
      expect(passage.textContent?.replace(/\s+/g, ' ')).toContain('␣ Collapse')
      expect(document.querySelector('.footer-line.compact')?.textContent).toBe('Sent to 2 host(s) · 74 passages · no confidential notes sent')

      // The wide window leaves Space alone.
      const space = () => {
        const event = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })
        document.querySelector('.source-list .result-row.active')!.dispatchEvent(event)
        return event
      }
      expect(space().defaultPrevented).toBe(false)
      await tick()
      expect(inline()).toHaveLength(1)
      // The narrow window folds and unfolds the passage.
      narrow = true
      expect(space().defaultPrevented).toBe(true)
      await vi.waitFor(() => expect(inline()).toHaveLength(0))
      space()
      await vi.waitFor(() => expect(inline()).toHaveLength(1))
      // Another row opens unfolded.
      space()
      await vi.waitFor(() => expect(inline()).toHaveLength(0))
      key(document.querySelector('.source-list .result-row.active')!, 'ArrowDown')
      await vi.waitFor(() => expect(document.querySelector('.source-list .result-row.active .inline-passage')?.textContent).toContain('LOCAL_PASSAGE_e2'))
    } finally {
      window.matchMedia = original
    }
  })

  it('a late round for a superseded lookup is ignored', async () => {
    useLocal()
    useLocal(['r7', 'r8'], 'other question')
    configureBoth()
    const release = gateEvidence()
    mocks.evidenceQueue.push(step({ done: true, stop: 'maxHops', evidence: [ev('e1', 0)] }))
    const input = await mountReady()
    await submit(input)
    await vi.waitFor(() => expect(calls('smart_lookup_evidence_step')).toHaveLength(1))

    mocks.evidenceGates.push(new Promise<void>(() => {}))
    await submit(input, 'other question', 2)
    release()
    await wait(20)
    await tick()

    expect(calls('smart_lookup_cancel')[0]).toEqual({ lookupRunId: 'run-1' })
    expect(ids('local')).toEqual(['r7', 'r8'])
    expect(calls('smart_lookup_answer')).toHaveLength(0)
    expect(calls('smart_lookup_evidence_step').map((call) => call.lookupRunId)).toEqual(['run-1', 'run-2'])
  })

  it('the activity log records each evidence round with usage but no remote or note text', async () => {
    useLocal()
    mocks.storedSmartLookup = stored({ enhance: { jev: { ...JEV } } })
    mocks.evidenceQueue.push(step({
      done: true, stop: 'maxHops', evidence: [ev('e1', 0)],
      terms: [{ term: 'secret term', label: 'Secret Term', kind: 'namePhrase' }],
    }))
    const input = await mountReady()
    await submit(input)
    await vi.waitFor(() => expect(ids('source')).toEqual(['e1']))
    // Expansion terms and round badges are not shown.
    expect(document.body.textContent).not.toContain('Secret Term')
    const log = await copiedLog()
    const round = log.split('\n').map((line) => JSON.parse(line)).find((entry) => entry.stage === 'judge')
    expect(round).toMatchObject({ level: 'success', usage: { inputTokens: 900, outputTokens: 12 } })
    expect(round.message).toContain('evidence ok')
    expect(log).not.toContain('api.typesafe.ai')
    expect(log).not.toContain('LOCAL_PASSAGE')
    expect(log).not.toContain('Secret Term')
  })
})

describe('SmartLookupApp fallbacks', () => {
  it.each([
    ['timeout', {}, "Couldn't confirm evidence: api.typesafe.ai timed out. Below are the local results by relevance; press Return again to retry."],
    ['keyInvalid', { statusClass: '4xx' }, "Couldn't confirm evidence: api.typesafe.ai rejected the key. Below are the local results by relevance; press Return again to retry."],
    ['unreachable', { statusClass: '5xx' }, "Couldn't confirm evidence: api.typesafe.ai couldn't be reached. Below are the local results by relevance; press Return again to retry."],
    ['invalid', {}, "Couldn't confirm evidence: api.typesafe.ai sent an invalid response. Below are the local results by relevance; press Return again to retry."],
  ])('a %s shows one line with the host and reason class, the local results, and no button', async (status, extra, line) => {
    useLocal()
    configureBoth()
    mocks.evidenceQueue.push(step({ status: status as EvidenceStepResult['status'], endpointHost: 'api.typesafe.ai', done: true, ...extra }))
    const input = await mountReady()
    await submit(input)
    await vi.waitFor(() => expect(fallback()).toBe(line))
    expect(document.querySelectorAll('.fallback-line button')).toHaveLength(0)
    expect(ids('local')).toEqual(LOCAL)
    expect(chip()).toBe('Local results only')
    expect(calls('smart_lookup_answer')).toHaveLength(0)
    expect(document.body.textContent).not.toContain('4xx')
  })

  it('a failed round after a scored one discards that round, keeps the local results and retries on Return', async () => {
    useLocal()
    configureBoth()
    mocks.evidenceQueue.push(step({ evidence: [ev('e1', 0)] }), step({ hop: 1, status: 'timeout', done: true, evidence: [ev('e1', 0)] }))
    const input = await mountReady()
    await submit(input)
    await vi.waitFor(() => expect(fallback()).toContain('timed out'))
    expect(calls('smart_lookup_answer')).toHaveLength(0)
    mocks.evidenceQueue.push(step({ done: true, stop: 'maxHops', evidence: [ev('e1', 0)] }))
    mocks.answers.push(answered({ text: 'OK [1]', sources: [{ id: 1, evidenceId: 'e1' }] }))
    key(input, 'Enter')
    await vi.waitFor(() => expect(answerText()?.textContent).toBe('OK 1'))
    expect(fallback()).toBe('')
    expect(calls('smart_lookup_evidence_step').map((call) => [call.lookupRunId, call.trigger])).toEqual([
      ['run-1', 'auto'], ['run-1', 'auto'], ['run-2', 'auto'],
    ])
  })

  it('no consent for the Jev host sends nothing and links to the settings', async () => {
    useLocal()
    mocks.storedSmartLookup = stored({
      enhance: { jev: { url: 'https://openrouter.ai/api/alpha/decisions', model: 'm', authMode: 'bearer', consentHost: '' } },
    })
    const input = await mountReady()
    await submit(input)
    await vi.waitFor(() => expect(fallback()).toBe('Sending to openrouter.ai is not allowed; showing local results only. Settings'))
    expect(calls('smart_lookup_evidence_step')).toHaveLength(0)
    expect(document.body.textContent).not.toContain('Allow')
    expect(footerLineText()).toBe('')
    click(buttonNamed('Settings'))
    await vi.waitFor(() => expect(mocks.emitTo).toHaveBeenCalledWith('main', 'settings://open-tab', { tab: 'enhance' }))
  })

  it('a URL without a host is not configured and sends nothing', async () => {
    useLocal()
    mocks.storedSmartLookup = stored({ enhance: { jev: { url: 'not a url', model: 'm', authMode: 'bearer', consentHost: '' } } })
    const input = await mountReady()
    await submit(input)
    await vi.waitFor(() => expect(fallback()).toContain("Lookup enhancement isn't set up yet"))
    expect(calls('smart_lookup_evidence_step')).toHaveLength(0)
  })

  it('with enhancement off Enter gathers no evidence and says so in one line', async () => {
    useLocal()
    mocks.storedSmartLookup = stored({ enhance: { enabled: false, jev: { ...JEV } } })
    const input = await mountReady()
    await submit(input)
    await wait(20)
    expect(calls('smart_lookup_evidence_step')).toHaveLength(0)
    expect(fallback()).toBe("Lookup enhancement isn't set up yet; showing local results only. Settings")
  })

  it('a busy index says so without an action', async () => {
    useLocal()
    configureBoth()
    mocks.evidenceQueue.push(step({ status: 'skipped', skipReason: 'indexUnavailable', endpointHost: null, requestCount: 0, done: true }))
    const input = await mountReady()
    await submit(input)
    await vi.waitFor(() => expect(fallback()).toBe('Index busy — no evidence searched'))
    expect(document.querySelectorAll('.fallback-line button')).toHaveLength(0)
  })

  it('a route the host skips shows the local results with no button to start the evidence', async () => {
    useLocal()
    configureBoth()
    mocks.evidenceQueue.push(step({ status: 'skipped', skipReason: 'fewTerms', endpointHost: null, requestCount: 0, done: true }))
    const input = await mountReady()
    await submit(input)
    await vi.waitFor(() => expect(chip()).toBe('Local results only'))
    expect(fallback()).toBe('')
    expect(document.body.textContent).not.toContain('Find evidence')
    expect(calls('smart_lookup_evidence_step')).toHaveLength(1)
    expect(calls('smart_lookup_answer')).toHaveLength(0)
  })

  it('a host error for a step shows one line and keeps the local results', async () => {
    useLocal()
    configureBoth()
    mocks.evidenceQueue.push(new Error('lookup run expired at /Users/me/vault'))
    const input = await mountReady()
    await submit(input)
    await vi.waitFor(() => expect(fallback()).toBe("Couldn't confirm evidence. Below are the local results by relevance; press Return again to retry."))
    expect(document.body.textContent).not.toContain('/Users/me')
    expect(ids('local')).toEqual(LOCAL)
  })
})

describe('SmartLookupApp zero hits', () => {
  it('rephrases automatically; results from other wordings are shown passively and never judged', async () => {
    mocks.local = 'empty'
    configureBoth()
    mocks.keys = { jev: true, chat: true }
    const groups = [{ terms: ['预算', '计划'], phrases: [] }, { terms: ['航天'], phrases: ['火星 计划'] }]
    mocks.repair = {
      status: 'ok', skipReason: null, missing: null, endpointHost: 'chat.example', statusClass: null,
      groups, requestCount: 1, elapsedMs: 800, usage: { inputTokens: 60, outputTokens: 20 },
    }
    mocks.groups = { search: response([rh('r9')]), lookupRunId: 'run-2', time: null, groupCounts: [0, 1], hitGroups: [[2]] }
    const input = await mountReady()
    await submit(input, 'release risk', 0)

    await vi.waitFor(() => expect(ids('local')).toEqual(['r9']))
    expect(calls('smart_lookup_repair_suggest')).toEqual([expect.objectContaining({ trigger: 'auto', lookupRunId: 'run-1', chat: CHAT })])
    expect(calls('smart_lookup_search_groups')).toEqual([{ lookupRunId: 'run-1', groups, limit: 50 }])
    // Found something: no line-by-line scan, no evidence, no answer.
    expect(calls('smart_lookup_local')).toHaveLength(1)
    expect(calls('smart_lookup_evidence_step')).toHaveLength(0)
    expect(calls('smart_lookup_answer')).toHaveLength(0)
    const strip = document.querySelector('.repair-strip')!.textContent!
    expect(strip).toContain('Original question: 0 locally · 2 ms')
    expect(strip).toContain('Two other wordings found 1 locally')
    expect(strip).toContain('Wording B · 1')
    expect(strip).toContain('"火星 计划"')
    expect(strip).toContain('Results from other wordings are not judged')
    // Passive: nothing to edit, no search or back button.
    expect(document.querySelectorAll('.repair-strip input, .repair-strip button')).toHaveLength(0)
    expect(chip()).toBe('Local results only')
    expect(footerLineText()).toBe('Sent to chat.example · 0 passages in all · no confidential notes sent')
  })

  it('a hidden window does not rephrase: nothing is sent', async () => {
    mocks.local = 'empty'
    configureBoth()
    mocks.keys = { jev: true, chat: true }
    mocks.repair = {
      status: 'ok', skipReason: null, missing: null, endpointHost: 'chat.example', statusClass: null,
      groups: [{ terms: ['预算'], phrases: [] }], requestCount: 1, elapsedMs: 300, usage: null,
    }
    mocks.visible = false
    const input = await mountReady()
    setQuery(input, 'release risk')
    key(input, 'Enter')
    await vi.waitFor(() => expect(calls('smart_lookup_key_status')).toHaveLength(1))
    // The scan that follows is local; the evidence it would start refuses a hidden window too.
    await vi.waitFor(() => expect(calls('smart_lookup_local')).toHaveLength(2))
    await wait(30)
    expect(calls('smart_lookup_repair_suggest')).toHaveLength(0)
    expect(calls('smart_lookup_search_groups')).toHaveLength(0)
    expect(calls('smart_lookup_evidence_step')).toHaveLength(0)
    expect(calls('smart_lookup_answer')).toHaveLength(0)
  })

  it('when the other wordings find nothing either, scans every file line by line, then lists what ran', async () => {
    mocks.local = 'empty'
    configureBoth()
    mocks.keys = { jev: true, chat: true }
    const base = mocks.invoke.getMockImplementation()!
    mocks.invoke.mockImplementation(async (command: string, args?: Record<string, any>) => {
      if (command === 'smart_lookup_local' && args?.deep === true) {
        return { search: { ...response([]), tookMs: 1900 }, lookupRunId: `run-${++mocks.runCounter}`, time: null }
      }
      return base(command, args)
    })
    mocks.repair = {
      status: 'ok', skipReason: null, missing: null, endpointHost: 'chat.example', statusClass: null,
      groups: [{ terms: ['采购合同'], phrases: [] }, { terms: ['返点'], phrases: [] }], requestCount: 1, elapsedMs: 700, usage: null,
    }
    mocks.groups = { search: { ...response([]), tookMs: 40 }, lookupRunId: 'run-2', time: null, groupCounts: [0, 0], hitGroups: [] }
    const input = await mountReady()
    await submit(input, 'release risk', 0)
    await vi.waitFor(() => expect(noMatchPanel()).toContain('Scanned every file line by line'))

    const order = mocks.invoke.mock.calls.map(([command, args]) => (command === 'smart_lookup_local' ? `local:${args.deep}` : command))
      .filter((command) => command.startsWith('local') || command.startsWith('smart_lookup_repair') || command.startsWith('smart_lookup_search_groups'))
    expect(order).toEqual(['local:false', 'smart_lookup_repair_suggest', 'smart_lookup_search_groups', 'local:true'])
    const tried = [...document.querySelectorAll('.no-match .attempt')].map((row) => row.textContent?.replace(/\s+/g, ' ').trim())
    expect(tried).toEqual([
      'Searched the original question on this device0',
      'Searched again with two other wordings (采购合同, 返点)0',
      'Scanned every file line by line0',
    ])
    expect(noMatchPanel()).toContain('Nothing in your notes answers this question.')
    expect(document.querySelectorAll('.no-match button')).toHaveLength(0)
    expect(chip()).toBe('No evidence')
    expect(calls('smart_lookup_evidence_step')).toHaveLength(0)
    // The scan already ran: ⌘K does not offer it again.
    await openMenu()
    expect([...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent?.trim())).not.toContain('Expand search')
  })

  it('a line-by-line scan that finds something gathers evidence and answers', async () => {
    mocks.preview = 'empty'
    mocks.local = 'empty'
    configureBoth()
    mocks.evidenceQueue.push(step({ done: true, stop: 'maxHops', evidence: [ev('e1', 0)] }))
    mocks.answers.push(answered({ text: 'Found [1].', sources: [{ id: 1, evidenceId: 'e1' }] }))
    const input = await mountReady()
    await submit(input, 'release risk', 0)
    await vi.waitFor(() => expect(answerText()?.textContent).toBe('Found 1.'))
    expect(calls('smart_lookup_local').map((call) => call.deep)).toEqual([false, true])
    expect(calls('smart_lookup_evidence_step')).toEqual([expect.objectContaining({ lookupRunId: 'run-2', trigger: 'auto', deep: true })])
  })

  it('without a repair model and with the scan off, only the local search ran', async () => {
    mocks.local = 'empty'
    mocks.storedSmartLookup = stored({ results: { autoDeepOnZero: false } })
    const input = await mountReady()
    await submit(input, 'release risk', 0)
    await vi.waitFor(() => expect(noMatchPanel()).toContain('Nothing in your notes answers this question.'))
    const tried = [...document.querySelectorAll('.no-match .attempt')].map((row) => row.textContent?.replace(/\s+/g, ' ').trim())
    expect(tried).toEqual(['Searched the original question on this device0'])
    expect(calls('smart_lookup_local')).toHaveLength(1)
    expect(calls('smart_lookup_repair_suggest')).toHaveLength(0)
    expect(footerLineText()).toBe('')
  })

  it('⌘K expand search still runs a deep local lookup on zero results', async () => {
    mocks.preview = 'empty'
    mocks.local = 'empty'
    mocks.storedSmartLookup = stored({ results: { autoDeepOnZero: false }, enhance: { jev: { ...JEV } } })
    const input = await mountReady()
    await submit(input, 'release risk', 0)
    await vi.waitFor(() => expect(noMatchPanel()).toContain('Nothing in your notes answers this question.'))

    await chooseMenuAction('Expand search')
    await vi.waitFor(() => expect(calls('smart_lookup_local')).toHaveLength(2))
    expect(calls('smart_lookup_local')[1]).toEqual(expect.objectContaining({ question: 'release risk', deep: true, timeoutMs: 4000 }))
    await vi.waitFor(() => expect(calls('smart_lookup_evidence_step')).toEqual([
      expect.objectContaining({ lookupRunId: 'run-2', trigger: 'user', deep: true }),
    ]))
  })

  it('a repair that returns no wording says so in the list of tries', async () => {
    mocks.local = 'empty'
    mocks.storedSmartLookup = stored({ results: { autoDeepOnZero: false }, enhance: { jev: { ...JEV }, chat: { ...CHAT } } })
    mocks.keys = { jev: true, chat: true }
    mocks.repair = {
      status: 'ok', skipReason: null, missing: null, endpointHost: 'chat.example', statusClass: null,
      groups: [], requestCount: 1, elapsedMs: 300, usage: null,
    }
    const input = await mountReady()
    await submit(input, 'release risk', 0)
    await vi.waitFor(() => expect(noMatchPanel()).toContain('chat.example sent no usable wording; results unchanged'))
    expect(calls('smart_lookup_search_groups')).toHaveLength(0)
  })

  it('hiding the window by its own command still cancels an in-flight repair', async () => {
    mocks.local = 'empty'
    configureBoth()
    mocks.keys = { jev: true, chat: true }
    let release!: () => void
    const gateRepair = new Promise<void>((resolve) => { release = resolve })
    const base = mocks.invoke.getMockImplementation()!
    mocks.invoke.mockImplementation(async (command: string, args?: Record<string, any>) => {
      if (command === 'smart_lookup_repair_suggest') { await gateRepair; return null }
      return base(command, args)
    })
    const input = await mountReady()
    await submit(input, 'release risk', 0)
    await vi.waitFor(() => expect(calls('smart_lookup_repair_suggest')).toHaveLength(1))
    key(input, 'Escape')
    await vi.waitFor(() => expect(calls('hide_smart_search_window')).toHaveLength(1))
    expect(calls('smart_lookup_cancel')).toEqual([{ lookupRunId: 'run-1' }])
    release()
  })
})

describe('SmartLookupApp launch view', () => {
  it('the launch view shows recent lookups with no first-run note, even for old settings that never saw it', async () => {
    localStorage.setItem('notemd.smartLookup.recent', JSON.stringify(['release risk', 'budget']))
    mocks.storedSmartLookup = stored({ launch: { firstRunSeen: false } })
    await mountReady()
    await vi.waitFor(() => expect(document.querySelectorAll('.recent-item')).toHaveLength(2))
    expect(document.querySelector('.first-run')).toBeNull()
    expect(document.body.textContent).not.toContain('What happens after Return')
    // The stored flag stays readable and is never written by the window.
    expect(settings.smartLookup.launch.firstRunSeen).toBe(false)
    expect((mocks.storedSmartLookup as any).launch.firstRunSeen).toBe(false)

    click(recentItem('release risk'))
    await vi.waitFor(() => expect(calls('smart_lookup_local')).toHaveLength(1))
    expect(calls('smart_lookup_local').at(-1)).toMatchObject({ question: 'release risk' })
  })

  it('the launch view asks for a question and the footer says the answer is on', async () => {
    const input = await mountReady()
    expect((input as HTMLTextAreaElement).placeholder).toBe('Ask a question')
    await vi.waitFor(() => expect(document.querySelector('.footer')?.textContent).toContain('Answers with sources · on'))
  })

  it('the launch footer has no answer chip while lookup enhancement is off', async () => {
    mocks.storedSmartLookup = stored({ enhance: { enabled: false } })
    await mountReady()
    await vi.waitFor(() => expect(settings.smartLookup.enhance.enabled).toBe(false))
    expect(document.querySelector('.footer')?.textContent).not.toContain('Answers with sources')
  })

  it('clearing recent lookups empties the launch list', async () => {
    localStorage.setItem('notemd.smartLookup.recent', JSON.stringify(['release risk']))
    await mountReady()
    await vi.waitFor(() => expect(document.querySelectorAll('.recent-item')).toHaveLength(1))
    expect(document.body.textContent).not.toContain('What happens after Return')
    click(buttonNamed('Clear'))
    await vi.waitFor(() => expect(document.querySelectorAll('.recent-item')).toHaveLength(0))
    expect(localStorage.getItem('notemd.smartLookup.recent')).toBeNull()
  })

  it('the launch view shows counts, a local-only note, and runs a recent lookup with arrows and Return', async () => {
    localStorage.setItem('notemd.smartLookup.recent', JSON.stringify(['release risk', 'budget']))
    localStorage.setItem('notemd.smartLookup.recentCounts', JSON.stringify({ 'release risk': 12, budget: 5 }))
    useLocal()
    useLocal(['r7'], 'budget')
    const input = await mountReady()
    await vi.waitFor(() => expect(document.querySelectorAll('.recent-item')).toHaveLength(2))
    expect(recentItem('release risk').textContent).toContain('12 results')
    const launch = document.querySelector('.launch')!.textContent!
    expect(launch).toContain('12 results')
    expect(launch).toContain('5 results')
    expect(launch).toContain('Recent lookups stay on this device.')

    key(input, 'ArrowDown')
    key(input, 'ArrowDown')
    await vi.waitFor(() => expect(document.querySelector('.recent-item.selected')?.textContent).toContain('budget'))
    key(input, 'ArrowUp')
    key(input, 'ArrowDown')
    key(input, 'Enter')
    await vi.waitFor(() => expect(calls('smart_lookup_local')).toHaveLength(1))
    expect(calls('smart_lookup_local')[0]).toMatchObject({ question: 'budget' })
    await vi.waitFor(() => expect(ids('local')).toEqual(['r7']))
    expect(JSON.parse(localStorage.getItem('notemd.smartLookup.recentCounts')!)).toMatchObject({ budget: 1 })
  })

})
