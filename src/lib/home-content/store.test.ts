// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyCounters, type DeviceAnalytics } from '../insights/model'
import type { ContentCandidate, HomeContentData } from './model'

const mocks = vi.hoisted(() => ({
  load: vi.fn(), get: vi.fn(), set: vi.fn(), save: vi.fn(), invoke: vi.fn(),
  catalog: vi.fn(), history: vi.fn(), exists: vi.fn(), watch: vi.fn(), listen: vi.fn(),
}))
vi.mock('@tauri-apps/plugin-store', () => ({ Store: { load: mocks.load } }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@tauri-apps/api/path', () => ({ homeDir: async () => '/fixture' }))
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }))
vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: mocks.exists, watchImmediate: mocks.watch, mkdir: vi.fn(), readDir: vi.fn(), readTextFile: vi.fn(), writeTextFile: vi.fn(),
}))
vi.mock('../settings.svelte', () => ({ getDeviceId: () => 'fixture-device' }))
vi.mock('../insights/store.svelte', () => ({ createAnalyticsStore: () => ({ readAllDevices: mocks.history }) }))

const ROOT = '/fixture/vault'
const NOW = Date.UTC(2026, 10, 19, 8)
let now: number
let durable: HomeContentData | undefined
let staged: HomeContentData | undefined
let candidates: Map<string, ContentCandidate[]>
let missing: Set<string>
let store: typeof import('./store.svelte') | undefined
let disposers: Array<() => void>
const clone = <T>(value: T): T => structuredClone(value)
const candidate = (name: string, root = ROOT): ContentCandidate => ({ path: `${root}/${name}`, title: null, conceptType: null, createdAt: NOW - 1000, modifiedAt: NOW })
const paths = (items: { path: string }[]) => items.map(item => item.path)
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function load(root = ROOT) {
  store = await import('./store.svelte')
  disposers.push(store.installHomeContent(root))
  await store.refreshHomeContent()
  return store
}
async function restart(root = ROOT) {
  await store?.flushHomeContent()
  disposers.splice(0).forEach(dispose => dispose())
  vi.resetModules()
  return load(root)
}
const persisted = (path: string, root = ROOT) => durable!.vaults[root].docs[path.startsWith(root + '/') ? `rel:${path.slice(root.length + 1)}` : `abs:${path}`]

beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
  now = NOW; durable = undefined; staged = undefined; store = undefined; disposers = []
  candidates = new Map([[ROOT, [candidate('a.md'), candidate('b.md')]]])
  missing = new Set()
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  mocks.load.mockResolvedValue({ get: mocks.get, set: mocks.set, save: mocks.save })
  mocks.get.mockImplementation(async () => clone(durable))
  mocks.set.mockImplementation(async (_key: string, value: HomeContentData) => { staged = clone(value) })
  mocks.save.mockImplementation(async () => { durable = clone(staged) })
  mocks.catalog.mockImplementation(async ({ expectedRoot }: { expectedRoot: string }) => ({ root: expectedRoot, items: clone(candidates.get(expectedRoot) ?? []), skipped: 0 }))
  mocks.invoke.mockImplementation(async (command: string, args: unknown) => command === 'home_content_catalog' ? mocks.catalog(args) : undefined)
  mocks.history.mockResolvedValue([])
  mocks.exists.mockImplementation(async (path: string) => !missing.has(path))
  mocks.watch.mockResolvedValue(() => {})
  mocks.listen.mockResolvedValue(() => {})
})
afterEach(async () => {
  disposers.splice(0).forEach(dispose => dispose())
  await store?.flushHomeContent().catch(() => {})
  vi.restoreAllMocks()
})

