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
  diagnosis: { terms: [] } as unknown,
  keys: { jev: true, chat: false },
  repair: null as unknown,
  /** `smart_lookup_answer` results handed out in call order. */
  answers: [] as unknown[],
  groups: null as unknown,
  saveError: false,
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

function step(partial: Partial<EvidenceStepResult> = {}): EvidenceStepResult {
  return {
    status: 'ok', stop: null, skipReason: null, missing: null, endpointHost: 'api.typesafe.ai', statusClass: null, hop: 0,
    terms: [], evidence: [], localTiers: [], done: false, requestCount: 1, poolSize: 3, candidates: 3, sentBlocks: 3,
    skippedConfidential: 0, skippedStale: 0, skippedLong: 0, skippedOversize: 0, estimatedTokens: 900, tokensUsed: 900,
    usage: { inputTokens: 900, outputTokens: 12 }, elapsedMs: 420, ...partial,
  }
}

/** Evidence with local vault text, as the host returns it. */
function ev(id: string, foundRound: number, extra: Partial<EvidenceItem> = {}): EvidenceItem {
  return {
    evidenceId: id, path: `notes/${id}.md`, line: 3, lineEnd: 3, title: id, breadcrumb: `${id} heading`,
    text: `LOCAL_PASSAGE_${id} release risk`, foundRound, tier: 'fit', localResultId: null, ...extra,
  }
}

