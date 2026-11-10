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
  /** Judge results handed out in call order; the default echoes the display order. */
  judgeQueue: [] as unknown[],
  judgeGates: [] as Array<Promise<void> | null>,
  diagnosis: { terms: [] } as unknown,
  keys: { jev: true, chat: false },
  repair: null as unknown,
  groups: null as unknown,
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
      save: vi.fn(async () => {}),
    })),
  },
}))

import SmartLookupApp from './SmartLookupApp.svelte'
import { settings } from './lib/settings.svelte'
import type { JudgeResult } from './lib/smart-search/api'

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

function judgement(partial: Partial<JudgeResult> = {}): JudgeResult {
  return {
    status: 'ok', skipReason: null, missing: null, endpointHost: 'api.typesafe.ai', statusClass: null,
    verdicts: [], order: [], judgedCount: 0, rerankedCount: 0, topTenUnfit: false, requestCount: 1,
    reused: false, elapsedMs: 420, poolSize: 3, sentBlocks: 3, estimatedTokens: 900, skippedRollups: 0,
    skippedConfidential: 0, skippedStale: 0, skippedLong: 0, usage: { inputTokens: 900, outputTokens: 12 },
    ...partial,
  }
}

const JEV = { url: 'https://api.typesafe.ai/v1', model: 'jev-1', authMode: 'bearer', consentHost: 'api.typesafe.ai' }
const CHAT = { url: 'https://chat.example/v1', model: 'small' }

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
    if (command === 'smart_lookup_judge') {
      const queued = mocks.judgeQueue.shift()
      const gate = mocks.judgeGates.shift()
      if (gate) await gate
      if (queued instanceof Error) throw queued
      return queued ?? judgement({ order: args?.displayOrder ?? [] })
    }
    if (command === 'smart_lookup_diagnose') return mocks.diagnosis
    if (command === 'smart_lookup_key_status') return mocks.keys
    if (command === 'smart_lookup_repair_suggest') return mocks.repair
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

async function submit(input: HTMLTextAreaElement, value = 'release risk', rows = 3): Promise<void> {
  setQuery(input, value)
  key(input, 'Enter')
  await vi.waitFor(() => {
    expect(document.querySelector('.results-pane .pane-header')?.textContent).toContain('Local results')
    expect(document.querySelectorAll('.result-row')).toHaveLength(rows)
  })
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
  mocks.judgeQueue = []
  mocks.judgeGates = []
  mocks.diagnosis = { terms: [] }
  mocks.keys = { jev: true, chat: false }
  mocks.repair = null
  mocks.groups = null
  mocks.storedSmartLookup = { enhance: { jev: { ...JEV } }, launch: { firstRunSeen: true } }
  Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true })
  installInvokeMock()
})

