// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WatchEvent } from '@tauri-apps/plugin-fs'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), watch: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }))
vi.mock('@tauri-apps/api/path', () => ({ homeDir: async () => '/Users/test' }))
vi.mock('@tauri-apps/plugin-fs', () => ({ watchImmediate: mocks.watch }))
import { affectsLatestFiles, installLatestMenu } from './latest-menu'

let cleanup: (() => void)[] = []
let paths: string[]
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
const event = (paths: string[]): WatchEvent => ({ type: 'any', paths, attrs: {} })
const publishes = () => mocks.invoke.mock.calls.filter(([cmd]) => cmd === 'update_latest_menu')
const scans = () => mocks.invoke.mock.calls.filter(([cmd]) => cmd === 'latest_vault_files')

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  paths = ['/Users/test/vault/deep/new.md']
  mocks.invoke.mockImplementation(async (cmd) => cmd === 'latest_vault_files' ? paths : undefined)
  mocks.watch.mockResolvedValue(vi.fn())
  mocks.listen.mockResolvedValue(vi.fn())
})
afterEach(() => {
  cleanup.forEach((fn) => fn())
  cleanup = []
  vi.useRealTimers()
})

describe('latest menu refresh', () => {
  it('scans the vault, publishes path-stable IDs and restores cached items after menu rebuild', async () => {
    cleanup.push(installLatestMenu('/Users/test/vault'))
    await flush()
    expect(scans()).toEqual([['latest_vault_files', { vaultRoot: '/Users/test/vault' }]])
    const expected = { items: [{ path: paths[0], label: 'new.md — ~/vault/deep' }] }
    expect(publishes().at(-1)?.[1]).toEqual(expected)
    mocks.listen.mock.calls[0][1]()
    await flush()
    expect(publishes().at(-1)?.[1]).toEqual(expected)
    expect(scans()).toHaveLength(1)
  })

  it('coalesces recursive file changes and updates after delete/rename', async () => {
    cleanup.push(installLatestMenu('/vault'))
    await flush()
    expect(mocks.watch).toHaveBeenCalledWith('/vault', expect.any(Function), { recursive: true })
    paths = ['/vault/renamed/note.md']
    const changed = mocks.watch.mock.calls[0][1]
    for (let i = 0; i < 20; i++) changed(event(['/vault/old-dir']))
    await vi.advanceTimersByTimeAsync(1000)
    expect(scans()).toHaveLength(2)
    expect(publishes().at(-1)?.[1].items[0].path).toBe(paths[0])
    paths = []
    changed(event(['/vault/renamed/note.md']))
    await vi.advanceTimersByTimeAsync(1000)
    expect(publishes().at(-1)?.[1]).toEqual({ items: [] })
  })

  it('drops an old vault scan that finishes after switching vaults', async () => {
    let finish!: (paths: string[]) => void
    mocks.invoke.mockImplementation((cmd, args) => {
      if (cmd !== 'latest_vault_files') return Promise.resolve()
      if (args.vaultRoot === '/old') return new Promise((resolve) => { finish = resolve })
      return Promise.resolve(['/new/a.md'])
    })
    const stop = installLatestMenu('/old')
    await flush()
    stop()
    cleanup.push(installLatestMenu('/new'))
    await flush()
    finish(['/old/wrong.md'])
    await flush()
    expect(publishes().at(-1)?.[1].items[0].path).toBe('/new/a.md')
    expect(publishes().some(([, args]) => args.items.some((item: { path: string }) => item.path === '/old/wrong.md'))).toBe(false)
  })

  it('never overlaps scans and catches changes arriving during a scan', async () => {
    let finish!: (paths: string[]) => void
    mocks.invoke.mockImplementation((cmd) => cmd === 'latest_vault_files'
      ? new Promise((resolve) => { finish = resolve }) : Promise.resolve())
    cleanup.push(installLatestMenu('/vault'))
    await flush()
    mocks.watch.mock.calls[0][1](event(['/vault/new.md']))
    await vi.advanceTimersByTimeAsync(1000)
    expect(scans()).toHaveLength(1)
    finish(['/vault/old.md'])
    await flush()
    await vi.advanceTimersByTimeAsync(1000)
    expect(scans()).toHaveLength(2)
    finish(['/vault/new.md'])
    await flush()
    expect(publishes().at(-1)?.[1].items[0].path).toBe('/vault/new.md')
  })

  it('cleans up listeners that finish installing after disposal', async () => {
    let finishWatch!: (fn: () => void) => void
    let finishListen!: (fn: () => void) => void
    mocks.watch.mockReturnValue(new Promise((resolve) => { finishWatch = resolve }))
    mocks.listen.mockReturnValue(new Promise((resolve) => { finishListen = resolve }))
    const stop = installLatestMenu('/vault')
    stop()
    const unwatch = vi.fn(), unlisten = vi.fn()
    finishWatch(unwatch)
    finishListen(unlisten)
    await flush()
    expect(unwatch).toHaveBeenCalledOnce()
    expect(unlisten).toHaveBeenCalledOnce()
    expect(scans()).toHaveLength(0)
  })

  it('clears stale results when the vault becomes unavailable', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    cleanup.push(installLatestMenu('/vault'))
    await flush()
    mocks.invoke.mockImplementation(async (cmd) => {
      if (cmd === 'latest_vault_files') throw new Error('Vault unavailable')
    })
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(1000)
    expect(publishes().at(-1)?.[1]).toEqual({ items: [] })
    warning.mockRestore()
  })

  it('clears the menu without scanning when no vault is configured', async () => {
    cleanup.push(installLatestMenu(null))
    await flush()
    expect(publishes().at(-1)?.[1]).toEqual({ items: [] })
    expect(scans()).toHaveLength(0)
    expect(mocks.watch).not.toHaveBeenCalled()
  })
})

it('ignores internal/access events but includes hidden user folders, directory moves and uppercase MD', () => {
  expect(affectsLatestFiles(event(['/vault/.notemd/a.md', '/vault/.git/index']), '/vault')).toBe(false)
  expect(affectsLatestFiles(event(['/other/note.md']), '/vault')).toBe(false)
  expect(affectsLatestFiles(event(['/vault/.notes/a.MD']), '/vault')).toBe(true)
  expect(affectsLatestFiles(event(['/vault/renamed.folder']), '/vault')).toBe(true)
  expect(affectsLatestFiles({ ...event(['/vault/a.md']), type: { access: { kind: 'any' } } }, '/vault')).toBe(false)
})