describe('home content durable activity', () => {
  it('supplies all home candidates for expansion and caps only the menu at ten after filtering', async () => {
    const noise = Array.from({ length: 15 }, (_, n) => ({ ...candidate(`skills/${n}.md`), createdAt: NOW }))
    const documents = Array.from({ length: 12 }, (_, n) => ({ ...candidate(`${String(n).padStart(2, '0')}.md`), createdAt: NOW - n - 1 }))
    candidates.set(ROOT, [...noise, ...documents])
    const s = await load()
    expect(paths(s.homeContentStore.newItems)).toEqual(documents.map(c => c.path))
    await vi.waitFor(() => {
      const menu = mocks.invoke.mock.calls.filter(([command]) => command === 'update_latest_menu').at(-1)
      expect((menu?.[1] as { items: { path: string }[] }).items.map(item => item.path)).toEqual(documents.slice(0, 10).map(c => c.path))
    })
  })

  it('persists brief visits on flush and accumulates them across restart without pretending they are edits', async () => {
    let s = await load(), path = candidate('a.md').path
    s.beginHomeVisit(path, ROOT)
    now += 10_000; s.recordHomeAttention(path, 10_000)
    await s.flushHomeContent()
    expect(persisted(path).readMs).toBe(10_000)
    s = await restart()
    s.beginHomeVisit(path, ROOT)
    now += 20_000; s.recordHomeAttention(path, 20_000)
    await s.flushHomeContent()
    expect(persisted(path)).toMatchObject({ readMs: 30_000, lastEditedAt: 0, lastReadAt: 0 })
    expect(paths(s.homeContentStore.newItems)).not.toContain(path)
    expect(s.homeContentStore.continueItems).toEqual([])
  })

  it('retains new/continue dismissals on restart, ignores short previews, and permits a later real edit to return', async () => {
    let s = await load()
    const a = candidate('a.md').path, b = candidate('b.md').path
    s.recordHomeEdit(b, ROOT); await s.flushHomeContent()
    now++
    await s.dismissHomeContent('new', a)
    await s.dismissHomeContent('continue', b)
    s = await restart()
    expect(s.homeContentStore.newItems).toEqual([])
    expect(s.homeContentStore.continueItems).toEqual([])
    s.beginHomeVisit(b, ROOT)
    now += 59_999; s.recordHomeAttention(b, 59_999); await s.flushHomeContent()
    expect(s.homeContentStore.continueItems).toEqual([])
    now++; s.recordHomeAttention(b, 1); await s.flushHomeContent()
    expect(paths(s.homeContentStore.continueItems)).toEqual([b])
    now++; await s.dismissHomeContent('continue', b)
    now++; s.recordHomeEdit(b, ROOT); await s.flushHomeContent()
    expect(paths(s.homeContentStore.continueItems)).toEqual([b])
    expect(persisted(a).dismissedNew).toBe(true)
  })

  it('does not resurrect a dismissal when a slow save overlaps the old visit crossing sixty seconds', async () => {
    const s = await load(), path = candidate('a.md').path
    s.recordHomeEdit(path, ROOT); await s.flushHomeContent()
    s.beginHomeVisit(path, ROOT)
    now += 55_000; s.recordHomeAttention(path, 55_000); await s.flushHomeContent()
    const gate = deferred<void>(), saving = deferred<void>()
    mocks.save.mockImplementationOnce(async () => { saving.resolve(); await gate.promise; durable = clone(staged) })
    now++
    const dismiss = s.dismissHomeContent('continue', path)
    await saving.promise
    now += 5_000; s.recordHomeAttention(path, 5_000)
    gate.resolve(); await dismiss; await s.flushHomeContent()
    expect(s.homeContentStore.continueItems).toEqual([])
    now += 54_999; s.recordHomeAttention(path, 54_999); await s.flushHomeContent()
    expect(s.homeContentStore.continueItems).toEqual([])
    now++; s.recordHomeAttention(path, 1); await s.flushHomeContent()
    expect(paths(s.homeContentStore.continueItems)).toEqual([path])
  })

  it('serializes concurrent dismissals without losing either durable change', async () => {
    const s = await load(), a = candidate('a.md').path, b = candidate('b.md').path
    const gate = deferred<void>(), saving = deferred<void>(), savedBefore = mocks.save.mock.calls.length
    mocks.save.mockImplementationOnce(async () => { saving.resolve(); await gate.promise; durable = clone(staged) })
    const first = s.dismissHomeContent('new', a)
    await saving.promise
    const second = s.dismissHomeContent('new', b)
    await Promise.resolve()
    expect(mocks.save).toHaveBeenCalledTimes(savedBefore + 1)
    gate.resolve(); await Promise.all([first, second])
    expect(persisted(a).dismissedNew).toBe(true)
    expect(persisted(b).dismissedNew).toBe(true)
    expect(s.homeContentStore.newItems).toEqual([])
  })

  it('keeps the current list and durable data on a scan read failure, then recovers on retry', async () => {
    const s = await load(), before = clone(durable), shown = paths(s.homeContentStore.newItems)
    mocks.catalog.mockRejectedValueOnce(new Error('catalog denied'))
    await expect(s.refreshHomeContent()).rejects.toThrow('catalog denied')
    expect(s.homeContentStore.error).toContain('catalog denied')
    expect(paths(s.homeContentStore.newItems)).toEqual(shown)
    expect(durable).toEqual(before)
    await s.refreshHomeContent()
    expect(s.homeContentStore.error).toBeNull()
  })

  it('does not overwrite persisted dismissals when initial storage reading fails', async () => {
    await load()
    const path = candidate('a.md').path
    await store!.dismissHomeContent('new', path)
    await store!.flushHomeContent()
    const before = clone(durable), writes = mocks.set.mock.calls.length
    disposers.splice(0).forEach(dispose => dispose())
    vi.resetModules()
    mocks.get.mockRejectedValueOnce(new Error('storage read denied'))
    store = await import('./store.svelte')
    disposers.push(store.installHomeContent(ROOT))
    await expect(store.refreshHomeContent()).rejects.toThrow('storage read denied')
    expect(mocks.set).toHaveBeenCalledTimes(writes)
    expect(durable).toEqual(before)
    await store.refreshHomeContent()
    expect(paths(store.homeContentStore.newItems)).not.toContain(path)
  })

  it('rolls back a failed dismissal and saves it correctly when retried', async () => {
    const s = await load(), path = candidate('a.md').path, before = clone(durable)
    mocks.save.mockRejectedValueOnce(new Error('disk full'))
    await expect(s.dismissHomeContent('new', path)).rejects.toThrow('disk full')
    expect(paths(s.homeContentStore.newItems)).toContain(path)
    expect(durable).toEqual(before)
    expect(s.homeContentStore.error).toContain('disk full')
    await s.dismissHomeContent('new', path)
    expect(paths(s.homeContentStore.newItems)).not.toContain(path)
    expect(persisted(path).dismissedNew).toBe(true)
    expect(s.homeContentStore.error).toBeNull()
  })

  it('does not allow an old Vault scan to overwrite the next Vault or publish its menu paths', async () => {
    const next = '/fixture/other-vault', nextFile = candidate('next.md', next), old = deferred<{ root: string; items: ContentCandidate[]; skipped: number }>()
    candidates.set(next, [nextFile])
    mocks.catalog.mockImplementationOnce(() => old.promise)
    store = await import('./store.svelte')
    const stopOld = store.installHomeContent(ROOT)
    const oldScan = store.refreshHomeContent()
    await vi.waitFor(() => expect(mocks.catalog).toHaveBeenCalledTimes(1))
    stopOld()
    disposers.push(store.installHomeContent(next))
    await store.refreshHomeContent()
    old.resolve({ root: ROOT, items: [candidate('stale.md')], skipped: 0 })
    await oldScan
    expect(paths(store.homeContentStore.newItems)).toEqual([nextFile.path])
    expect(store.homeContentStore.error).toBeNull()
    expect(durable!.vaults[ROOT]?.docs['rel:stale.md']).toBeUndefined()
    await vi.waitFor(() => {
      const last = mocks.invoke.mock.calls.filter(([command]) => command === 'update_latest_menu').at(-1)
      expect((last?.[1] as { items: { path: string }[] }).items.map(item => item.path)).toEqual([nextFile.path])
    })
  })

  it('retains previously valid entries during a partial scan and removes missing entries after a complete scan', async () => {
    const s = await load(), a = candidate('a.md'), b = candidate('b.md')
    mocks.catalog.mockResolvedValueOnce({ root: ROOT, items: [a], skipped: 1 })
    await s.refreshHomeContent()
    expect(paths(s.homeContentStore.newItems)).toEqual([a.path, b.path])
    expect(s.homeContentStore.skipped).toBe(1)
    mocks.catalog.mockResolvedValueOnce({ root: ROOT, items: [a], skipped: 0 })
    await s.refreshHomeContent()
    expect(paths(s.homeContentStore.newItems)).toEqual([a.path])
  })

  it('does not bump a completed reading visit when it is flushed after an hour of idle time', async () => {
    const s = await load(), path = candidate('a.md').path
    s.beginHomeVisit(path, ROOT)
    now += 60_000; s.recordHomeAttention(path, 60_000)
    await s.flushHomeContent()
    const readAt = now
    expect(persisted(path)).toMatchObject({ readMs: 60_000, lastReadAt: readAt })
    now += 3_600_000
    await s.flushHomeContent()
    expect(persisted(path)).toMatchObject({ readMs: 60_000, lastReadAt: readAt })
    expect(s.homeContentStore.continueItems[0].at).toBe(readAt)
  })

  it('publishes the first real edit promptly and batches another hundred keystrokes using their true final edit time', async () => {
    const s = await load(), path = candidate('a.md').path
    const savedBefore = mocks.save.mock.calls.length
    now++
    s.recordHomeEdit(path, ROOT)
    await vi.waitFor(() => expect(paths(s.homeContentStore.continueItems)).toEqual([path]))
    expect(mocks.save).toHaveBeenCalledTimes(savedBefore + 1)
    expect(paths(s.homeContentStore.newItems)).not.toContain(path)
    for (let n = 0; n < 100; n++) {
      now++
      s.recordHomeEdit(path, ROOT)
    }
    const finalEditAt = now
    await Promise.resolve()
    expect(mocks.save).toHaveBeenCalledTimes(savedBefore + 1)
    now += 3_600_000
    await s.flushHomeContent()
    expect(mocks.save).toHaveBeenCalledTimes(savedBefore + 2)
    expect(persisted(path).lastEditedAt).toBe(finalEditAt)
    expect(s.homeContentStore.continueItems[0].at).toBe(finalEditAt)
  })

  it('checks migrated external history immediately and retains it for a disk reconnect', async () => {
    const external = '/offline/report.md', activeAt = NOW - 10_000
    const history: DeviceAnalytics = {
      deviceId: 'old-device', deviceName: 'Old',
      docs: { [`abs:${external}`]: { '2026-11-19': { ...emptyCounters(activeAt), read_ms: 60_000 } } },
      sessions: { [`abs:${external}`]: { '2026-11-19': [{ start: activeAt - 60_000, end: activeAt, read_ms: 60_000, edit_ms: 0 }] } },
    }
    mocks.history.mockResolvedValue([history]); missing.add(external)
    const s = await load()
    expect(s.homeContentStore.continueItems).toEqual([])
    expect(persisted(external).lastReadAt).toBe(activeAt)
    missing.delete(external)
    await s.refreshHomeContent()
    expect(paths(s.homeContentStore.continueItems)).toEqual([external])
    expect(persisted(external)).toMatchObject({ lastReadAt: activeAt, lastEditedAt: 0 })
  })
})

