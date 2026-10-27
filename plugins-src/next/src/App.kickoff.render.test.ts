// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'
import { reduceEvents } from './lib/domain'
import { placeEvent } from './lib/events'
import type { NextWorkspace, WorkspaceItem } from './lib/repository'
import type { KickoffSnapshot } from './lib/kickoff/client'
import type { KickoffDoc } from './lib/kickoff/document'
import payload from './lib/kickoff/__fixtures__/payload.json'

const mocks = vi.hoisted(() => ({
  state: { workspace: null as NextWorkspace | null, loading: false, saving: false, error: null, reminders: {}, settings: { wipLimit: 5, defaultPriority: 'P2', defaultDueDays: 0, defaultContext: '' } },
  snapshot: null as unknown as KickoffSnapshot,
  createClient: vi.fn(),
  toast: vi.fn(),
  load: vi.fn(), reconcile: vi.fn(), preflight: vi.fn(), start: vi.fn(), save: vi.fn(), read: vi.fn(), refresh: vi.fn(async () => {}), place: vi.fn(), editorOpen: vi.fn(),
}))
vi.mock('./lib/bridge', () => ({ bridge: () => ({ locale: 'en', request: vi.fn() }), toast: mocks.toast, editorOpen: mocks.editorOpen,
  vaultExists: vi.fn(), vaultRead: vi.fn(), vaultWrite: vi.fn(), vaultList: vi.fn(), vaultInfo: vi.fn(), agentProviders: vi.fn(), agentLimits: vi.fn(), agentRun: vi.fn(), agentStatus: vi.fn() }))
vi.mock('./lib/store.svelte', () => ({ state: mocks.state, refresh: mocks.refresh, place: mocks.place,
  createIdea: vi.fn(), createTask: vi.fn(), completeWithNote: vi.fn(), open: vi.fn(), relink: vi.fn(), reopen: vi.fn(), updateSettings: vi.fn(), updateMetadata: vi.fn(), updateReminder: vi.fn() }))
