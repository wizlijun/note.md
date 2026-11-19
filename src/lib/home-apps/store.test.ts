import { beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyHomeAppsData, pinApp } from './model'

const mocks = vi.hoisted(() => ({ load: vi.fn(), get: vi.fn(), set: vi.fn(), save: vi.fn() }))
vi.mock('@tauri-apps/plugin-store', () => ({ Store: { load: mocks.load } }))

beforeEach(() => {
  vi.resetModules()
  for (const mock of Object.values(mocks)) mock.mockReset()
  mocks.load.mockResolvedValue({ get: mocks.get, set: mocks.set, save: mocks.save })
  mocks.set.mockResolvedValue(undefined)
  mocks.save.mockResolvedValue(undefined)
})

describe('home apps persisted store', () => {
  it('shares hydration and serializes concurrent load, pin and use without losing changes', async () => {
    let resolveRead!: (value: unknown) => void
    mocks.get.mockReturnValue(new Promise((resolve) => { resolveRead = resolve }))
    const store = await import('./store.svelte')
    const loading = store.loadHomeApps()
    const pinning = store.pinHomeApp('new', 3)
    const using = store.recordHomeAppUse('used', new Date(2026, 10, 19).getTime())
    await vi.waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(1))
    expect(mocks.set).not.toHaveBeenCalled()
    resolveRead(pinApp(emptyHomeAppsData(), 'existing', 5))
    await Promise.all([loading, pinning, using])
    expect(store.homeAppsStore.ready).toBe(true)
    expect(store.homeAppsStore.busy).toBe(false)
    expect(store.homeAppsStore.data.pins[3]).toBe('new')
    expect(store.homeAppsStore.data.pins[5]).toBe('existing')
    expect(store.homeAppsStore.data.usage.used.lastUsed).toBe(new Date(2026, 10, 19).getTime())
    expect(mocks.load).toHaveBeenCalledTimes(1)
    expect(mocks.load).toHaveBeenCalledWith('home-apps.json', { autoSave: false, defaults: {} })
    expect(mocks.set.mock.calls.at(-1)?.[0]).toBe('data')
    expect(mocks.save).toHaveBeenCalledTimes(2)
  })

  it('never writes after failed reads and supports explicit retry', async () => {
    mocks.get.mockRejectedValueOnce(new Error('read failed')).mockResolvedValueOnce(pinApp(emptyHomeAppsData(), 'saved', 6))
    const store = await import('./store.svelte')
    await expect(store.loadHomeApps()).rejects.toThrow('read failed')
    expect(store.homeAppsStore.ready).toBe(false)
    expect(store.homeAppsStore.error).toBe('read failed')
    expect(mocks.set).not.toHaveBeenCalled()
    await store.loadHomeApps()
    expect(store.homeAppsStore.data.pins[6]).toBe('saved')
    expect(store.homeAppsStore.error).toBeNull()
  })

  it('rejects all mutations waiting on a failed hydration without overwriting disk', async () => {
    mocks.get.mockRejectedValue(new Error('unreadable'))
    const store = await import('./store.svelte')
    const outcomes = await Promise.allSettled([store.pinHomeApp('a', 0), store.recordHomeAppUse('b')])
    expect(outcomes.every((outcome) => outcome.status === 'rejected')).toBe(true)
    expect(mocks.set).not.toHaveBeenCalled()
    expect(store.homeAppsStore.ready).toBe(false)
    expect(store.homeAppsStore.busy).toBe(false)
  })

  it('publishes only saved state, rejects failed saves, and permits retry', async () => {
    mocks.get.mockResolvedValue(emptyHomeAppsData())
    const store = await import('./store.svelte')
    await store.loadHomeApps()
    let rejectSave!: (reason: Error) => void
    mocks.save.mockReturnValueOnce(new Promise((_, reject) => { rejectSave = reject }))
    const operation = store.pinHomeApp('a', 2)
    const rejection = expect(operation).rejects.toThrow('disk full')
    await vi.waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1))
    expect(store.homeAppsStore.busy).toBe(true)
    expect(store.homeAppsStore.data.pins[2]).toBeNull()
    rejectSave(new Error('disk full'))
    await rejection
    expect(store.homeAppsStore.data.pins[2]).toBeNull()
    expect(store.homeAppsStore.error).toBe('disk full')
    await store.pinHomeApp('b', 4)
    expect(store.homeAppsStore.data.pins[2]).toBeNull()
    expect(store.homeAppsStore.data.pins[4]).toBe('b')
    expect(mocks.set.mock.calls.at(-1)?.[1].pins[2]).toBeNull()
    expect(store.homeAppsStore.error).toBeNull()
  })

  it('persists daily snapshots and atomic auto swaps, and skips unchanged writes', async () => {
    mocks.get.mockResolvedValue(pinApp(emptyHomeAppsData(), 'fixed', 4))
    const store = await import('./store.svelte')
    const now = new Date(2026, 10, 19).getTime()
    await store.recordHomeAppUse('auto', now)
    await store.refreshHomeAppRanking(['auto'], now)
    expect(store.homeAppsStore.data.snapshot.ids).toEqual(['auto'])
    const saves = mocks.save.mock.calls.length
    await store.refreshHomeAppRanking(['auto'], now + 1_000)
    expect(mocks.save).toHaveBeenCalledTimes(saves)
    await store.moveHomeApp('auto', 4, 0)
    expect(store.homeAppsStore.data.pins[0]).toBe('fixed')
    expect(store.homeAppsStore.data.pins[4]).toBe('auto')
    expect(mocks.save).toHaveBeenCalledTimes(saves + 1)
    await store.unpinHomeApp('fixed')
    await store.reconcileHomeApps(['fixed'])
    expect(store.homeAppsStore.data.pins.every((id) => id === null)).toBe(true)
    expect(store.homeAppsStore.data.usage.auto).toBeUndefined()
  })

  it('restores saved pins, usage and snapshot after a fresh module initialization', async () => {
    let disk: unknown = undefined
    let staged: unknown
    mocks.get.mockImplementation(async () => disk)
    mocks.set.mockImplementation(async (_key: string, value: unknown) => { staged = JSON.parse(JSON.stringify(value)) })
    mocks.save.mockImplementation(async () => { disk = staged })
    const first = await import('./store.svelte')
    const now = new Date(2026, 10, 19, 12).getTime()
    await first.pinHomeApp('fixed', 7)
    await first.recordHomeAppUse('auto', now)
    await first.refreshHomeAppRanking(['auto'], now)
    const expected = JSON.parse(JSON.stringify(first.homeAppsStore.data))
    vi.resetModules()
    const restarted = await import('./store.svelte')
    await restarted.loadHomeApps()
    expect(restarted.homeAppsStore.data).toEqual(expected)
    expect(restarted.homeAppsStore.data).not.toBe(first.homeAppsStore.data)
  })

  it('recovers from set errors without publishing changes or poisoning the write queue', async () => {
    mocks.get.mockResolvedValue(emptyHomeAppsData())
    mocks.set.mockRejectedValueOnce(new Error('set failed')).mockResolvedValue(undefined)
    const store = await import('./store.svelte')
    await expect(store.pinHomeApp('a', 0)).rejects.toThrow('set failed')
    expect(store.homeAppsStore.data.pins[0]).toBeNull()
    expect(mocks.save).not.toHaveBeenCalled()
    await store.pinHomeApp('b', 1)
    expect(store.homeAppsStore.data.pins).toEqual([null, 'b', null, null, null, null, null, null])
    expect(store.homeAppsStore.busy).toBe(false)
  })
})