function answered(partial: Partial<AnswerResult> = {}): AnswerResult {
  return {
    status: 'ok', missing: null, endpointHost: 'chat.example', statusClass: null, text: null, sources: [],
    omittedSources: 0, requestCount: 1, elapsedMs: 900, usage: { inputTokens: 300, outputTokens: 40 }, ...partial,
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
    if (command === 'smart_lookup_evidence_step') {
      const queued = mocks.evidenceQueue.shift()
      const gate = mocks.evidenceGates.shift()
      if (gate) await gate
      if (queued instanceof Error) throw queued
      return queued ?? step({ done: true, stop: 'maxHops' })
    }
    if (command === 'smart_lookup_diagnose') return mocks.diagnosis
    if (command === 'smart_lookup_key_status') return mocks.keys
    if (command === 'smart_lookup_repair_suggest') return mocks.repair
    if (command === 'smart_lookup_answer') return mocks.answers.shift()
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
    expect(document.querySelectorAll('.result-list .result-row')).toHaveLength(rows)
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
  mocks.evidenceQueue = []
  mocks.evidenceGates = []
  mocks.diagnosis = { terms: [] }
  mocks.keys = { jev: true, chat: false }
  mocks.repair = null
  mocks.answers = []
  mocks.groups = null
  mocks.saveError = false
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
    expect(document.body.textContent).toContain("Your notes probably don't contain this")

    await chooseMenuAction('Expand search')
    await vi.waitFor(() => expect(document.querySelectorAll('.result-row')).toHaveLength(3))
    const lookups = calls('smart_lookup_local')
    expect(lookups).toHaveLength(2)
    expect(lookups[1]).toEqual(expect.objectContaining({
      question: 'release risk', deep: true, timeoutMs: 4000,
    }))
    expect(agentCommands('run-task')).toHaveLength(0)
    // The expanded run's evidence is started by the click and keeps the deep candidate count.
    await vi.waitFor(() => expect(calls('smart_lookup_evidence_step')).toEqual([
      expect.objectContaining({ lookupRunId: 'run-2', trigger: 'user', deep: true }),
    ]))
  })

  it('searches more broadly once when Enter finds nothing and the setting is on', async () => {
    mocks.preview = 'empty'
    mocks.local = 'empty'
    mocks.storedSmartLookup = { results: { autoDeepOnZero: true }, enhance: { jev: { ...JEV } } }
    const input = await mountReady()
    await submit(input, 'release risk', 3)
    await vi.waitFor(() => expect(calls('smart_lookup_evidence_step')).toEqual([
      expect.objectContaining({ lookupRunId: 'run-2', trigger: 'auto', deep: true }),
    ]))

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
    expect(document.body.textContent).toContain("Your notes probably don't contain this")
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

describe('SmartLookupApp evidence', () => {
  it('shows local results first, then evidence rounds above them', async () => {
    useLocal()
    mocks.evidenceQueue.push(
      step({ hop: 0, evidence: [ev('e1', 0)] }),
      step({
        hop: 1, done: true, stop: 'maxHops',
        terms: [{ term: 'alice paul', label: 'Alice Paul', kind: 'namePhrase' }],
        evidence: [ev('e1', 0), ev('e2', 1)],
      }),
    )
    const input = await mountReady()
    await submit(input)

    await vi.waitFor(() => expect(evidenceIds()).toEqual(['e1', 'e2']))
    const sent = calls('smart_lookup_evidence_step')
    expect(sent).toEqual([
      { lookupRunId: 'run-1', jev: JEV, trigger: 'auto', deep: false },
      { lookupRunId: 'run-1', jev: JEV, trigger: 'auto', deep: false },
    ])
    expect(Object.keys(sent[0].jev).sort()).toEqual(['authMode', 'consentHost', 'model', 'url'])
    expect(calls('smart_lookup_judge')).toHaveLength(0)

    const title = document.querySelector('.evidence-title')!
    expect(title.textContent).toContain('Evidence')
    expect(title.compareDocumentPosition(document.querySelector('.result-list')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(evidenceRow('e1').textContent).toContain('Local')
    expect(evidenceRow('e2').textContent).toContain('Expansion 1')
    expect(evidenceRow('e2').textContent).toContain('e2 heading')
    expect(evidenceRow('e2').textContent).toContain('LOCAL_PASSAGE_e2')
    // The term as it is spelled in the notes, not the rewritten one.
    expect(evidenceHead()).toContain('Expansion terms: Alice Paul')
    expect(evidenceHead()).not.toContain('alice paul')
    // The local list keeps its order, and nothing was chosen, so the top evidence is current.
    expect(rowIds()).toEqual(LOCAL)
    expect(activeEvidenceId()).toBe('e1')
  })

  it('does not move the selection when a round arrives after the user moved', async () => {
    useLocal()
    mocks.evidenceGates.push(null)
    const release = gateEvidence()
    mocks.evidenceQueue.push(
      step({ hop: 0, evidence: [ev('e1', 0), ev('e2', 0)] }),
      step({ hop: 1, done: true, stop: 'maxHops', evidence: [ev('e3', 1), ev('e1', 0)] }),
    )
    const input = await mountReady()
    await submit(input)
    await vi.waitFor(() => expect(evidenceIds()).toEqual(['e1', 'e2']))
    await vi.waitFor(() => expect(calls('smart_lookup_evidence_step')).toHaveLength(2))

    key(input, 'ArrowDown')
    await vi.waitFor(() => expect(document.activeElement?.getAttribute('data-evidence-id')).toBe('e1'))
    key(document.activeElement!, 'ArrowDown')
    await vi.waitFor(() => expect(document.activeElement?.getAttribute('data-evidence-id')).toBe('e2'))
    release()

    await vi.waitFor(() => expect(evidenceHead()).toContain('Order updated · Apply'))
    expect(evidenceIds()).toEqual(['e1', 'e2', 'e3'])
    expect(activeEvidenceId()).toBe('e2')
    click(button('Order updated · Apply'))
    await vi.waitFor(() => expect(evidenceIds()).toEqual(['e3', 'e1']))
    expect(evidenceHead()).not.toContain('Order updated')
  })

  it('stop cancels the evidence run and keeps the shown list', async () => {
    useLocal()
    mocks.evidenceGates.push(null)
    const release = gateEvidence()
    mocks.evidenceQueue.push(step({ hop: 0, evidence: [ev('e1', 0)] }), step({ hop: 1, evidence: [ev('e2', 1)] }))
    const input = await mountReady()
    await submit(input)
    await vi.waitFor(() => expect(evidenceHead()).toContain('Expanding the search (round 1) · 0 s'))
    expect(evidenceIds()).toEqual(['e1'])

    click(button('Stop'))
    await vi.waitFor(() => expect(calls('smart_lookup_cancel')).toEqual([{ lookupRunId: 'run-1' }]))
    release()
    await wait(20)
    expect(calls('smart_lookup_evidence_step')).toHaveLength(2)
    expect(evidenceIds()).toEqual(['e1'])
    expect(rowIds()).toEqual(LOCAL)
    expect(header()).toContain('Evidence search stopped')
  })

  it('a round-running answer is ignored: nothing applied, the run not finished', async () => {
    useLocal()
    mocks.evidenceQueue.push(
      step({ evidence: [ev('e1', 0)] }),
      // What the host currently sends for a concurrent step (Task 8 I3).
      step({ status: 'skipped', skipReason: 'roundRunning', done: true, requestCount: 0, evidence: [] }),
    )
    const input = await mountReady()
    await submit(input)
    await vi.waitFor(() => expect(header()).toContain('Find evidence'))
    expect(evidenceIds()).toEqual(['e1'])
    expect(evidenceHead()).not.toContain('No evidence found')
    expect(calls('smart_lookup_evidence_step')).toHaveLength(2)
  })

  it('generates an answer only when the user clicks', async () => {
    useLocal()
    mocks.storedSmartLookup = { enhance: { jev: { ...JEV }, chat: { ...CHAT, consentHost: 'chat.example' } } }
    const release = gateEvidence()
    mocks.evidenceQueue.push(step({ done: true, stop: 'maxHops', evidence: [ev('e1', 0), ev('e2', 1)] }))
    mocks.answers.push(answered({
      text: 'ANSWER_TEXT chaired by Alice [1].\n<b>bold</b> **star** [1, 2] [9] [2](http://x)',
      sources: [{ id: 1, evidenceId: 'e1' }, { id: 2, evidenceId: 'e2' }],
      omittedSources: 1,
    }))
    const input = await mountReady()
    await submit(input)
    // No button while the evidence is still being gathered.
    await vi.waitFor(() => expect(calls('smart_lookup_evidence_step')).toHaveLength(1))
    expect(document.querySelector('.answer-generate')).toBeNull()
    release()
    await vi.waitFor(() => expect(evidenceIds()).toEqual(['e1', 'e2']))
    await wait(20)
    expect(calls('smart_lookup_answer')).toHaveLength(0)

    click(button('Answer'))
    await vi.waitFor(() => expect(document.querySelector('.answer-text')).not.toBeNull())
    expect(calls('smart_lookup_answer')).toEqual([
      { lookupRunId: 'run-1', chat: { url: CHAT.url, model: CHAT.model, consentHost: 'chat.example' } },
    ])
    const text = document.querySelector<HTMLElement>('.answer-text')!
    // Plain text: no HTML or Markdown is rendered.
    expect(text.textContent).toBe('ANSWER_TEXT chaired by Alice [1].\n<b>bold</b> **star** [1, 2] [9] [2](http://x)')
    expect(text.querySelector('b, strong, em')).toBeNull()
    const links = [...text.querySelectorAll<HTMLAnchorElement>('a.citation')]
    expect(links.map((link) => [link.textContent, link.dataset.cite])).toEqual([['[1]', 'e1'], ['1', 'e1'], ['2', 'e2']])
    expect(evidenceHead() + document.querySelector('.evidence-answer')?.textContent).toContain('1 passage(s) over the budget were not sent')

    click(links[2])
    await vi.waitFor(() => expect(activeEvidenceId()).toBe('e2'))
    click(links[0])
    await vi.waitFor(() => expect(activeEvidenceId()).toBe('e1'))
    expect(calls('smart_lookup_answer')).toHaveLength(1)

    // The activity log has the status and counts, never the answer.
    await chooseMenuAction('Copy activity log')
    await vi.waitFor(() => expect(mocks.writeText).toHaveBeenCalledTimes(1))
    const log = String(mocks.writeText.mock.calls[0][0])
    const entry = log.split('\n').map((line) => JSON.parse(line)).find((e) => e.stage === 'answer')
    expect(entry).toMatchObject({ level: 'success', usage: { inputTokens: 300, outputTokens: 40 } })
    expect(entry.message).toContain('answer ok')
    expect(log).not.toContain('ANSWER_TEXT')
    expect(log).not.toContain('chat.example')
  })

  it('an answer without consent or with invalid citations shows no model text', async () => {
    useLocal()
    mocks.storedSmartLookup = { enhance: { jev: { ...JEV }, chat: { ...CHAT } } }
    mocks.evidenceQueue.push(step({ done: true, stop: 'maxHops', evidence: [ev('e1', 0)] }))
    mocks.answers.push(
      answered({ status: 'noConsent', requestCount: 0, usage: null }),
      answered({ status: 'invalidCitations', requestCount: 3, sources: [{ id: 1, evidenceId: 'e1' }] }),
    )
    const input = await mountReady()
    await submit(input)
    await vi.waitFor(() => expect(evidenceIds()).toEqual(['e1']))

    click(button('Answer'))
    await vi.waitFor(() => expect(document.querySelector('.evidence-answer')?.textContent).toContain('Sending to chat.example not allowed'))
    expect(calls('smart_lookup_answer')[0].chat).toEqual({ url: CHAT.url, model: CHAT.model, consentHost: '' })
    click(button('Settings'))
    await vi.waitFor(() => expect(mocks.emitTo).toHaveBeenCalledWith('main', 'settings://open-tab', { tab: 'enhance' }))

    click(button('Answer'))
    await vi.waitFor(() => expect(document.querySelector('.evidence-answer')?.textContent).toContain('The model cited source numbers that do not exist'))
    expect(document.querySelector('.answer-text')).toBeNull()
    expect(calls('smart_lookup_answer')).toHaveLength(2)
  })

  it('one fit item is evidence: no rephrase offer', async () => {
    useLocal()
    mocks.storedSmartLookup = { enhance: { jev: { ...JEV }, chat: { ...CHAT } } }
    mocks.evidenceQueue.push(step({ done: true, stop: 'maxHops', evidence: [ev('e1', 0, { tier: 'unfit' }), ev('e2', 1)] }))
    const input = await mountReady()
    await submit(input)
    await vi.waitFor(() => expect(evidenceIds()).toEqual(['e1', 'e2']))
    await wait(20)
    expect(evidenceHead()).not.toContain('No evidence found')
    expect(evidenceHead()).not.toContain('Rephrase')
  })

  it('the evidence title opens what the run sent, summed over its rounds', async () => {
    useLocal()
    mocks.evidenceQueue.push(
      step({ evidence: [ev('e1', 0)], requestCount: 2, elapsedMs: 300, sentBlocks: 10, estimatedTokens: 3000, skippedConfidential: 1, skippedLong: 2 }),
      step({ hop: 1, done: true, stop: 'maxHops', evidence: [ev('e1', 0)], requestCount: 1, elapsedMs: 200, sentBlocks: 4,
        estimatedTokens: 1000, skippedConfidential: 1, skippedStale: 1, skippedOversize: 1 }),
    )
    const input = await mountReady()
    await submit(input)
    await vi.waitFor(() => expect(calls('smart_lookup_evidence_step')).toHaveLength(2))
    await vi.waitFor(() => expect(evidenceHead()).not.toContain('Expanding'))

    click(document.querySelector<HTMLButtonElement>('.evidence-title')!)
    await vi.waitFor(() => expect(document.querySelector('.judge-details[role="dialog"]')).not.toBeNull())
    const details = document.querySelector('.judge-details')!
    expect(details.getAttribute('aria-label')).toBe('This evidence search')
    expect(details.textContent).toContain('Sent to api.typesafe.ai')
    expect(details.textContent).toContain('3 request(s) · 500 ms')
    expect(details.textContent).toContain('Sent 14 passages · about 4000 tokens')
    expect(details.textContent).toContain('Not sent: 2 confidential · 1 changed since indexing · 3 too long')
    // No reorder lines: the model never reorders the local results.
    expect(details.textContent).not.toContain('Reused')
    expect(details.textContent).not.toContain('of the first')

    key(input, 'Escape')
    await vi.waitFor(() => expect(document.querySelector('.judge-details')).toBeNull())
    expect(calls('hide_smart_search_window')).toHaveLength(0)
  })

  it('a URL without a host is not configured and sends nothing', async () => {
    useLocal()
    mocks.storedSmartLookup = { enhance: { jev: { url: 'not a url', model: 'm', authMode: 'bearer', consentHost: '' } } }
    const input = await mountReady()
    await submit(input)
    await vi.waitFor(() => expect(header()).toContain('No endpoint set up'))
    expect(calls('smart_lookup_evidence_step')).toHaveLength(0)
    expect(header()).not.toContain('Find evidence')
  })

  it('Esc twice during a round stops it, hides the window, drops the late round and offers a restart', async () => {
    useLocal()
    mocks.evidenceGates.push(null)
    const release = gateEvidence()
    mocks.evidenceQueue.push(step({ evidence: [ev('e1', 0)] }), step({ hop: 1, done: true, stop: 'maxHops', evidence: [ev('e2', 1)] }))
    const input = await mountReady()
    await submit(input)
    await vi.waitFor(() => expect(evidenceHead()).toContain('Expanding the search (round 1)'))
    key(input, 'Escape')
    key(document.body, 'Escape')
    await vi.waitFor(() => expect(calls('hide_smart_search_window')).toHaveLength(1))
    expect(calls('smart_lookup_cancel')).toEqual([{ lookupRunId: 'run-1' }])
    release()
    await wait(20)
    expect(evidenceIds()).toEqual(['e1'])
    expect(header()).toContain('Evidence search stopped')
    expect(header()).toContain('Find evidence')
    expect(calls('smart_lookup_evidence_step')).toHaveLength(2)
  })

  it('local rows judged by evidence rounds show their tier badge', async () => {
    useLocal()
    mocks.evidenceQueue.push(step({
      hop: 0, done: true, stop: 'maxHops', evidence: [ev('e1', 0, { localResultId: 'r1' })],
      localTiers: [{ resultId: 'r1', tier: 'fit' }, { resultId: 'r2', tier: 'unfit' }],
    }))
    const input = await mountReady()
    await submit(input)
    await vi.waitFor(() => expect(row('r1').textContent).toContain('Fits'))
    expect(row('r2').textContent).toContain('Possibly unrelated')
    expect(row('r2').classList.contains('dim')).toBe(true)
    expect(row('r3').querySelector('.result-badge')).toBeNull()
  })
})

// ---- enhancement: judging, repair, conditions, launch view, footer ----

const LOCAL = ['r1', 'r2', 'r3']

/** The local rows, in order. */
function rowIds(): Array<string | null> {
  return [...document.querySelectorAll('.result-list .result-row')].map((row) => row.getAttribute('data-result-id'))
}

function row(id: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`.result-list .result-row[data-result-id="${id}"]`)
  expect(element, `Row ${id}`).not.toBeNull()
  return element!
}

function activeRowId(): string | null | undefined {
  return document.querySelector('.result-row.active')?.getAttribute('data-result-id')
}

function evidenceIds(): Array<string | null> {
  return [...document.querySelectorAll('.evidence-list .result-row')].map((item) => item.getAttribute('data-evidence-id'))
}

function evidenceRow(id: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`.evidence-list .result-row[data-evidence-id="${id}"]`)
  expect(element, `Evidence ${id}`).not.toBeNull()
  return element!
}

function activeEvidenceId(): string | null | undefined {
  return document.querySelector('.result-row.active')?.getAttribute('data-evidence-id')
}

function evidenceHead(): string {
  return document.querySelector('.evidence-head')?.textContent ?? ''
}

function gateEvidence(): () => void {
  let release!: () => void
  mocks.evidenceGates.push(new Promise<void>((resolve) => { release = resolve }))
  return release
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

/** A button whose text starts with `label` (the rest is a shortcut hint). */
function buttonStarting(label: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
    .find((candidate) => candidate.textContent?.trim().startsWith(label))
  expect(found, `Button starting "${label}"`).toBeDefined()
  return found!
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
    .find((candidate) => candidate.querySelector('.recent-question')?.textContent?.trim() === label)
  expect(item, `Recent ${label}`).toBeDefined()
  return item!
}

function useLocal(ids: string[] = LOCAL, question = 'release risk'): void {
  mocks.localByQuestion[question] = ids.map((id) => rh(id))
}

describe('SmartLookupApp enhancement', () => {
  it('scrolling the result list counts as moving', async () => {
    useLocal()
    mocks.evidenceGates.push(null)
    const release = gateEvidence()
    mocks.evidenceQueue.push(step({ evidence: [ev('e1', 0)] }), step({ hop: 1, done: true, stop: 'maxHops', evidence: [ev('e2', 1), ev('e1', 0)] }))
    const input = await mountReady()
    await submit(input)
    await vi.waitFor(() => expect(evidenceIds()).toEqual(['e1']))
    document.querySelector('.results-scroll')!.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 40 }))
    release()
    await vi.waitFor(() => expect(evidenceHead()).toContain('Order updated · Apply'))
    expect(evidenceIds()).toEqual(['e1', 'e2'])
  })
  it('a round that keeps the shown order offers nothing to apply after interaction', async () => {
    useLocal()
    mocks.evidenceGates.push(null)
    const release = gateEvidence()
    mocks.evidenceQueue.push(step({ evidence: [ev('e1', 0)] }), step({ hop: 1, done: true, stop: 'maxHops', evidence: [ev('e1', 0), ev('e2', 1)] }))
    const input = await mountReady()
    await submit(input)
    await vi.waitFor(() => expect(evidenceIds()).toEqual(['e1']))
    key(input, 'ArrowDown')
    await vi.waitFor(() => expect(activeEvidenceId()).toBe('e1'))
    release()
    await vi.waitFor(() => expect(evidenceIds()).toEqual(['e1', 'e2']))
    await wait(20)
    expect(evidenceHead()).not.toContain('Order updated')
  })
  it('restores an earlier round without a request', async () => {
    useLocal()
    mocks.evidenceQueue.push(
      step({ evidence: [ev('e1', 0)] }),
      step({ hop: 1, done: true, stop: 'maxHops', evidence: [ev('e2', 1), ev('e1', 0)] }),
    )
    const input = await mountReady()
    await submit(input)
    await vi.waitFor(() => expect(evidenceIds()).toEqual(['e2', 'e1']))
    // The round shown has no restore button; the earlier one does.
    expect(Array.from(document.querySelectorAll('.evidence-restore button')).map((item) => item.textContent?.trim())).toEqual(['Back to local'])
    click(button('Back to local'))
    await vi.waitFor(() => expect(evidenceIds()).toEqual(['e1']))
    expect(calls('smart_lookup_evidence_step')).toHaveLength(2)
    click(button('Back to round 1'))
    await vi.waitFor(() => expect(evidenceIds()).toEqual(['e2', 'e1']))
  })
  it('a key error shows only host and status class', async () => {
    useLocal()
    mocks.evidenceQueue.push(step({ status: 'keyInvalid', endpointHost: 'api.typesafe.ai', statusClass: '4xx', done: true }))
    const input = await mountReady()
    await submit(input)
    await vi.waitFor(() => expect(header()).toContain('api.typesafe.ai rejected the key (4xx)'))
    expect(rowIds()).toEqual(['r1', 'r2', 'r3'])
    expect(document.querySelector('.result-badge')).toBeNull()
    expect(document.querySelector('.evidence')).toBeNull()
  })
  it('a timeout keeps what is shown and retries as a user action', async () => {
    useLocal()
    mocks.evidenceQueue.push(
      step({ evidence: [ev('e1', 0)] }),
      step({ hop: 1, status: 'timeout', done: true, evidence: [ev('e1', 0)] }),
      step({ hop: 1, done: true, stop: 'maxHops', evidence: [ev('e2', 1), ev('e1', 0)] }),
    )
    const input = await mountReady()
    await submit(input)
    await vi.waitFor(() => expect(header()).toContain('Judging timed out; local order kept'))
    expect(rowIds()).toEqual(LOCAL)
    expect(evidenceIds()).toEqual(['e1'])
    click(button('Try again'))
    await vi.waitFor(() => expect(evidenceIds()).toEqual(['e2', 'e1']))
    expect(calls('smart_lookup_evidence_step').map((call) => [call.lookupRunId, call.trigger])).toEqual([
      ['run-1', 'auto'], ['run-1', 'auto'], ['run-1', 'user'],
    ])
  })
  it('a busy index says so without an action', async () => {
    useLocal()
    mocks.evidenceQueue.push(step({ status: 'skipped', skipReason: 'indexUnavailable', endpointHost: null, requestCount: 0, done: true }))
    const input = await mountReady()
    await submit(input)
    await vi.waitFor(() => expect(header()).toContain('Index busy — no evidence searched'))
    expect(document.querySelectorAll('.judge-header button')).toHaveLength(0)
  })

  it('a route the host skips offers to find evidence as a user action', async () => {
    useLocal()
    mocks.evidenceQueue.push(
      step({ status: 'skipped', skipReason: 'fewTerms', endpointHost: null, requestCount: 0, done: true }),
      step({ done: true, stop: 'maxHops', evidence: [ev('e1', 0)] }),
    )
    const input = await mountReady()
    await submit(input)
    await vi.waitFor(() => expect(header()).toContain('Find evidence'))
    click(button('Find evidence'))
    await vi.waitFor(() => expect(evidenceIds()).toEqual(['e1']))
    expect(calls('smart_lookup_evidence_step').map((call) => call.trigger)).toEqual(['auto', 'user'])
    expect(header()).not.toContain('Find evidence')
  })
  it('no consent offers allow for the current host only', async () => {
    useLocal()
    mocks.storedSmartLookup = {
      enhance: { jev: { url: 'https://openrouter.ai/api/alpha/decisions', model: 'm', authMode: 'bearer', consentHost: '' } },
    }
    const input = await mountReady()
    await submit(input)
    await vi.waitFor(() => expect(header()).toContain('Sending to openrouter.ai not allowed'))
    // Nothing starts on its own without consent.
    expect(calls('smart_lookup_evidence_step')).toHaveLength(0)

    click(button('Allow'))
    await vi.waitFor(() => expect(calls('smart_lookup_evidence_step')).toHaveLength(1))
    expect(settings.smartLookup.enhance.jev.consentHost).toBe('openrouter.ai')
    expect(calls('smart_lookup_evidence_step')[0]).toMatchObject({ trigger: 'user', lookupRunId: 'run-1', jev: { consentHost: 'openrouter.ai' } })
    await vi.waitFor(() => expect((mocks.storedSmartLookup as any).enhance.jev.consentHost).toBe('openrouter.ai'))
  })
  it('an endpoint that is not set up sends nothing and opens the settings tab', async () => {
    useLocal()
    mocks.storedSmartLookup = {}
    const input = await mountReady()
    await submit(input)
    await vi.waitFor(() => expect(header()).toContain('No endpoint set up'))
    expect(calls('smart_lookup_evidence_step')).toHaveLength(0)
    click(button('Settings'))
    await vi.waitFor(() => expect(mocks.emitTo).toHaveBeenCalledWith('main', 'settings://open-tab', { tab: 'enhance' }))
  })

  it('a late round for a superseded lookup is ignored', async () => {
    useLocal()
    useLocal(['r7', 'r8'], 'other question')
    const release = gateEvidence()
    mocks.evidenceQueue.push(step({ done: true, stop: 'maxHops', evidence: [ev('e1', 0)] }))
    const input = await mountReady()
    await submit(input)
    await vi.waitFor(() => expect(calls('smart_lookup_evidence_step')).toHaveLength(1))

    await submit(input, 'other question', 2)
    release()
    await wait(20)
    await tick()

    expect(calls('smart_lookup_cancel')[0]).toEqual({ lookupRunId: 'run-1' })
    expect(rowIds()).toEqual(['r7', 'r8'])
    expect(evidenceIds()).toEqual([])
    expect(calls('smart_lookup_evidence_step').map((call) => call.lookupRunId)).toEqual(['run-1', 'run-2'])
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
    expect(calls('smart_lookup_evidence_step')).toHaveLength(0)
    expect(document.querySelectorAll('s')).toHaveLength(1)
    expect(document.querySelector('s')?.textContent).toBe('火星')
    expect(row('r9').textContent).toContain('Wording B')
    const inputs = [...document.querySelectorAll<HTMLInputElement>('.repair-strip input')]
    expect(inputs.map((field) => field.value)).toEqual(['预算 计划', '航天 "火星 计划"'])
    expect(document.querySelector('.repair-strip')?.textContent).toContain('Wording B · 1')

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
    expect(calls('smart_lookup_evidence_step')).toHaveLength(0)
  })

  it('zero hits without a repair model show the three attempts', async () => {
    mocks.local = 'empty'
    const input = await mountReady()
    await submit(input, 'release risk', 0)
    await vi.waitFor(() => expect(noMatchPanel()).toContain('Searched the original question locally'))
    expect(noMatchPanel()).toMatch(/Searched the original question locally\s*0 · 2 ms/)
    expect(noMatchPanel()).toMatch(/Searched again with other wordings\s*Not run/)
    expect(noMatchPanel()).toMatch(/Scanned every file line by line\s*Not run/)
    await wait(20)
    expect(calls('smart_lookup_repair_suggest')).toHaveLength(0)
    expect(calls('smart_lookup_evidence_step')).toHaveLength(0)
  })

  it('the no-match panel edits the wording with the extracted terms', async () => {
    mocks.local = 'empty'
    const input = await mountReady()
    await submit(input, 'release risk', 0)
    await vi.waitFor(() => expect(noMatchPanel()).toContain('Searched the original question locally'))
    click(buttonStarting('Edit wordings A / B and search again'))
    await vi.waitFor(() => expect(document.querySelector('.repair-strip')).not.toBeNull())
    const fields = [...document.querySelectorAll<HTMLInputElement>('.repair-strip input')]
    expect(fields.map((field) => field.value)).toEqual(['release risk', ''])

    input.setSelectionRange(3, 3)
    click(buttonStarting('Rewrite the question with words you remember'))
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(input)
      expect(input.selectionStart).toBe(0)
      expect(input.selectionEnd).toBe('release risk'.length)
    })
  })

  it('evidence that is all unfit offers rephrase as a user action', async () => {
    useLocal()
    mocks.storedSmartLookup = { enhance: { jev: { ...JEV }, chat: { ...CHAT } } }
    mocks.evidenceQueue.push(step({ done: true, stop: 'maxHops', evidence: ['e1', 'e2', 'e3'].map((id) => ev(id, 0, { tier: 'unfit' })), localTiers: LOCAL.map((resultId) => ({ resultId, tier: 'unfit' as const })) }))
    mocks.repair = {
      status: 'ok', skipReason: null, missing: null, endpointHost: 'chat.example', statusClass: null,
      groups: [{ terms: ['发布'], phrases: [] }], requestCount: 1, elapsedMs: 600, usage: null,
    }
    mocks.groups = { search: response([rh('r9')]), lookupRunId: 'run-2', time: null, groupCounts: [1], hitGroups: [[1]] }
    const input = await mountReady()
    await submit(input)
    await vi.waitFor(() => expect(evidenceHead()).toContain('No evidence found'))
    // The host keeps its top K whatever the score: every shown item is unfit, so nothing was found.
    expect(evidenceIds()).toEqual(['e1', 'e2', 'e3'])
    expect(evidenceRow('e1').textContent).toContain('Possibly unrelated')
    expect(row('r1').textContent).toContain('Possibly unrelated')

    click(button('Rephrase'))
    await vi.waitFor(() => expect(calls('smart_lookup_repair_suggest')).toHaveLength(1))
    expect(calls('smart_lookup_repair_suggest')[0]).toMatchObject({ trigger: 'user', lookupRunId: 'run-1' })
    await vi.waitFor(() => expect(rowIds()).toEqual(['r9']))
    // Regrouped results get no evidence.
    expect(calls('smart_lookup_evidence_step')).toHaveLength(1)
    expect(document.querySelector('.evidence')).toBeNull()
  })
  it('Tab leaves the question field when the repair strip shows over results', async () => {
    useLocal()
    mocks.storedSmartLookup = { enhance: { jev: { ...JEV }, chat: { ...CHAT } } }
    mocks.evidenceQueue.push(step({ done: true, stop: 'maxHops', evidence: ['e1', 'e2', 'e3'].map((id) => ev(id, 0, { tier: 'unfit' })), localTiers: LOCAL.map((resultId) => ({ resultId, tier: 'unfit' as const })) }))
    mocks.repair = {
      status: 'ok', skipReason: null, missing: null, endpointHost: 'chat.example', statusClass: null,
      groups: [{ terms: ['发布'], phrases: [] }], requestCount: 1, elapsedMs: 600, usage: null,
    }
    mocks.groups = { search: response([rh('r9')]), lookupRunId: 'run-2', time: null, groupCounts: [1], hitGroups: [[1]] }
    const input = await mountReady()
    await submit(input)
    await vi.waitFor(() => expect(evidenceHead()).toContain('No evidence found'))
    click(button('Rephrase'))
    await vi.waitFor(() => expect(rowIds()).toEqual(['r9']))
    expect(document.querySelector('.repair-strip')).not.toBeNull()

    input.focus()
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    input.dispatchEvent(tab)
    expect(tab.defaultPrevented).toBe(false)
  })

  it.each([
    ['notConfigured', { missing: 'key', endpointHost: null }, 'No key saved'],
    ['timeout', {}, 'Rephrasing timed out; results unchanged'],
    ['invalid', {}, 'chat.example sent no usable wording; results unchanged'],
  ])('a failed rephrase after no evidence says so (%s)', async (status, extra, notice) => {
    useLocal()
    mocks.storedSmartLookup = { enhance: { jev: { ...JEV }, chat: { ...CHAT } } }
    mocks.evidenceQueue.push(step({ done: true, stop: 'maxHops', evidence: ['e1', 'e2', 'e3'].map((id) => ev(id, 0, { tier: 'unfit' })), localTiers: LOCAL.map((resultId) => ({ resultId, tier: 'unfit' as const })) }))
    mocks.repair = {
      status, skipReason: null, missing: null, endpointHost: 'chat.example', statusClass: null,
      groups: [], requestCount: status === 'notConfigured' ? 0 : 1, elapsedMs: 600, usage: null, ...extra,
    }
    const input = await mountReady()
    await submit(input)
    await vi.waitFor(() => expect(evidenceHead()).toContain('No evidence found'))

    click(button('Rephrase'))
    await vi.waitFor(() => expect(calls('smart_lookup_repair_suggest')).toHaveLength(1))
    await vi.waitFor(() => expect(document.querySelector('.repair-notice')?.textContent).toContain(notice))
    // The evidence state stays, and so do the results.
    expect(evidenceHead()).toContain('No evidence found')
    expect(rowIds()).toEqual(LOCAL)

    // The next lookup clears it.
    await submit(input, 'release risk again', 3)
    await vi.waitFor(() => expect(document.querySelector('.repair-notice')).toBeNull())
  })

  it('correcting an evidence row writes local feedback with its evidence id', async () => {
    useLocal()
    mocks.evidenceQueue.push(step({ done: true, stop: 'maxHops', evidence: [ev('e1', 0)] }))
    const input = await mountReady()
    await submit(input)
    await vi.waitFor(() => expect(activeEvidenceId()).toBe('e1'))
    expect(document.querySelector('.preview-pane')?.textContent).toContain('Is this judgement right?')
    expect(document.querySelector('.preview-pane')?.textContent).toContain('LOCAL_PASSAGE_e1')

    click(button('Unrelated'))
    await vi.waitFor(() => expect(calls('smart_lookup_feedback')).toHaveLength(1))
    expect(calls('smart_lookup_feedback')[0]).toEqual({ lookupRunId: 'run-1', resultId: 'e1', verdict: 'unfit' })
    await vi.waitFor(() => expect(document.body.textContent).toContain('Recorded on this device only'))
  })

  it('opens an evidence row in the editor like a local hit', async () => {
    useLocal()
    mocks.evidenceQueue.push(step({ done: true, stop: 'maxHops', evidence: [ev('e1', 0)] }))
    const input = await mountReady()
    await submit(input)
    await vi.waitFor(() => expect(evidenceIds()).toEqual(['e1']))
    key(input, 'ArrowDown')
    await vi.waitFor(() => expect(document.activeElement?.getAttribute('data-evidence-id')).toBe('e1'))
    key(document.activeElement!, 'ArrowDown')
    await vi.waitFor(() => expect(document.activeElement?.getAttribute('data-result-id')).toBe('r1'))
    key(document.activeElement!, 'ArrowUp')
    await vi.waitFor(() => expect(document.activeElement?.getAttribute('data-evidence-id')).toBe('e1'))
    key(document.activeElement!, 'Enter')
    await vi.waitFor(() => expect(calls('editor_show_and_reveal_search_hit')).toHaveLength(1))
    expect(calls('editor_show_and_reveal_search_hit')[0]).toMatchObject({ path: '/vault/notes/e1.md', line: 3 })
  })
  it('the time chip re-searches locally without judging', async () => {
    useLocal()
    mocks.localTime = { sourceText: '上周', after: '2026-11-02', before: '2026-11-09', mode: 'group', inWindow: 1 }
    const input = await mountReady()
    await submit(input)
    await vi.waitFor(() => expect(calls('smart_lookup_evidence_step')).toHaveLength(1))
    expect(calls('smart_lookup_local')[0].timeMode).toBeUndefined()
    const groups = [...document.querySelectorAll('[role="listbox"] [role="group"]')].map((group) => group.getAttribute('aria-label'))
    expect(groups).toEqual(['In range', 'Other dates'])
    expect(timeChip().textContent).toContain('Time: 上周')
    expect(document.querySelector('.criterion-chip')?.textContent).toContain("Criterion: directly matches what you're looking for")

    await choose(timeChip(), 'Only in range')
    await vi.waitFor(() => expect(calls('smart_lookup_local')).toHaveLength(2))
    expect(calls('smart_lookup_local').at(-1)).toMatchObject({ question: 'release risk', timeMode: 'window', deep: false })
    await wait(20)
    expect(calls('smart_lookup_evidence_step')).toHaveLength(1)
    expect(calls('smart_lookup_repair_suggest')).toHaveLength(0)

    // A new question drops the chosen time mode.
    await submit(input, 'release risk again', 3)
    expect(calls('smart_lookup_local').at(-1).timeMode).toBeUndefined()
  })

  it('the launch view shows recent lookups and the first-run note once', async () => {
    localStorage.setItem('notemd.smartLookup.recent', JSON.stringify(['release risk', 'budget']))
    mocks.storedSmartLookup = { enhance: { jev: { ...JEV } }, launch: { firstRunSeen: false } }
    await mountReady()
    await vi.waitFor(() => expect(document.body.textContent).toContain('What happens after Return'))

    click(button('Got it'))

    await vi.waitFor(() => expect(settings.smartLookup.launch.firstRunSeen).toBe(true))
    await vi.waitFor(() => expect(document.body.textContent).not.toContain('What happens after Return'))
    await vi.waitFor(() => expect((mocks.storedSmartLookup as any).launch.firstRunSeen).toBe(true))

    click(recentItem('release risk'))
    await vi.waitFor(() => expect(calls('smart_lookup_local')).toHaveLength(1))
    expect(calls('smart_lookup_local').at(-1)).toMatchObject({ question: 'release risk' })
  })

  it('clearing recent lookups empties the launch list', async () => {
    localStorage.setItem('notemd.smartLookup.recent', JSON.stringify(['release risk']))
    await mountReady()
    await vi.waitFor(() => expect(document.querySelectorAll('.recent-item')).toHaveLength(1))
    expect(document.body.textContent).not.toContain('What happens after Return')
    click(button('Clear'))
    await vi.waitFor(() => expect(document.querySelectorAll('.recent-item')).toHaveLength(0))
    expect(localStorage.getItem('notemd.smartLookup.recent')).toBeNull()
  })

  it('with enhancement off Enter gathers no evidence', async () => {
    useLocal()
    mocks.storedSmartLookup = { enhance: { enabled: false, jev: { ...JEV } } }
    const input = await mountReady()
    await submit(input)
    await wait(20)
    expect(calls('smart_lookup_evidence_step')).toHaveLength(0)
    expect(calls('smart_lookup_judge')).toHaveLength(0)
    expect(header()).toBe('')
    expect(document.querySelector('.evidence')).toBeNull()
    expect(document.querySelector('.criterion-chip')).toBeNull()
  })
  it('the footer shows only the actions shortcut and it opens the menu', async () => {
    useLocal()
    mocks.evidenceQueue.push(step({ done: true, stop: 'maxHops', evidence: [ev('e1', 0)] }))
    const input = await mountReady()
    expect(footer()).toBe('⌘K Actions')
    await submit(input)
    await vi.waitFor(() => expect(evidenceIds()).toEqual(['e1']))
    key(window, 'k', { metaKey: true })
    await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).toBeTruthy())
    const rows = [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent?.trim())
    expect(rows).toEqual(['Copy reference', 'Copy activity log'])
    expect(document.body.textContent).not.toContain('简答')
    expect(document.body.textContent).not.toContain('深入研究')
  })

  it('the activity log records each evidence round with usage but no remote or note text', async () => {
    useLocal()
    mocks.evidenceQueue.push(step({
      done: true, stop: 'maxHops', evidence: [ev('e1', 0)],
      terms: [{ term: 'secret term', label: 'Secret Term', kind: 'namePhrase' }],
    }))
    const input = await mountReady()
    await submit(input)
    await vi.waitFor(() => expect(evidenceIds()).toEqual(['e1']))
    await chooseMenuAction('Copy activity log')
    await vi.waitFor(() => expect(mocks.writeText).toHaveBeenCalledTimes(1))
    const log = String(mocks.writeText.mock.calls[0][0])
    const round = log.split('\n').map((line) => JSON.parse(line)).find((entry) => entry.stage === 'judge')
    expect(round).toMatchObject({ level: 'success', usage: { inputTokens: 900, outputTokens: 12 } })
    expect(typeof round.elapsedMs).toBe('number')
    expect(round.message).toContain('evidence ok')
    expect(round.message).toContain('requests 1')
    expect(log).not.toContain('api.typesafe.ai')
    expect(log).not.toContain('LOCAL_PASSAGE')
    expect(log).not.toContain('Secret Term')
  })
  it('Esc while a round runs stops the evidence and keeps the window; the next Esc hides it', async () => {
    useLocal()
    const release = gateEvidence()
    const input = await mountReady()
    await submit(input)
    await vi.waitFor(() => expect(evidenceHead()).toContain('Searching the notes · 0 s'))
    expect(footer().replace(/\s+/g, ' ')).toBe('esc Stop the evidence search ⌘K Actions')

    key(input, 'Escape')
    await vi.waitFor(() => expect(header()).toContain('Evidence search stopped'))
    expect(calls('smart_lookup_cancel')).toEqual([{ lookupRunId: 'run-1' }])
    expect(calls('hide_smart_search_window')).toHaveLength(0)
    expect(footer()).toBe('⌘K Actions')
    release()
    await wait(20)
    expect(rowIds()).toEqual(LOCAL)
    expect(calls('smart_lookup_evidence_step')).toHaveLength(1)

    key(document.body, 'Escape')
    await vi.waitFor(() => expect(calls('hide_smart_search_window')).toHaveLength(1))
    expect(calls('smart_lookup_cancel')).toHaveLength(1)
  })

  it('after a stop, finding evidence again continues as a user action', async () => {
    useLocal()
    mocks.evidenceGates.push(null)
    const release = gateEvidence()
    mocks.evidenceQueue.push(
      step({ evidence: [ev('e1', 0)] }),
      step({ hop: 1, status: 'cancelled', done: true, evidence: [ev('e1', 0)] }),
      step({ hop: 1, done: true, stop: 'maxHops', evidence: [ev('e2', 1), ev('e1', 0)] }),
    )
    const input = await mountReady()
    await submit(input)
    await vi.waitFor(() => expect(evidenceHead()).toContain('Expanding the search (round 1)'))
    click(button('Stop'))
    release()
    await vi.waitFor(() => expect(header()).toContain('Find evidence'))
    click(button('Find evidence'))
    await vi.waitFor(() => expect(evidenceIds()).toEqual(['e2', 'e1']))
    expect(calls('smart_lookup_evidence_step').map((call) => call.trigger)).toEqual(['auto', 'auto', 'user'])
  })
  it('hiding the window by its own command still cancels an in-flight repair', async () => {
    mocks.local = 'empty'
    mocks.storedSmartLookup = { enhance: { jev: { ...JEV }, chat: { ...CHAT } } }
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

  // ---- fix round 1: design states ----

  it('key and connection errors offer to open the enhancement settings', async () => {
    for (const status of ['keyInvalid', 'unreachable'] as const) {
      useLocal()
      mocks.evidenceQueue.push(step({ status, endpointHost: 'api.typesafe.ai', statusClass: status === 'keyInvalid' ? '4xx' : '5xx', done: true }))
      mocks.emitTo.mockClear()
      const input = await mountReady()
      await submit(input)
      await vi.waitFor(() => expect(header()).toContain('api.typesafe.ai'))
      click(button('Open settings'))
      await vi.waitFor(() => expect(mocks.emitTo).toHaveBeenCalledWith('main', 'settings://open-tab', { tab: 'enhance' }))
      await unmount(component!)
      component = null
      document.body.innerHTML = ''
    }
  })

  it('⌘R applies an updated evidence order', async () => {
    useLocal()
    mocks.evidenceGates.push(null)
    const release = gateEvidence()
    mocks.evidenceQueue.push(step({ evidence: [ev('e1', 0)] }), step({ hop: 1, done: true, stop: 'maxHops', evidence: [ev('e2', 1), ev('e1', 0)] }))
    const input = await mountReady()
    await submit(input)
    await vi.waitFor(() => expect(evidenceIds()).toEqual(['e1']))
    key(input, 'ArrowDown')
    await vi.waitFor(() => expect(document.activeElement?.getAttribute('data-evidence-id')).toBe('e1'))
    release()
    await vi.waitFor(() => expect(evidenceHead()).toContain('Order updated · Apply'))
    expect(evidenceHead()).toContain('⌘R')
    key(document.activeElement!, 'r', { metaKey: true })
    await vi.waitFor(() => expect(evidenceIds()).toEqual(['e2', 'e1']))
    expect(activeEvidenceId()).toBe('e1')
  })
  it('a repair that returns no wording shows the invalid state', async () => {
    mocks.local = 'empty'
    mocks.storedSmartLookup = { enhance: { jev: { ...JEV }, chat: { ...CHAT } } }
    mocks.keys = { jev: true, chat: true }
    mocks.repair = {
      status: 'ok', skipReason: null, missing: null, endpointHost: 'chat.example', statusClass: null,
      groups: [], requestCount: 1, elapsedMs: 300, usage: null,
    }
    const input = await mountReady()
    await submit(input, 'release risk', 0)
    await vi.waitFor(() => expect(document.querySelector('.repair-notice')?.textContent).toContain('chat.example sent no usable wording; results unchanged'))
    expect(calls('smart_lookup_search_groups')).toHaveLength(0)
    expect(noMatchPanel()).toContain('1 model request(s) this time')
  })

  it('a failed settings save is logged without any error text', async () => {
    useLocal()
    mocks.storedSmartLookup = {
      enhance: { jev: { url: 'https://openrouter.ai/api/alpha/decisions', model: 'm', authMode: 'bearer', consentHost: '' } },
    }
    const input = await mountReady()
    await submit(input)
    await vi.waitFor(() => expect(header()).toContain('Sending to openrouter.ai not allowed'))
    mocks.saveError = true
    click(button('Allow'))
    await vi.waitFor(() => expect(calls('smart_lookup_evidence_step')).toHaveLength(1))
    expect(settings.smartLookup.enhance.jev.consentHost).toBe('openrouter.ai')
    mocks.saveError = false
    await chooseMenuAction('Copy activity log')
    await vi.waitFor(() => expect(mocks.writeText).toHaveBeenCalledTimes(1))
    const log = String(mocks.writeText.mock.calls[0][0])
    const entry = log.split('\n').map((line) => JSON.parse(line)).find((item) => item.stage === 'settings')
    expect(entry).toMatchObject({ level: 'error', message: "Settings weren't saved; they apply to this window only" })
    expect(log).not.toContain('disk full')
    expect(log).not.toContain('/Users/me')
  })

  it('the repair strip summarises the repair, shows the local diagnosis and can go back to the original question', async () => {
    useLocal()
    mocks.storedSmartLookup = { enhance: { jev: { ...JEV }, chat: { ...CHAT } } }
    mocks.evidenceQueue.push(step({ done: true, stop: 'maxHops', evidence: ['e1', 'e2', 'e3'].map((id) => ev(id, 0, { tier: 'unfit' })), localTiers: LOCAL.map((resultId) => ({ resultId, tier: 'unfit' as const })) }))
    mocks.repair = {
      status: 'ok', skipReason: null, missing: null, endpointHost: 'chat.example', statusClass: null,
      groups: [{ terms: ['发布'], phrases: [] }, { terms: ['上架'], phrases: [] }], requestCount: 1, elapsedMs: 800, usage: null,
    }
    mocks.groups = {
      search: response([rh('r8'), rh('r9')]), lookupRunId: 'run-2', time: null, groupCounts: [2, 1], hitGroups: [[1, 2], [1]],
    }
    const input = await mountReady()
    await submit(input)
    await vi.waitFor(() => expect(evidenceHead()).toContain('No evidence found'))
    click(button('Rephrase'))
    await vi.waitFor(() => expect(rowIds()).toEqual(['r8', 'r9']))

    const strip = document.querySelector('.repair-strip')!.textContent!
    expect(strip).toContain('Original question: 3 locally · 7 ms')
    expect(strip).toContain('Two other wordings found 2 locally')
    expect(strip).toContain('Search words from the repair model · only the question was sent · 800 ms')
    expect(strip).toContain('Wording A · 2')
    expect(strip).toContain('Wording B · 1')
    expect(row('r8').textContent).toContain('A + B')
    expect(row('r9').textContent).toContain('Wording A')

    click(button('Original question only'))
    await vi.waitFor(() => expect(rowIds()).toEqual(LOCAL))
    expect(evidenceHead()).toContain('No evidence found')
    expect(row('r1').textContent).toContain('Possibly unrelated')
    expect(document.querySelector('.repair-strip')).toBeNull()
    expect(calls('smart_lookup_evidence_step')).toHaveLength(1)
    expect(calls('smart_lookup_local')).toHaveLength(1)
  })

  it('the repair strip shows the struck terms with the no-model note', async () => {
    mocks.local = 'empty'
    mocks.storedSmartLookup = { enhance: { jev: { ...JEV }, chat: { ...CHAT } } }
    mocks.keys = { jev: true, chat: true }
    mocks.diagnosis = { terms: [{ term: '老王', hits: 0, capped: false }, { term: '苹果', hits: 0, capped: false }] }
    mocks.repair = {
      status: 'ok', skipReason: null, missing: null, endpointHost: 'chat.example', statusClass: null,
      groups: [{ terms: ['上架'], phrases: [] }], requestCount: 1, elapsedMs: 800, usage: null,
    }
    mocks.groups = { search: response([rh('r9')]), lookupRunId: 'run-2', time: null, groupCounts: [1], hitGroups: [[1]] }
    const input = await mountReady()
    await submit(input, 'release risk', 1)
    await vi.waitFor(() => expect(rowIds()).toEqual(['r9']))
    const diagnosisRow = document.querySelector('.repair-strip .diagnosis')!
    expect([...diagnosisRow.querySelectorAll('s')].map((term) => term.textContent)).toEqual(['老王', '苹果'])
    expect(diagnosisRow.textContent).toContain('Local check')
    expect(diagnosisRow.textContent).toContain('No model used')
    expect(document.querySelector('.repair-strip')!.textContent).toContain('Another wording found 1 locally')

    // The zero-hit original is one click away too.
    click(button('Original question only'))
    await vi.waitFor(() => expect(noMatchPanel()).toContain("Your notes probably don't contain this"))
  })

  it('the no-match panel lists what ran, in order, with the wordings and the model calls', async () => {
    mocks.local = 'empty'
    mocks.storedSmartLookup = { results: { autoDeepOnZero: true }, enhance: { jev: { ...JEV }, chat: { ...CHAT } } }
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
      groups: [{ terms: ['供应商', '折扣'], phrases: [] }, { terms: ['采购合同'], phrases: ['价格 条款'] }],
      requestCount: 1, elapsedMs: 700, usage: null,
    }
    mocks.groups = { search: { ...response([]), tookMs: 40 }, lookupRunId: 'run-3', time: null, groupCounts: [0, 0], hitGroups: [] }
    const input = await mountReady()
    await submit(input, 'release risk', 0)
    await vi.waitFor(() => expect(calls('smart_lookup_search_groups')).toHaveLength(1))
    await vi.waitFor(() => expect(noMatchPanel()).toContain('Searched again with other wordings'))

    const panel = document.querySelector('.no-match')!
    expect(panel.querySelector('h2')?.textContent).toBe("Your notes probably don't contain this")
    expect(panel.textContent).toContain('All three steps below were tried; no passage matched.')
    const rows = [...panel.querySelectorAll('.attempt')].map((item) => item.querySelector('strong')?.textContent)
    expect(rows).toEqual([
      'Searched the original question locally',
      'Scanned every file line by line',
      'Searched again with other wordings',
    ])
    expect(panel.textContent).toMatch(/Scanned every file line by line\s*0 · 1\.9 s/)
    expect(panel.textContent).toMatch(/Searched again with other wordings\s*0 · 40 ms/)
    const wordings = [...panel.querySelectorAll('.group-line')].map((line) => ({
      label: line.querySelector('.glabel')?.textContent,
      terms: [...line.querySelectorAll('.term')].map((term) => term.textContent),
    }))
    expect(wordings).toEqual([
      { label: 'Wording A', terms: ['供应商', '折扣'] },
      { label: 'Wording B', terms: ['采购合同', '"价格 条款"'] },
    ])
    expect(panel.textContent).toContain('1 model request(s) this time')
    expect(panel.textContent).toContain('Only the question was sent to the repair model')
    expect(buttonStarting('Rewrite the question').textContent).toContain('⌘L')
    expect(buttonStarting('Edit wordings A / B').textContent).toContain('⇥')
  })

  it('⌘L rewrites the question and ⇥ edits the wordings from the no-match panel', async () => {
    mocks.local = 'empty'
    const input = await mountReady()
    await submit(input, 'release risk', 0)
    await vi.waitFor(() => expect(noMatchPanel()).toContain('0 model request(s) this time'))
    expect(noMatchPanel()).toContain('Nothing was sent.')
    expect(noMatchPanel()).toContain('The steps below were tried; no passage matched.')

    key(input, 'Tab')
    await vi.waitFor(() => expect(document.activeElement).toBe(document.querySelector('.repair-strip input')))
    expect((document.activeElement as HTMLInputElement).value).toBe('release risk')

    input.setSelectionRange(2, 2)
    key(document.activeElement!, 'l', { metaKey: true })
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(input)
      expect(input.selectionEnd).toBe('release risk'.length)
      expect(input.selectionStart).toBe(0)
    })
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
    await vi.waitFor(() => expect(rowIds()).toEqual(['r7']))
    expect(JSON.parse(localStorage.getItem('notemd.smartLookup.recentCounts')!)).toMatchObject({ budget: 1 })
  })

  it('the first-run card shows three steps and closes with ×', async () => {
    mocks.storedSmartLookup = { enhance: { jev: { ...JEV } }, launch: { firstRunSeen: false } }
    await mountReady()
    await vi.waitFor(() => expect(document.querySelector('.first-run')).not.toBeNull())
    const card = document.querySelector('.first-run')!
    expect(card.querySelectorAll('.steps li')).toHaveLength(3)
    expect(card.textContent).toContain('Shown only the first time')
    expect(card.textContent).toContain('Local search')
    expect(card.textContent).toContain("directly match what you're looking for")
    expect(card.textContent).toContain('You can correct a wrong judgement; corrections stay on this device.')
    click(card.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!)
    await vi.waitFor(() => expect(document.querySelector('.first-run')).toBeNull())
    await vi.waitFor(() => expect((mocks.storedSmartLookup as any).launch.firstRunSeen).toBe(true))
  })

  it('the time chip shows the range and mode, and × ignores the time with a local re-search', async () => {
    useLocal()
    mocks.localTime = { sourceText: '上个月', after: '2026-10-01', before: '2026-10-31', mode: 'group', inWindow: 1 }
    const input = await mountReady()
    await submit(input)
    await vi.waitFor(() => expect(calls('smart_lookup_evidence_step')).toHaveLength(1))
    const chip = document.querySelector('.time-anchor')!
    expect(chip.textContent).toContain('Time: 上个月 · 10/1–10/31')
    expect(chip.querySelector('.time-mode')?.textContent).toBe('Group only')

    mocks.localTime = { sourceText: '上个月', after: '2026-10-01', before: '2026-10-31', mode: 'ignore', inWindow: 0 }
    click(chip.querySelector<HTMLButtonElement>('button[aria-label="Ignore time"]')!)
    await vi.waitFor(() => expect(calls('smart_lookup_local')).toHaveLength(2))
    expect(calls('smart_lookup_local')[1]).toMatchObject({ question: 'release risk', timeMode: 'ignore', deep: false })
    await vi.waitFor(() => expect(document.querySelector('.time-mode')?.textContent).toBe('Ignore time'))
    expect(document.querySelector('button[aria-label="Ignore time"]')).toBeNull()
    await wait(20)
    expect(calls('smart_lookup_evidence_step')).toHaveLength(1)
  })

  it('unfit rows are dimmed and the correction preselects the verdict of a tiered local row', async () => {
    useLocal()
    mocks.evidenceQueue.push(step({
      done: true, stop: 'maxHops',
      localTiers: [{ resultId: 'r3', tier: 'fit' }, { resultId: 'r1', tier: 'unsure' }, { resultId: 'r2', tier: 'unfit' }],
    }))
    const input = await mountReady()
    await submit(input)
    await vi.waitFor(() => expect(row('r2').classList.contains('dim')).toBe(true))
    expect(row('r3').classList.contains('dim')).toBe(false)

    const radios = () => [...document.querySelectorAll<HTMLButtonElement>('.correction [role="radio"]')]
    click(row('r3'))
    await vi.waitFor(() => expect(activeRowId()).toBe('r3'))
    expect(radios().map((radio) => radio.getAttribute('aria-checked'))).toEqual(['true', 'false'])
    expect(document.querySelector('.correction')?.textContent).toContain('Corrections stay on this device and are used to evaluate judging')
    click(row('r1'))
    await vi.waitFor(() => expect(activeRowId()).toBe('r1'))
    expect(radios().map((radio) => radio.getAttribute('aria-checked'))).toEqual(['false', 'false'])
    click(radios()[0])
    await vi.waitFor(() => expect(radios()[0].getAttribute('aria-checked')).toBe('true'))
    expect(calls('smart_lookup_feedback')[0]).toEqual({ lookupRunId: 'run-1', resultId: 'r1', verdict: 'fit' })
  })
})
