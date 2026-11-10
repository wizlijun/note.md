// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import type { SearchHit, SmartSearchHit, SmartSearchResponse } from './lib/search/api'

type AgentStatus = Record<string, unknown>

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  writeText: vi.fn(async (_text: string) => {}),
  setTitle: vi.fn(async () => {}),
  focusChanged: null as ((event: { payload: boolean }) => Promise<void> | void) | null,
  listeners: new Map<string, Array<() => unknown>>(),
  storedSmartLookup: undefined as unknown,
  preview: 'normal' as 'normal' | 'empty',
  local: 'normal' as 'normal' | 'empty',
  localGate: null as Promise<void> | null,
  localError: null as string | null,
  customHits: null as SmartSearchHit[] | null,
  statusResults: [] as AgentStatus[],
  summaryStartError: null as string | null,
  agentsError: false,
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
      set: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
      save: vi.fn(async () => {}),
    })),
  },
}))

import SmartLookupApp from './SmartLookupApp.svelte'

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

function harnessStatus() {
  return {
    harness: 'Test Harness', ok: true, default_model: 'test-model',
    capabilities: {
      tasks: ['search-summary', 'vault-research'],
      search_plan_schemas: [1],
      terminal_result: true, input_only_isolation: true,
      model_routing: {
        invocation_override: true,
        profiles: {
          fast: { model: 'test-fast', available: true },
          default: { model: 'test-model', available: true },
        },
        selectable_models: ['test-fast', 'test-model'],
      },
    },
  }
}

function installInvokeMock(): void {
  mocks.invoke.mockImplementation(async (command: string, args?: Record<string, any>) => {
    if (command === 'get_plugin_manifests') {
      if (mocks.agentsError) throw new Error('plugins unavailable')
      return [{ id: 'notemd.test-agent', name: 'Test Agent', agent_provider: true }]
    }
    if (command === 'plugin_v2_execute') {
      if (args?.command === 'harness-status') return harnessStatus()
      if (args?.command === 'run-cancel') return { state: 'cancelling' }
      if (args?.command === 'run-task') return { run_id: 'unexpected-run', resolved_model: 'test-fast' }
      if (args?.command === 'run-status') {
        if (mocks.statusResults.length) return mocks.statusResults.shift()
        return {
          state: 'done',
          record: { status: 'success', usage: { input_tokens: 5 } },
          terminal_result: { complete: true, content: '- Fix the blocker before release. [S1]' },
        }
      }
    }
    if (command === 'smart_lookup_agent_default') return 'notemd.test-agent'
    if (command === 'notemd_smart_search') {
      return searchResponse(args?.deep === true ? 'normal' : mocks.preview)
    }
    if (command === 'smart_lookup_local') {
      const gate = mocks.localGate
      mocks.localGate = null
      if (gate) await gate
      if (mocks.localError) throw new Error(mocks.localError)
      const question = String(args?.question ?? '')
      const search = args?.deep === true
        ? searchResponse('normal')
        : question === 'new question' ? searchResponse('single') : searchResponse(mocks.local)
      return { search, lookupRunId: `run-${question}` }
    }
    if (command === 'smart_lookup_start_summary') {
      if (mocks.summaryStartError) throw new Error(mocks.summaryStartError)
      return {
        runId: 'summary-1',
        resolvedModel: 'test-fast',
        sources: [{ id: 'S1', path: 'notes/alpha.md', line: 4, lineEnd: 4 }],
        staleCount: 0,
      }
    }
    if (command === 'smart_lookup_start_handoff') return { runId: 'research-1', resolvedModel: 'test-model' }
    return undefined
  })
}

function calls(command: string) {
  return mocks.invoke.mock.calls.filter((call) => call[0] === command)
}

function agentCommands(name: string) {
  return mocks.invoke.mock.calls.filter((call) => (
    call[0] === 'plugin_v2_execute' && call[1]?.command === name
  ))
}