describe('home directory rules and the exclude prompt', () => {
  let settings: Record<string, unknown>
  let settingsFail: Error | null
  let setFail: Error | null
  beforeEach(() => {
    settings = { homeNewExcludeDirs: ['stat'] }
    settingsFail = null; setFail = null
    mocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === 'home_content_catalog') return mocks.catalog(args)
      if (command === 'notemd_vault_settings_get') { if (settingsFail) throw settingsFail; return clone(settings) }
      if (command === 'notemd_vault_settings_set') { if (setFail) throw setFail; settings = { ...settings, ...args }; return clone(settings) }
      return undefined
    })
  })
  const sessions = (n: number) => Array.from({ length: n }, (_, i) => candidate(`agent-sessions/tool-${i % 2}/s${i}.md`))
  const lastMenu = () => (mocks.invoke.mock.calls.filter(([command]) => command === 'update_latest_menu').at(-1)?.[1] as { items: { path: string }[] }).items.map(item => item.path)

  it('hides excluded directories from the new list and the latest menu', async () => {
    candidates.set(ROOT, [candidate('stat/a.md'), candidate('project/r.md')])
    const s = await load()
    expect(paths(s.homeContentStore.newItems)).toEqual([candidate('project/r.md').path])
    await vi.waitFor(() => expect(lastMenu()).toEqual([candidate('project/r.md').path]))
  })

  it('asks on the fourth new-list dismissal in one first-level directory; continue dismissals do not count', async () => {
    candidates.set(ROOT, sessions(6))
    const s = await load()
    for (const c of sessions(3)) await s.dismissHomeContent('new', c.path)
    await s.dismissHomeContent('continue', sessions(6)[5].path)
    expect(s.homeContentStore.ask).toBeNull()
    await s.dismissHomeContent('new', sessions(6)[3].path)
    expect(s.homeContentStore.ask).toEqual({ dir: 'agent-sessions', count: 4 })
  })

  it('excludes the asked directory through vault settings and drops its entries', async () => {
    candidates.set(ROOT, [...sessions(6), candidate('project/r.md')])
    const s = await load()
    for (const c of sessions(4)) await s.dismissHomeContent('new', c.path)
    await s.excludeAskedDir()
    expect(mocks.invoke).toHaveBeenCalledWith('notemd_vault_settings_set', { homeNewExcludeDirs: ['stat', 'agent-sessions'] })
    expect(s.homeContentStore.ask).toBeNull()
    expect(paths(s.homeContentStore.newItems)).toEqual([candidate('project/r.md').path])
  })

  it('keeps the prompt and the count when saving the exclusion fails', async () => {
    candidates.set(ROOT, sessions(6))
    const s = await load()
    for (const c of sessions(4)) await s.dismissHomeContent('new', c.path)
    setFail = new Error('disk full')
    await expect(s.excludeAskedDir()).rejects.toThrow('disk full')
    expect(s.homeContentStore.ask).toEqual({ dir: 'agent-sessions', count: 4 })
    expect(s.homeContentStore.error).toContain('disk full')
    await s.dismissHomeContent('new', sessions(6)[4].path)
    expect(s.homeContentStore.ask).toEqual({ dir: 'agent-sessions', count: 5 })
  })

  it('stops asking about a directory the user keeps, across restart', async () => {
    candidates.set(ROOT, sessions(6))
    let s = await load()
    for (const c of sessions(4)) await s.dismissHomeContent('new', c.path)
    await s.keepAskedDir()
    expect(s.homeContentStore.ask).toBeNull()
    s = await restart()
    await s.dismissHomeContent('new', sessions(6)[4].path)
    expect(s.homeContentStore.ask).toBeNull()
    expect(paths(s.homeContentStore.newItems)).toContain(sessions(6)[5].path)
  })

  it('applies rules saved from settings immediately', async () => {
    candidates.set(ROOT, [candidate('stat/a.md'), candidate('project/r.md')])
    const s = await load()
    s.applyHomeDirRules({ exclude: [], include: ['stat'] })
    expect(paths(s.homeContentStore.newItems)).toEqual([candidate('stat/a.md').path])
  })

  it('does not carry one vault\'s rules into the next vault', async () => {
    const OTHER = '/fixture/other'
    candidates.set(ROOT, [candidate('stat/a.md')])
    candidates.set(OTHER, [candidate('stat/a.md', OTHER)])
    const s = await load()
    expect(s.homeContentStore.newItems).toEqual([])
    disposers.splice(0).forEach(dispose => dispose())
    settingsFail = new Error('no settings')
    disposers.push(s.installHomeContent(OTHER))
    await s.refreshHomeContent()
    expect(paths(s.homeContentStore.newItems)).toEqual([candidate('stat/a.md', OTHER).path])
  })

  it('treats a rule removed by hand as no rule on the next refresh', async () => {
    candidates.set(ROOT, [candidate('stat/a.md')])
    const s = await load()
    expect(s.homeContentStore.newItems).toEqual([])
    settings = {}
    await s.refreshHomeContent()
    expect(paths(s.homeContentStore.newItems)).toEqual([candidate('stat/a.md').path])
  })
})