vi.mock('./lib/kickoff/client', async (original) => ({
  ...await original<typeof import('./lib/kickoff/client')>(),
  createKickoffClient: (...args: unknown[]) => { mocks.createClient(...args); return { snapshot: () => mocks.snapshot, load: mocks.load, reconcile: mocks.reconcile, preflight: mocks.preflight, startKickoff: mocks.start, saveAnswers: mocks.save, markRead: mocks.read } },
}))
import App from './App.svelte'
const id = '8afad9c5-07ac-4e4d-8d1e-4ed04c06f2d8'
const task: WorkspaceItem = { key: id, item_id: id, kind: 'task', path: 'inbox/tasks/ship-task.md', state: 'capture', title: 'Ship', task: { version: 1, id }, proofed: false, orphan: false, relinkCandidates: [], relinkMatch: null }
const result = { path: 'inbox/tasks/ship-task.kickoff.md', doc: { metadata: {}, kickoff: { run_id: 'run1', task_id: id, based_on: 'hash', harness: 'Codex', duration_seconds: 62, payload, answers: [], prior_answers: [] } } as unknown as KickoffDoc }
let component: ReturnType<typeof mount> | null
async function settle() { for (let n = 0; n < 8; n++) { await Promise.resolve(); flushSync() } }
function click(text: string) { const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes(text)); expect(button).toBeTruthy(); button!.click(); flushSync() }
beforeEach(() => {
  mocks.state.workspace = { ledger: { type: 'Next', version: 1, source_dirs: ['inbox/tasks'], events: [], extra: {} }, ledgerRaw: null, sourceDirs: ['inbox/tasks'], ideaDir: 'inbox/ideas', projection: reduceEvents([]), sources: [], items: [task], capture: [task], wip: [], waiting: [], dormant: [], closed: [], unsupported: [], projectOptions: [], scanErrors: [], readOnlyError: null }
  mocks.snapshot = { registry: { version: 1, runs: {}, unread: [] }, results: {}, statuses: {}, hashes: { [id]: 'hash' }, providers: [{ id: 'codex', name: 'Codex', harness: { harness: 'Codex', ok: true } }], providerDefault: 'codex', unsupported: false, dataSources: [{ id: 'tasks', label: 'Task files', kind: 'vault', paths: [], enabled: true }], needsConsent: true }
  mocks.load.mockImplementation(async () => mocks.snapshot)
  mocks.reconcile.mockImplementation(async () => mocks.snapshot)
  mocks.read.mockImplementation(async () => mocks.snapshot)
  mocks.start.mockImplementation(async () => mocks.snapshot)
  mocks.preflight.mockResolvedValue({})
  localStorage.clear()
})
afterEach(() => { if (component) unmount(component); component = null; document.body.innerHTML = ''; vi.clearAllMocks(); vi.useRealTimers() })
async function render() { component = mount(App, { target: document.body }); flushSync(); await settle() }
describe('App kickoff integration', () => {
  it('updates an ongoing task from answered fields while preserving its commitment and WIP identity', async () => {
    const original = placeEvent(task, { route: 'commit', commitment: 'Existing commitment', next_action: 'Previous step', close_condition: 'Existing finish condition', projects: ['Release'] })
    const projection = reduceEvents([original])
    const ongoing: WorkspaceItem = { ...task, state: 'wip', projection: [...projection.items.values()][0] }
    Object.assign(mocks.state.workspace!, { projection, items: [ongoing], capture: [], wip: [ongoing] })
    mocks.snapshot.results[id] = result
    mocks.save.mockImplementation(async ({ answers }) => ({ snapshot: mocks.snapshot, result: { ...result, doc: { ...result.doc, kickoff: { ...result.doc.kickoff, answers } } }, rerendered: true }))
    await render()
    expect(document.querySelector('[data-kickoff-state]')).not.toBeNull()
    click('View kickoff')
    await settle()
    document.querySelector<HTMLInputElement>('input[value="a"]')!.click()
    flushSync()
    click('Place with these answers')
    await settle()
    expect(document.querySelector<HTMLTextAreaElement>('#commitment')?.value).toBe('Existing commitment')
    expect(document.querySelector<HTMLTextAreaElement>('#nextAction')?.value).toBe('检查配置')
    expect(document.querySelector<HTMLTextAreaElement>('#closeCondition')?.value).toBe('Existing finish condition')
    expect(mocks.place).not.toHaveBeenCalled()
    document.querySelector<HTMLButtonElement>('#place-title')!.closest('[role="dialog"]')!.querySelector<HTMLButtonElement>('button[type="submit"]')!.click()
    await settle()
    expect(mocks.place).toHaveBeenCalledOnce()
    const [savedItem, input] = mocks.place.mock.calls[0]
    expect(savedItem.task.id).toBe(id)
    expect(input).toMatchObject({ route: 'commit', commitment: 'Existing commitment', next_action: '检查配置', close_condition: 'Existing finish condition' })
    const updated = reduceEvents([original, placeEvent(savedItem, input)])
    expect(updated.wipCount).toBe(1)
    expect(updated.items.size).toBe(1)
    expect([...updated.items.values()][0]).toMatchObject({ state: 'wip', item_id: id, next_action: '检查配置', projects: ['Release'] })
  })
  it('does not reopen a task completed while kickoff answers were being saved', async () => {
    mocks.snapshot.results[id] = result
    mocks.save.mockImplementation(async ({ answers }) => {
      mocks.state.workspace!.items = [{ ...task, state: 'closed' }]
      return { snapshot: mocks.snapshot, result: { ...result, doc: { ...result.doc, kickoff: { ...result.doc.kickoff, answers } } }, rerendered: true }
    })
    await render()
    click('View kickoff')
    await settle()
    document.querySelector<HTMLInputElement>('input[value="a"]')!.click()
    flushSync()
    click('Place with these answers')
    await settle()
    expect(document.querySelector('#place-title')).toBeNull()
    expect(mocks.place).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Could not save answers')
  })
  it('retries a failed first initialization on explicit refresh', async () => {
    mocks.load.mockRejectedValueOnce(new Error('temporary read error'))
    await render()
    expect(document.querySelector('[data-kickoff-state]')).toBeNull()
    click('Refresh')
    await settle()
    expect(mocks.load).toHaveBeenCalledTimes(2)
    expect(mocks.reconcile).toHaveBeenCalledOnce()
    expect(document.querySelector('[data-kickoff-state]')?.getAttribute('data-kickoff-state')).toBe('idle')
  })
  it('does not overlap initialization while focus and refresh arrive during load', async () => {
    let resolveLoad!: (snapshot: KickoffSnapshot) => void
    mocks.load.mockImplementationOnce(() => new Promise((resolve) => { resolveLoad = resolve }))
    await render()
    window.dispatchEvent(new Event('focus'))
    click('Refresh')
    await settle()
    expect(mocks.load).toHaveBeenCalledOnce()
    resolveLoad(mocks.snapshot)
    await settle()
    expect(mocks.reconcile).toHaveBeenCalledOnce()
    expect(document.querySelector('[data-kickoff-state]')).not.toBeNull()
  })
  it('keeps a genuine preflight error when refreshing the same previous result', async () => {
    mocks.snapshot.results[id] = result
    mocks.preflight.mockRejectedValueOnce(new Error('preflight failed'))
    await render()
    document.querySelector<HTMLButtonElement>('[aria-label="Choose another agent"]')!.click()
    await settle()
    document.querySelector<HTMLButtonElement>('[role="menuitemradio"]')!.click()
    await settle()
    expect(document.querySelector('[data-kickoff-state]')?.getAttribute('data-kickoff-state')).toBe('failed')
    click('Refresh')
    await settle()
    expect(document.querySelector('[data-kickoff-state]')?.getAttribute('data-kickoff-state')).toBe('failed')
    expect(mocks.start).not.toHaveBeenCalled()
  })
  it('recovers a registered run after a start write/readback failure and then displays its result', async () => {
    vi.useFakeTimers()
    mocks.snapshot.needsConsent = false
    const run = { run_id: 'recovered-run', harness: 'codex', requested_at: new Date().toISOString(), task_path: task.path!, based_on: 'hash', state: 'running' as const, failure: null }
    mocks.start.mockImplementation(async () => {
      mocks.snapshot = { ...mocks.snapshot, registry: { ...mocks.snapshot.registry, runs: { [id]: run } } }
      throw new Error('registry readback failed')
    })
    await render()
    click('Get me started')
    await settle()
    document.querySelector<HTMLButtonElement>('[role="menuitemradio"]')!.click()
    await settle()
    expect(document.querySelector('[data-kickoff-state]')?.getAttribute('data-kickoff-state')).toBe('running')
    const recoveredResult = { ...result, doc: { ...result.doc, kickoff: { ...result.doc.kickoff, run_id: 'recovered-run' } } }
    mocks.snapshot = { ...mocks.snapshot, results: { [id]: recoveredResult }, registry: { version: 1, runs: {}, unread: [id] } }
    vi.advanceTimersByTime(2000)
    await settle()
    expect(document.querySelector('[data-kickoff-state]')?.getAttribute('data-kickoff-state')).toMatch(/^ready/)
    expect(document.querySelector('#kickoff-result-title')).not.toBeNull()
    expect(mocks.start).toHaveBeenCalledOnce()
  })
  it.each([false, true])('reports manual body preservation after saving (place: %s)', async (placeAfter) => {
    mocks.snapshot.results[id] = result
    mocks.save.mockImplementation(async ({ answers }) => ({
      snapshot: mocks.snapshot,
      result: { ...result, doc: { ...result.doc, kickoff: { ...result.doc.kickoff, answers } } },
      rerendered: false,
    }))
    await render()
    click('View kickoff')
    await settle()
    document.querySelector<HTMLInputElement>('input[value="a"]')!.click()
    flushSync()
    click(placeAfter ? 'Place with these answers' : 'Save answers only')
    await settle()
    expect(mocks.toast).toHaveBeenCalledWith('success', 'Answers saved', 'The body was edited manually and was not rendered again.')
    expect(mocks.save.mock.calls[0][0].answers[0].by).toBe('human:owner')
    expect(Boolean(document.querySelector('#place-title'))).toBe(placeAfter)
    if (placeAfter) expect(document.querySelector<HTMLTextAreaElement>('#nextAction')?.value).toBe('检查配置')
  })
  it.each(['picker', 'consent', 'progress', 'result'])('keeps the %s dialog exclusive under new-item shortcuts', async (mode) => {
    if (mode === 'result') mocks.snapshot.results[id] = result
    if (mode === 'progress') mocks.snapshot.registry.runs[id] = { run_id: 'r1', harness: 'codex', requested_at: new Date().toISOString(), task_path: task.path!, based_on: 'hash', state: 'running', failure: null }
    await render()
    const kickoffButton = document.querySelector<HTMLButtonElement>('[data-kickoff-state]')!
    kickoffButton.focus()
    kickoffButton.click()
    await settle()
    if (mode === 'consent') {
      document.querySelector<HTMLButtonElement>('[role="menuitemradio"]')!.click()
      await settle()
    }
    for (const modifier of [{ metaKey: true }, { ctrlKey: true }]) {
      for (const shiftKey of [false, true]) {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ...modifier, shiftKey, bubbles: true, cancelable: true }))
        flushSync()
        expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
      }
    }
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
    expect(document.querySelector('[role="dialog"]')?.contains(document.activeElement)).toBe(true)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await settle()
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(0)
    expect(document.activeElement).toBe(kickoffButton)
  })
  it('constructs the production client without provider admission overrides', async () => {
    await render()
    expect(mocks.createClient.mock.calls[0]).toHaveLength(2)
    expect(mocks.createClient.mock.calls[0][1]).toEqual({ notificationTitles: { ok: 'Kickoff is ready', fail: 'Kickoff failed' } })
    expect(mocks.createClient.mock.calls[0][1]).not.toHaveProperty('verifiedProviders')
    expect(mocks.createClient.mock.calls[0][0]).toHaveProperty('currentItem')
  })
  it('confirming consent starts only the chosen provider', async () => {
    await render()
    click('Get me started')
    await settle()
    document.querySelector<HTMLButtonElement>('[role="menuitemradio"]')!.click()
    await settle()
    document.querySelector<HTMLButtonElement>('[data-consent-confirm]')!.click()
    await settle()
    expect(mocks.start).toHaveBeenCalledWith({ item: task, providerId: 'codex', consent: true })
    expect(mocks.place).not.toHaveBeenCalled()
  })
  it('keeps entered answers and prevents placement after a failed save/readback', async () => {
    mocks.snapshot.results[id] = result
    mocks.save.mockRejectedValue(new Error('readback mismatch'))
    await render()
    click('View kickoff')
    await settle()
    document.querySelector<HTMLButtonElement>('[data-source="s1"]')!.click()
    expect(mocks.editorOpen).toHaveBeenCalledWith('diary/release.note.md')
    document.querySelector<HTMLInputElement>('input[value="b"]')!.click()
    flushSync()
    click('Place with these answers')
    await settle()
    expect(document.querySelector<HTMLInputElement>('input[value="b"]')!.checked).toBe(true)
    expect(document.body.textContent).toContain('Could not save answers')
    expect(document.querySelector('#place-title')).toBeNull()
    expect(mocks.place).not.toHaveBeenCalled()
  })
  it('loads and reconciles on open and hides kickoff for old hosts', async () => {
    mocks.snapshot.unsupported = true
    await render()
    expect(mocks.load).toHaveBeenCalledOnce()
    expect(mocks.reconcile).toHaveBeenCalledOnce()
    expect(document.querySelector('[data-kickoff-state]')).toBeNull()
  })
  it('first selection requires consent and cancelling starts nothing', async () => {
    await render()
    click('Get me started')
    await settle()
    document.querySelector<HTMLButtonElement>('[role="menuitemradio"]')!.click()
    await settle()
    expect(document.body.textContent).toContain('Add the kickoff procedure?')
    document.querySelector<HTMLButtonElement>('[data-consent-cancel]')!.click()
    await settle()
    expect(mocks.start).not.toHaveBeenCalled()
    expect(mocks.save).not.toHaveBeenCalled()
    expect(mocks.place).not.toHaveBeenCalled()
  })
  it('waits for answer save/readback before opening commit and cancellation keeps answers', async () => {
    mocks.snapshot.results[id] = result
    let resolveSave!: (value: unknown) => void
    mocks.save.mockImplementation(() => new Promise((resolve) => { resolveSave = resolve }))
    await render()
    click('View kickoff')
    await settle()
    document.querySelector<HTMLInputElement>('input[value="a"]')!.click()
    flushSync()
    click('Place with these answers')
    await settle()
    expect(document.querySelector('#place-title')).toBeNull()
    const answers = mocks.save.mock.calls[0][0].answers
    const saved = { ...result, doc: { ...result.doc, kickoff: { ...result.doc.kickoff, answers } } }
    resolveSave({ snapshot: mocks.snapshot, result: saved, rerendered: true })
    await settle()
    expect(document.querySelector('#place-title')).not.toBeNull()
    expect(document.querySelector<HTMLTextAreaElement>('#nextAction')?.value).toBe('检查配置')
    click('Cancel')
    expect(mocks.save).toHaveBeenCalledOnce()
    expect(mocks.place).not.toHaveBeenCalled()
  })
  it('polls running registrations every two seconds and cleans up on unmount', async () => {
    vi.useFakeTimers()
    mocks.snapshot.registry.runs[id] = { run_id: 'run1', harness: 'codex', requested_at: new Date().toISOString(), task_path: task.path!, based_on: 'hash', state: 'running', failure: null }
    await render()
    expect(mocks.reconcile).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(2000)
    await settle()
    expect(mocks.reconcile).toHaveBeenCalledTimes(2)
    unmount(component!); component = null
    vi.advanceTimersByTime(6000)
    await settle()
    expect(mocks.reconcile).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })
})