async function mountReady(): Promise<HTMLTextAreaElement> {
  component = mount(SmartLookupApp, { target: document.body })
  await vi.waitFor(() => {
    expect(agentCommands('harness-status').length).toBeGreaterThan(0)
    expect(document.querySelector('.query-input')).not.toBeNull()
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
  mocks.storedSmartLookup = undefined
  mocks.preview = 'normal'
  mocks.local = 'normal'
  mocks.localGate = null
  mocks.localError = null
  mocks.customHits = null
  mocks.statusResults.length = 0
  mocks.summaryStartError = null
  mocks.agentsError = false
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
    expect(previews[0][1]).toEqual(expect.objectContaining({ query: 'release risk', deep: false, limit: 50 }))
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
    expect(calls('smart_lookup_local')[0][1]).toEqual(expect.objectContaining({
      question: 'release risk', deep: false, limit: 50,
    }))
    expect(agentCommands('run-task')).toHaveLength(0)
    expect(calls('smart_lookup_start_summary')).toHaveLength(0)
    expect(calls('smart_lookup_start_handoff')).toHaveLength(0)
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
    expect(calls('editor_show_and_reveal_search_hit')[0][1]).toEqual(expect.objectContaining({
      path: '/vault/notes/beta.md', line: 8,
    }))
    await vi.waitFor(() => expect(calls('hide_smart_search_window')).toHaveLength(1))
  })

  it('opens the current hit from the preview header', async () => {
    const input = await mountReady()
    await submit(input)
    document.querySelector<HTMLButtonElement>('.preview-header .text-button')!.click()
    await vi.waitFor(() => expect(calls('editor_show_and_reveal_search_hit')[0]?.[1]).toEqual(
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
    expect(document.body.textContent).toContain('No matches')
    expect(document.body.textContent).toContain('Try a shorter topic')

    await chooseMenuAction('Expand search')
    await vi.waitFor(() => expect(document.querySelectorAll('.result-row')).toHaveLength(3))
    const lookups = calls('smart_lookup_local')
    expect(lookups).toHaveLength(2)
    expect(lookups[1][1]).toEqual(expect.objectContaining({
      question: 'release risk', deep: true, timeoutMs: 4000,
    }))
    expect(agentCommands('run-task')).toHaveLength(0)
  })

  it('summary runs only on click and renders validated output', async () => {
    const input = await mountReady()
    await submit(input)
    expect(calls('smart_lookup_start_summary')).toHaveLength(0)

    await chooseMenuAction('Create answer')
    await vi.waitFor(() => expect(document.querySelector('.answer-body')?.textContent).toContain('[S1]'))

    expect(agentCommands('run-task')).toHaveLength(0)
    expect(calls('smart_lookup_start_summary')).toHaveLength(1)
    expect(calls('smart_lookup_start_summary')[0][1]).toEqual(expect.objectContaining({
      lookupRunId: 'run-release risk',
      selectedResultIds: [],
      sourceLimit: 4,
      charLimit: 4000,
      style: 'bullets',
      provider: 'notemd.test-agent',
      model_profile: 'fast',
      invocationId: expect.any(String),
    }))
  })

  it('an expired lookup run shows a summary error and re-enables the action', async () => {
    mocks.summaryStartError = 'lookup run expired; run Smart Lookup again'
    const input = await mountReady()
    await submit(input)
    await chooseMenuAction('Create answer')

    await vi.waitFor(() => {
      const error = document.querySelector('.preview-pane .summary-error[role="alert"]')?.textContent ?? ''
      expect(error).toContain('Could not create a quick answer')
      expect(error).toContain('lookup run expired')
    })
    expect(document.querySelector('.answer-body')).toBeNull()
    await openMenu()
    expect(menuItem('Create answer').disabled).toBe(false)
  })

  it('a new lookup cancels a running summary', async () => {
    for (let i = 0; i < 20; i += 1) mocks.statusResults.push({ state: 'running', steps: i, last: 'hidden' })
    const input = await mountReady()
    await submit(input)
    await chooseMenuAction('Create answer')
    await vi.waitFor(() => expect(agentCommands('run-status').length).toBeGreaterThan(0))

    await submit(input, 'new question', 1)
    await vi.waitFor(() => expect(agentCommands('run-cancel').some((call) => (
      call[1]?.context?.task === 'search-summary' && call[1]?.context?.run_id === 'summary-1'
    ))).toBe(true))
    mocks.statusResults.length = 0
    await wait(700)
    expect(document.querySelector('.answer-body')).toBeNull()
    expect(document.body.textContent).toContain('new-result')
  })

  it('handoff sends only relative references', async () => {
    mocks.customHits = [hit('alpha', 4), { ...hit('outside', 2), path: '/abs/outside.md' }]
    const input = await mountReady()
    await submit(input, 'release risk', 2)

    await chooseMenuAction('In-depth research')
    await vi.waitFor(() => expect(calls('smart_lookup_start_handoff')).toHaveLength(1))
    const handoff = calls('smart_lookup_start_handoff')[0][1]
    expect(handoff?.question).toBe('release risk')
    expect(handoff?.provider).toBe('notemd.test-agent')
    expect(handoff?.selectedRefs).toEqual([{ path: 'notes/alpha.md', line: 4, lineEnd: 4 }])
    expect(JSON.stringify(handoff)).not.toContain('/vault/')
    expect(JSON.stringify(handoff)).not.toContain('/abs/')
    expect(JSON.stringify(handoff)).not.toContain('PRIVATE_BODY_')
    expect(agentCommands('run-task')).toHaveLength(0)

    await vi.waitFor(() => expect(document.querySelector('.handoff-status')).not.toBeNull())
    buttonNamed('Open research ↗').click()
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('plugin_v2_open_window', {
      pluginId: 'notemd.test-agent', windowId: 'main',
    }))
  })

  it('handoff omits result references when the setting is off', async () => {
    mocks.storedSmartLookup = { handoff: { includeSelectedRefs: false } }
    const input = await mountReady()
    await submit(input)
    await chooseMenuAction('In-depth research')
    await vi.waitFor(() => expect(calls('smart_lookup_start_handoff')).toHaveLength(1))
    expect(calls('smart_lookup_start_handoff')[0][1]?.selectedRefs).toEqual([])
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

  it('records summary usage in the activity log', async () => {
    const input = await mountReady()
    await submit(input)
    await chooseMenuAction('Create answer')
    await vi.waitFor(() => expect(document.querySelector('.answer-body')).not.toBeNull())
    await chooseMenuAction('Copy activity log')
    await vi.waitFor(() => expect(mocks.writeText).toHaveBeenCalledTimes(1))
    const lines = String(mocks.writeText.mock.calls[0][0]).split('\n').map((line) => JSON.parse(line))
    expect(lines.find((entry) => entry.stage === 'summary' && entry.level === 'success'))
      .toMatchObject({ usage: { input_tokens: 5 } })
  })

  it('keeps lookup working when agents cannot be loaded', async () => {
    mocks.agentsError = true
    component = mount(SmartLookupApp, { target: document.body })
    await vi.waitFor(() => expect(calls('get_plugin_manifests')).toHaveLength(1))
    const input = document.querySelector<HTMLTextAreaElement>('.query-input')!
    await submit(input)
    await openMenu()
    expect(menuItem('Create answer').disabled).toBe(true)
    expect(menuItem('In-depth research').disabled).toBe(true)
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