afterEach(async () => {
  if (component) await unmount(component)
  component = null
  document.body.innerHTML = ''
  localStorage.clear()
})

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

  it('Enter shows local results immediately with zero model calls', async () => {
    const input = await mountReady()
    await submit(input)

    expect(calls('smart_lookup_local')).toHaveLength(1)
    expect(calls('smart_lookup_local')[0]).toEqual(expect.objectContaining({
      question: 'release risk', deep: false, limit: 50,
    }))
    expect(agentCommands('run-task')).toHaveLength(0)
    expect(document.querySelector('.result-row.active')?.textContent).toContain('alpha')
    expect(document.querySelector('.preview-pane')?.textContent).toContain('notes/alpha.md:4')
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

  it('expand search runs a deep local lookup on zero results', async () => {
    mocks.preview = 'empty'
    mocks.local = 'empty'
    const input = await mountReady()
    await submit(input, 'release risk', 0)
    expect(document.body.textContent).toContain('Nothing found')
    expect(document.body.textContent).toContain('Try a shorter topic')

    await chooseMenuAction('Expand search')
    await vi.waitFor(() => expect(document.querySelectorAll('.result-row')).toHaveLength(3))
    const lookups = calls('smart_lookup_local')
    expect(lookups).toHaveLength(2)
    expect(lookups[1]).toEqual(expect.objectContaining({
      question: 'release risk', deep: true, timeoutMs: 4000,
    }))
    expect(agentCommands('run-task')).toHaveLength(0)
  })

  it('searches more broadly once when Enter finds nothing and the setting is on', async () => {
    mocks.preview = 'empty'
    mocks.local = 'empty'
    mocks.storedSmartLookup = { results: { autoDeepOnZero: true } }
    const input = await mountReady()
    await submit(input, 'release risk', 3)

    const lookups = calls('smart_lookup_local')
    expect(lookups).toHaveLength(2)
    expect(lookups[0]).toEqual(expect.objectContaining({ question: 'release risk', deep: false }))
    expect(lookups[1]).toEqual(expect.objectContaining({
      question: 'release risk', deep: true, timeoutMs: 4000,
    }))
    await wait(50)
    expect(calls('smart_lookup_local')).toHaveLength(2)
    expect(agentCommands('run-task')).toHaveLength(0)
  })

  it('does not search more broadly on its own when the setting is off', async () => {
    mocks.preview = 'empty'
    mocks.local = 'empty'
    mocks.storedSmartLookup = { results: { autoDeepOnZero: false } }
    const input = await mountReady()
    await submit(input, 'release risk', 0)
    await wait(50)
    expect(calls('smart_lookup_local')).toHaveLength(1)
    expect(document.body.textContent).toContain('Nothing found')
  })

  it('does not search more broadly when Enter finds results', async () => {
    mocks.storedSmartLookup = { results: { autoDeepOnZero: true } }
    const input = await mountReady()
    await submit(input)
    await wait(50)
    expect(calls('smart_lookup_local')).toHaveLength(1)
  })

  it('copy activity log includes elapsed time', async () => {
    const input = await mountReady()
    await submit(input)
    await chooseMenuAction('Copy activity log')

    await vi.waitFor(() => expect(mocks.writeText).toHaveBeenCalledTimes(1))
    const lines = String(mocks.writeText.mock.calls[0][0]).split('\n').map((line) => JSON.parse(line))
    const search = lines.find((entry) => entry.stage === 'search')
    expect(search).toMatchObject({ level: 'success', usage: null })
    expect(typeof search.elapsedMs).toBe('number')
    expect(search.elapsedMs).toBeGreaterThanOrEqual(0)
  })

  it('the actions menu offers no answer or research rows', async () => {
    const input = await mountReady()
    await submit(input, 'release risk')
    await openMenu()
    const rows = [...document.querySelectorAll('[role="menuitem"]')].map((row) => row.textContent?.trim())
    expect(rows).toContain('Copy reference')
    expect(rows).toContain('Copy activity log')
    expect(rows).not.toContain('Create answer')
    expect(rows.some((row) => row?.startsWith('In-depth research'))).toBe(false)
    expect(mocks.invoke.mock.calls.map(([cmd]) => cmd)).not.toContain('plugin_v2_execute')
  })

  it('groups by month when settings ask for date grouping, and reloads on settings change', async () => {
    mocks.customHits = [hit('alpha', 4, '2026-08-20'), hit('beta', 8, null), hit('gamma', 12, '2026-10-02')]
    const input = await mountReady()
    await submit(input)
    expect(document.querySelectorAll('[role="listbox"] [role="group"]')).toHaveLength(1)

    mocks.storedSmartLookup = { results: { groupBy: 'date' } }
    for (const handler of mocks.listeners.get('settings://changed') ?? []) await handler()
    await vi.waitFor(() => {
      const groups = Array.from(document.querySelectorAll('[role="listbox"] [role="group"]'))
      expect(groups.map((group) => group.getAttribute('aria-label'))).toEqual(['2026-10', '2026-08', 'Date unknown'])
    })
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

// ---- enhancement: judging, repair, conditions, launch view, footer ----

const LOCAL = ['r1', 'r2', 'r3']

function rowIds(): Array<string | null> {
  return [...document.querySelectorAll('.result-row')].map((row) => row.getAttribute('data-result-id'))
}

function row(id: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`.result-row[data-result-id="${id}"]`)
  expect(element, `Row ${id}`).not.toBeNull()
  return element!
}

function activeRowId(): string | null | undefined {
  return document.querySelector('.result-row.active')?.getAttribute('data-result-id')
}

function header(): string {
  return document.querySelector('.judge-header')?.textContent ?? ''
}

function footer(): string {
  return document.querySelector('footer')?.textContent?.trim() ?? ''
}

function noMatchPanel(): string {
  return document.querySelector('.no-match')?.textContent ?? ''
}

function button(label: string): HTMLButtonElement {
  return buttonNamed(label)
}

function click(element: HTMLElement): void {
  element.click()
}

function timeChip(): HTMLButtonElement {
  const chip = document.querySelector<HTMLButtonElement>('.time-chip')
  expect(chip, 'time chip').not.toBeNull()
  return chip!
}

async function choose(chip: HTMLButtonElement, label: string): Promise<void> {
  chip.click()
  await vi.waitFor(() => expect(document.querySelector('.time-menu[role="menu"]')).not.toBeNull())
  const item = [...document.querySelectorAll<HTMLButtonElement>('.time-menu [role="menuitemradio"]')]
    .find((candidate) => candidate.textContent?.trim() === label)
  expect(item, `Time option ${label}`).toBeDefined()
  item!.click()
}

function recentItem(label: string): HTMLButtonElement {
  const item = [...document.querySelectorAll<HTMLButtonElement>('.recent-item')]
    .find((candidate) => candidate.textContent?.trim() === label)
  expect(item, `Recent ${label}`).toBeDefined()
  return item!
}

function gate(): () => void {
  let release!: () => void
  mocks.judgeGates.push(new Promise<void>((resolve) => { release = resolve }))
  return release
}

function useLocal(ids: string[] = LOCAL, question = 'release risk'): void {
  mocks.localByQuestion[question] = ids.map((id) => rh(id))
}

const REORDERED = () => judgement({
  order: ['r3', 'r1', 'r2'],
  verdicts: [{ resultId: 'r3', tier: 'fit' }, { resultId: 'r1', tier: 'unsure' }, { resultId: 'r2', tier: 'unsure' }],
  judgedCount: 3,
  rerankedCount: 3,
})

describe('SmartLookupApp enhancement', () => {
  it('enter judges once and applies the order when the user has not moved', async () => {
    useLocal()
    mocks.judgeQueue.push(REORDERED())
    const input = await mountReady()
    await submit(input)

    await vi.waitFor(() => expect(rowIds()).toEqual(['r3', 'r1', 'r2']))
    expect(calls('smart_lookup_judge')).toHaveLength(1)
    expect(calls('smart_lookup_judge')[0]).toMatchObject({
      lookupRunId: 'run-1',
      displayOrder: ['r1', 'r2', 'r3'],
      sectionBreaks: [],
      trigger: 'auto',
      jev: { url: 'https://api.typesafe.ai/v1', consentHost: 'api.typesafe.ai' },
    })
    expect(Object.keys(calls('smart_lookup_judge')[0].jev).sort()).toEqual(['authMode', 'consentHost', 'model', 'url'])
    expect(header()).toContain('Reordered 3 by judgement')
    expect(row('r3').textContent).toContain('Fits')
    expect(row('r3').textContent).toContain('↑ was #3')
    expect(row('r1').textContent).not.toContain('Fits')
    expect(row('r1').textContent).not.toContain('Possibly unrelated')
    // Nothing was selected by the user, so the new top result is the current one.
    expect(activeRowId()).toBe('r3')
  })

  it('shows the judging state with a stop button that cancels the request', async () => {
    useLocal()
    const release = gate()
    mocks.judgeQueue.push(REORDERED())
    const input = await mountReady()
    await submit(input)
    await vi.waitFor(() => expect(header()).toContain('Judging up to 3 · 0s'))

    click(button('Stop'))
    await vi.waitFor(() => expect(header()).toContain('Judging stopped'))
    expect(calls('smart_lookup_cancel')).toEqual([{ lookupRunId: 'run-1' }])
    release()
    await wait(20)
    expect(rowIds()).toEqual(LOCAL)
    expect(header()).toContain('Judging stopped')
  })

  it('the judged header opens the details popover', async () => {
    useLocal()
    mocks.judgeQueue.push({ ...REORDERED(), skippedRollups: 2, skippedConfidential: 1, poolSize: 12 })
    const input = await mountReady()
    await submit(input)
    await vi.waitFor(() => expect(header()).toContain('Reordered 3 by judgement'))

    click(button('Reordered 3 by judgement'))
    await vi.waitFor(() => expect(document.querySelector('.judge-details')).not.toBeNull())
    const details = document.querySelector('.judge-details')!.textContent!
    expect(details).toContain('Sent to api.typesafe.ai')
    expect(details).toContain('1 request(s) · 420 ms')
    expect(details).toContain('Sent 3 passages · about 900 tokens')
    expect(details).toContain('Not sent: 2 whole sections · 1 confidential')
    expect(details).toContain('Judged 3 of the first 12')
    click(button('Restore local order'))
    await vi.waitFor(() => expect(rowIds()).toEqual(LOCAL))
    expect(header()).toContain('New order available')
  })

  it('a judgement arriving after the user moved waits for apply', async () => {
    useLocal()
    const release = gate()
    mocks.judgeQueue.push(REORDERED())
    const input = await mountReady()
    await submit(input)
    await vi.waitFor(() => expect(calls('smart_lookup_judge')).toHaveLength(1))

    key(input, 'ArrowDown')
    await vi.waitFor(() => expect(document.activeElement?.getAttribute('data-result-id')).toBe('r1'))
    key(document.activeElement!, 'ArrowDown')
    await vi.waitFor(() => expect(document.activeElement?.getAttribute('data-result-id')).toBe('r2'))
    release()

    await vi.waitFor(() => expect(header()).toContain('New order available'))
    expect(rowIds()).toEqual(['r1', 'r2', 'r3'])
    click(button('Apply'))
    await vi.waitFor(() => expect(rowIds()).toEqual(['r3', 'r1', 'r2']))
    expect(activeRowId()).toBe('r2')
    expect(header()).toContain('Reordered 3 by judgement')
  })

  it('scrolling the result list counts as moving', async () => {
    useLocal()
    const release = gate()
    mocks.judgeQueue.push(REORDERED())
    const input = await mountReady()
    await submit(input)
    document.querySelector('.results-scroll')!.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 40 }))
    release()
    await vi.waitFor(() => expect(header()).toContain('New order available'))
    expect(rowIds()).toEqual(LOCAL)
  })

  it('an ok judgement that moved nothing shows judged, not pending, after interaction', async () => {
    useLocal()
    const release = gate()
    mocks.judgeQueue.push(judgement({ order: LOCAL, verdicts: [{ resultId: 'r1', tier: 'fit' }], judgedCount: 3 }))
    const input = await mountReady()
    await submit(input)
    key(input, 'ArrowDown')
    await vi.waitFor(() => expect(activeRowId()).toBe('r1'))
    release()
    await vi.waitFor(() => expect(header()).toContain('Judged 3; order unchanged'))
    expect(header()).not.toContain('New order available')
  })

  it('restores the local order with the shortcut outside the input', async () => {
    useLocal()
    mocks.judgeQueue.push(REORDERED())
    const input = await mountReady()
    await submit(input)
    await vi.waitFor(() => expect(rowIds()).toEqual(['r3', 'r1', 'r2']))

    // Inside the input ⌘Z stays text undo.
    key(input, 'z', { metaKey: true })
    await tick()
    expect(rowIds()).toEqual(['r3', 'r1', 'r2'])

    key(input, 'ArrowDown')
    await vi.waitFor(() => expect(document.activeElement?.classList.contains('result-row')).toBe(true))
    key(document.activeElement!, 'z', { metaKey: true })
    await vi.waitFor(() => expect(rowIds()).toEqual(['r1', 'r2', 'r3']))
    expect(header()).toContain('New order available')
    expect(activeRowId()).toBe('r3')
  })

  it('a key error shows only host and status class', async () => {
    useLocal()
    mocks.judgeQueue.push(judgement({ status: 'keyInvalid', endpointHost: 'api.typesafe.ai', statusClass: '4xx', requestCount: 1 }))
    const input = await mountReady()
    await submit(input)
    await vi.waitFor(() => expect(header()).toContain('api.typesafe.ai rejected the key (4xx)'))
    expect(rowIds()).toEqual(['r1', 'r2', 'r3'])
    expect(document.querySelector('.result-badge')).toBeNull()
  })

  it('a timeout keeps the local order and retries as a user action', async () => {
    useLocal()
    mocks.judgeQueue.push(judgement({ status: 'timeout' }), REORDERED())
    const input = await mountReady()
    await submit(input)
    await vi.waitFor(() => expect(header()).toContain('Judging timed out; local order kept'))
    expect(rowIds()).toEqual(LOCAL)
    click(button('Try again'))
    await vi.waitFor(() => expect(calls('smart_lookup_judge')).toHaveLength(2))
    expect(calls('smart_lookup_judge')[1]).toMatchObject({ trigger: 'user', lookupRunId: 'run-1' })
  })

  it('a busy index says so without an action', async () => {
    useLocal()
    mocks.judgeQueue.push(judgement({ status: 'skipped', skipReason: 'indexUnavailable', endpointHost: null, requestCount: 0 }))
    const input = await mountReady()
    await submit(input)
    await vi.waitFor(() => expect(header()).toContain('Index busy — not judged'))
    expect(document.querySelectorAll('.judge-header button')).toHaveLength(0)
  })

  it('no consent offers allow for the current host only', async () => {
    useLocal()
    mocks.storedSmartLookup = {
      enhance: { jev: { url: 'https://openrouter.ai/api/alpha/decisions', model: 'm', authMode: 'bearer', consentHost: '' } },
    }
    mocks.judgeQueue.push(judgement({ status: 'noConsent', endpointHost: 'openrouter.ai', requestCount: 0 }))
    const input = await mountReady()
    await submit(input)
    await vi.waitFor(() => expect(header()).toContain('Sending to openrouter.ai not allowed'))

    click(button('Allow'))
    await vi.waitFor(() => expect(calls('smart_lookup_judge')).toHaveLength(2))
    expect(settings.smartLookup.enhance.jev.consentHost).toBe('openrouter.ai')
    expect(calls('smart_lookup_judge').at(-1)).toMatchObject({ trigger: 'user', jev: { consentHost: 'openrouter.ai' } })
    await vi.waitFor(() => expect((mocks.storedSmartLookup as any).enhance.jev.consentHost).toBe('openrouter.ai'))
  })

  it('an endpoint that is not set up sends nothing and opens the settings tab', async () => {
    useLocal()
    mocks.storedSmartLookup = {}
    const input = await mountReady()
    await submit(input)
    await vi.waitFor(() => expect(header()).toContain('No endpoint set up'))
    expect(calls('smart_lookup_judge')).toHaveLength(0)
    click(button('Settings'))
    await vi.waitFor(() => expect(mocks.emitTo).toHaveBeenCalledWith('main', 'settings://open-tab', { tab: 'enhance' }))
  })

  it('a late judgement for a superseded lookup is ignored', async () => {
    useLocal()
    useLocal(['r7', 'r8'], 'other question')
    const release = gate()
    mocks.judgeQueue.push(REORDERED())
    const input = await mountReady()
    await submit(input)
    await vi.waitFor(() => expect(calls('smart_lookup_judge')).toHaveLength(1))

    await submit(input, 'other question', 2)
    release()
    await wait(20)
    await tick()

    expect(calls('smart_lookup_cancel')[0]).toEqual({ lookupRunId: 'run-1' })
    expect(rowIds()).toEqual(['r7', 'r8'])
    expect(header()).not.toContain('Reordered 3')
  })

  it('zero hits diagnose, strike missing terms and repair automatically once', async () => {
    mocks.local = 'empty'
    mocks.storedSmartLookup = { enhance: { jev: { ...JEV }, chat: { ...CHAT } } }
    mocks.keys = { jev: true, chat: true }
    mocks.diagnosis = { terms: [{ term: '预算', hits: 2, capped: false }, { term: '火星', hits: 0, capped: false }] }
    const groups = [{ terms: ['预算', '计划'], phrases: [] }, { terms: ['航天'], phrases: ['火星 计划'] }]
    mocks.repair = {
      status: 'ok', skipReason: null, missing: null, endpointHost: 'chat.example', statusClass: null,
      groups, requestCount: 1, elapsedMs: 800, usage: { inputTokens: 60, outputTokens: 20 },
    }
    mocks.groups = { search: response([rh('r9')]), lookupRunId: 'run-2', time: null, groupCounts: [0, 1], hitGroups: [[2]] }
    const input = await mountReady()
    await submit(input, 'release risk', 1)

    await vi.waitFor(() => expect(rowIds()).toEqual(['r9']))
    expect(calls('smart_lookup_diagnose')).toEqual([{ lookupRunId: 'run-1' }])
    expect(calls('smart_lookup_repair_suggest')).toEqual([expect.objectContaining({ trigger: 'auto', lookupRunId: 'run-1', chat: CHAT })])
    expect(calls('smart_lookup_search_groups')).toEqual([{ lookupRunId: 'run-1', groups, limit: 50 }])
    const order = mocks.invoke.mock.calls.map(([command]) => command)
    expect(order.indexOf('smart_lookup_diagnose')).toBeLessThan(order.indexOf('smart_lookup_search_groups'))
    expect(calls('smart_lookup_judge')).toHaveLength(0)
    expect(document.querySelectorAll('s')).toHaveLength(1)
    expect(document.querySelector('s')?.textContent).toBe('火星')
    expect(row('r9').textContent).toContain('Wording 2')
    const inputs = [...document.querySelectorAll<HTMLInputElement>('.repair-strip input')]
    expect(inputs.map((field) => field.value)).toEqual(['预算 计划', '航天 "火星 计划"'])
    expect(document.querySelector('.repair-strip')?.textContent).toContain('Wording 2 · 1')

    // Editing a wording searches locally again; nothing is judged or sent to a model.
    inputs[0].value = '预算 "年度 计划"'
    inputs[0].dispatchEvent(new Event('input', { bubbles: true }))
    click(button('Search with these'))
    await vi.waitFor(() => expect(calls('smart_lookup_search_groups')).toHaveLength(2))
    expect(calls('smart_lookup_search_groups')[1].groups).toEqual([
      { terms: ['预算'], phrases: ['年度 计划'] },
      { terms: ['航天'], phrases: ['火星 计划'] },
    ])
    expect(calls('smart_lookup_repair_suggest')).toHaveLength(1)
    expect(calls('smart_lookup_judge')).toHaveLength(0)
  })

  it('zero hits without a repair model show the three attempts', async () => {
    mocks.local = 'empty'
    const input = await mountReady()
    await submit(input, 'release risk', 0)
    await vi.waitFor(() => expect(noMatchPanel()).toContain('Original question'))
    expect(noMatchPanel()).toContain('0 · 2 ms')
    expect(noMatchPanel()).toContain('Other wording')
    expect(noMatchPanel()).toMatch(/Line-by-line scan\s*Not run/)
    await wait(20)
    expect(calls('smart_lookup_repair_suggest')).toHaveLength(0)
    expect(calls('smart_lookup_judge')).toHaveLength(0)
  })

  it('the no-match panel edits the wording with the extracted terms', async () => {
    mocks.local = 'empty'
    const input = await mountReady()
    await submit(input, 'release risk', 0)
    await vi.waitFor(() => expect(noMatchPanel()).toContain('Original question'))
    click(button('Edit wording and search'))
    await vi.waitFor(() => expect(document.querySelector('.repair-strip')).not.toBeNull())
    const fields = [...document.querySelectorAll<HTMLInputElement>('.repair-strip input')]
    expect(fields.map((field) => field.value)).toEqual(['release risk', ''])

    input.setSelectionRange(3, 3)
    click(button('Rewrite question'))
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(input)
      expect(input.selectionStart).toBe(0)
      expect(input.selectionEnd).toBe('release risk'.length)
    })
  })

  it('top ten unfit offers rephrase as a user action', async () => {
    useLocal()
    mocks.storedSmartLookup = { enhance: { jev: { ...JEV }, chat: { ...CHAT } } }
    mocks.judgeQueue.push(judgement({ order: LOCAL, topTenUnfit: true, judgedCount: 3,
      verdicts: LOCAL.map((resultId) => ({ resultId, tier: 'unfit' as const })) }))
    mocks.repair = {
      status: 'ok', skipReason: null, missing: null, endpointHost: 'chat.example', statusClass: null,
      groups: [{ terms: ['发布'], phrases: [] }], requestCount: 1, elapsedMs: 600, usage: null,
    }
    mocks.groups = { search: response([rh('r9')]), lookupRunId: 'run-2', time: null, groupCounts: [1], hitGroups: [[1]] }
    const input = await mountReady()
    await submit(input)
    await vi.waitFor(() => expect(header()).toContain('None of the top 10 fit'))
    expect(row('r1').textContent).toContain('Possibly unrelated')

    click(button('Rephrase'))
    await vi.waitFor(() => expect(calls('smart_lookup_repair_suggest')).toHaveLength(1))
    expect(calls('smart_lookup_repair_suggest')[0]).toMatchObject({ trigger: 'user', lookupRunId: 'run-1' })
    await vi.waitFor(() => expect(rowIds()).toEqual(['r9']))
    expect(calls('smart_lookup_judge')).toHaveLength(1)
  })

  it('whole-section hits say they were not judged', async () => {
    mocks.localByQuestion['release risk'] = [rh('r1'), rh('r2'), rh('r4', { level: 'section' }), rh('r5', { pinned: true, level: 'section' })]
    mocks.judgeQueue.push(judgement({ order: ['r1', 'r2', 'r4', 'r5'], judgedCount: 2,
      verdicts: [{ resultId: 'r1', tier: 'unsure' }, { resultId: 'r2', tier: 'unsure' }] }))
    const input = await mountReady()
    await submit(input, 'release risk', 4)
    await vi.waitFor(() => expect(row('r4').textContent).toContain('Whole section not judged · position kept'))
    expect(row('r1').textContent).not.toContain('Whole section not judged')
    expect(row('r5').textContent).not.toContain('Whole section not judged')
  })

  it('correcting a judged result writes local feedback', async () => {
    useLocal()
    mocks.judgeQueue.push(REORDERED())
    const input = await mountReady()
    await submit(input)
    await vi.waitFor(() => expect(rowIds()).toEqual(['r3', 'r1', 'r2']))
    expect(document.querySelector('.preview-pane')?.textContent).toContain('Is this right?')

    click(button('Unrelated'))
    await vi.waitFor(() => expect(calls('smart_lookup_feedback')).toHaveLength(1))
    expect(calls('smart_lookup_feedback')[0]).toEqual({ lookupRunId: 'run-1', resultId: 'r3', verdict: 'unfit' })
    await vi.waitFor(() => expect(document.body.textContent).toContain('Recorded on this device only'))
  })

  it('the time chip re-searches locally without judging', async () => {
    useLocal()
    mocks.localTime = { sourceText: '上周', after: '2026-11-02', before: '2026-11-09', mode: 'group', inWindow: 1 }
    const input = await mountReady()
    await submit(input)
    await vi.waitFor(() => expect(calls('smart_lookup_judge')).toHaveLength(1))
    expect(calls('smart_lookup_local')[0].timeMode).toBeUndefined()
    expect(calls('smart_lookup_judge')[0]).toMatchObject({ displayOrder: LOCAL, sectionBreaks: [1] })
    const groups = [...document.querySelectorAll('[role="listbox"] [role="group"]')].map((group) => group.getAttribute('aria-label'))
    expect(groups).toEqual(['In range', 'Other dates'])
    expect(timeChip().textContent).toContain('Time: 上周')
    expect(document.querySelector('.criterion-chip')?.textContent).toContain("Criterion: directly matches what you're looking for")

    await choose(timeChip(), 'Only in range')
    await vi.waitFor(() => expect(calls('smart_lookup_local')).toHaveLength(2))
    expect(calls('smart_lookup_local').at(-1)).toMatchObject({ question: 'release risk', timeMode: 'window', deep: false })
    await wait(20)
    expect(calls('smart_lookup_judge')).toHaveLength(1)
    expect(calls('smart_lookup_repair_suggest')).toHaveLength(0)

    // A new question drops the chosen time mode.
    await submit(input, 'release risk again', 3)
    expect(calls('smart_lookup_local').at(-1).timeMode).toBeUndefined()
  })

  it('the launch view shows recent lookups and the first-run note once', async () => {
    localStorage.setItem('notemd.smartLookup.recent', JSON.stringify(['release risk', 'budget']))
    mocks.storedSmartLookup = { enhance: { jev: { ...JEV } }, launch: { firstRunSeen: false } }
    await mountReady()
    await vi.waitFor(() => expect(document.body.textContent).toContain('How Smart Lookup works'))

    click(button('Got it'))

    await vi.waitFor(() => expect(settings.smartLookup.launch.firstRunSeen).toBe(true))
    await vi.waitFor(() => expect(document.body.textContent).not.toContain('How Smart Lookup works'))
    await vi.waitFor(() => expect((mocks.storedSmartLookup as any).launch.firstRunSeen).toBe(true))

    click(recentItem('release risk'))
    await vi.waitFor(() => expect(calls('smart_lookup_local')).toHaveLength(1))
    expect(calls('smart_lookup_local').at(-1)).toMatchObject({ question: 'release risk' })
  })

  it('clearing recent lookups empties the launch list', async () => {
    localStorage.setItem('notemd.smartLookup.recent', JSON.stringify(['release risk']))
    await mountReady()
    await vi.waitFor(() => expect(document.querySelectorAll('.recent-item')).toHaveLength(1))
    expect(document.body.textContent).not.toContain('How Smart Lookup works')
    click(button('Clear'))
    await vi.waitFor(() => expect(document.querySelectorAll('.recent-item')).toHaveLength(0))
    expect(localStorage.getItem('notemd.smartLookup.recent')).toBeNull()
  })

  it('with enhancement off Enter sends no judge', async () => {
    useLocal()
    mocks.storedSmartLookup = { enhance: { enabled: false, jev: { ...JEV } } }
    const input = await mountReady()
    await submit(input)
    await wait(20)
    expect(calls('smart_lookup_judge')).toHaveLength(0)
    expect(header()).toBe('')
    expect(document.querySelector('.criterion-chip')).toBeNull()
  })

  it('the footer shows only the actions shortcut and it opens the menu', async () => {
    useLocal()
    mocks.judgeQueue.push(REORDERED())
    const input = await mountReady()
    expect(footer()).toBe('⌘K Actions')
    await submit(input)
    await vi.waitFor(() => expect(rowIds()).toEqual(['r3', 'r1', 'r2']))
    key(window, 'k', { metaKey: true })
    await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).toBeTruthy())
    const rows = [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent?.trim())
    expect(rows).toEqual(['Copy reference', 'Restore local order', 'Copy activity log'])
    expect(document.body.textContent).not.toContain('简答')
    expect(document.body.textContent).not.toContain('深入研究')
  })

  it('the activity log records judge and repair with usage but no remote text', async () => {
    useLocal()
    mocks.judgeQueue.push(REORDERED())
    const input = await mountReady()
    await submit(input)
    await vi.waitFor(() => expect(rowIds()).toEqual(['r3', 'r1', 'r2']))
    await chooseMenuAction('Copy activity log')
    await vi.waitFor(() => expect(mocks.writeText).toHaveBeenCalledTimes(1))
    const lines = String(mocks.writeText.mock.calls[0][0]).split('\n').map((line) => JSON.parse(line))
    const judge = lines.find((entry) => entry.stage === 'judge')
    expect(judge).toMatchObject({ level: 'success', usage: { inputTokens: 900, outputTokens: 12 } })
    expect(typeof judge.elapsedMs).toBe('number')
    expect(judge.message).toContain('ok')
    expect(judge.message).toContain('3')
    expect(judge.message).not.toContain('api.typesafe.ai')
  })

  it('hiding the window cancels an in-flight judgement', async () => {
    useLocal()
    gate()
    const input = await mountReady()
    await submit(input)
    await vi.waitFor(() => expect(calls('smart_lookup_judge')).toHaveLength(1))
    key(input, 'Escape')
    await vi.waitFor(() => expect(calls('hide_smart_search_window')).toHaveLength(1))
    expect(calls('smart_lookup_cancel')).toEqual([{ lookupRunId: 'run-1' }])
  })
})

