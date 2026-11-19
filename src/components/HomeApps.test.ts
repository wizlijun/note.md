// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mount, unmount, flushSync } from 'svelte'
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks'
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(async (..._args: any[]) => () => {}), dispatch: vi.fn(async (_pluginId: string, _command: string) => {}), settings: vi.fn(), save: vi.fn(async () => {}), data: undefined as any }))
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }))
vi.mock('@tauri-apps/plugin-store', () => ({ Store: { load: async () => ({ get: async () => mocks.data, set: async (_key: string, data: any) => { mocks.data = data }, save: mocks.save }) } }))
vi.mock('../lib/plugins/runtime.svelte', async importOriginal => ({ ...await importOriginal<typeof import('../lib/plugins/runtime.svelte')>(), dispatchPluginCommand: mocks.dispatch }))
vi.mock('../lib/settings.svelte', () => ({ getPluginScopedAll: () => ({}), pluginScopedVersion: { value: 0 } }))
vi.mock('../lib/sotvault.svelte', () => ({ sotvaultStore: { vaultRoot: '/vault' } }))
vi.mock('../lib/ui-state.svelte', () => ({ openSettings: mocks.settings }))
vi.mock('../lib/i18n/store.svelte', () => ({ i18n: { locale: 'en' }, t: (key: string, vars?: Record<string, unknown>) => `${key}${vars ? JSON.stringify(vars) : ''}` }))
import HomeApps from './HomeApps.svelte'
import { homeAppsStore } from '../lib/home-apps/store.svelte'
import { emptyHomeAppsData } from '../lib/home-apps/model'
import { en } from '../lib/i18n/en'
import { pluginRuntime, refreshPluginManifests, setPluginDispatcher } from '../lib/plugins/runtime.svelte'
import { launchPluginApp } from '../lib/plugins/app-launch'
let app: ReturnType<typeof mount> | undefined
const installed = [
  { id: 'a', name: 'Alpha', category: 'ai', enabled: true, capabilities: [], version: '1' },
  { id: 'b', name: 'Beta', category: 'record', enabled: false, capabilities: [], version: '1' },
]
const manifests = [{ id: 'a', name: 'Alpha', open_windows: { open: 'main' } }, { id: 'b', name: 'Beta' }]
async function settle() { await new Promise(r => setTimeout(r, 0)); flushSync() }
function button(text: string) { return [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === text)! }
beforeEach(() => {
  vi.clearAllMocks(); mocks.dispatch.mockReset().mockResolvedValue(undefined); pluginRuntime.manifests = []; pluginRuntime.ready = true; document.body.removeAttribute('tabindex'); document.body.innerHTML = ''; mocks.data = emptyHomeAppsData()
  Object.assign(homeAppsStore, { data: emptyHomeAppsData(), ready: false, busy: false, error: null })
  mocks.invoke.mockImplementation(async cmd => cmd === 'plugin_market_installed' ? installed : manifests)
  mockIPC((cmd, args) => mocks.invoke(cmd, args))
})
afterEach(async () => { if (app) await unmount(app); app = undefined; clearMocks(); vi.useRealTimers() })
it('loads installed and runtime catalogs before ranking and keeps all eight positions', async () => {
  let resolve!: (value: unknown) => void
  mocks.invoke.mockImplementation(async cmd => cmd === 'plugin_market_installed' ? installed : new Promise(r => { resolve = r }))
  app = mount(HomeApps, { target: document.body }); await settle()
  expect(homeAppsStore.data.snapshot.day).toBe('')
  resolve(manifests); await settle()
  expect(homeAppsStore.data.snapshot.day).not.toBe('')
  expect(document.querySelectorAll('[data-home-slot]')).toHaveLength(0)
  button('homeApps.edit').click(); await settle()
  expect(document.querySelectorAll('[data-home-slot]')).toHaveLength(8)
})
it('opens the installed directory, filters search/category and restores focus', async () => {
  app = mount(HomeApps, { target: document.body }); await settle()
  const opener = button('homeApps.allApps'); opener.focus(); opener.click(); await settle()
  expect(document.querySelector('[role="dialog"]')).toBeTruthy()
  const search = document.querySelector<HTMLInputElement>('input[type="search"]')!
  search.value = 'Beta'; search.dispatchEvent(new Event('input', { bubbles: true })); await settle()
  expect(document.querySelector('[data-app-id="a"]')).toBeNull()
  expect(document.querySelector('[data-app-id="b"]')).toBeTruthy()
  button('homeApps.close').click(); await settle()
  expect(document.activeElement).toBe(opener)
})
it('pins to an explicit slot, explains disabled entries and moves without shifting other pins', async () => {
  mocks.data.pins[0] = 'b'; mocks.data.pins[3] = 'a'
  app = mount(HomeApps, { target: document.body }); await settle()
  document.querySelector<HTMLButtonElement>('[data-home-slot="0"] button')!.click(); await settle()
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('homeApps.disabled')
  button('homeApps.close').click(); await settle()
  button('homeApps.edit').click(); await settle()
  document.querySelector<HTMLButtonElement>('[data-home-slot="3"] [data-move]')!.click(); await settle()
  document.querySelector<HTMLButtonElement>('[data-target-slot="0"]')!.click(); await settle()
  expect(homeAppsStore.data.pins.slice(0, 4)).toEqual(['a', null, null, 'b'])
})
it('reports failed catalog reads without pruning pins and retries', async () => {
  mocks.data.pins[0] = 'b'; mocks.invoke.mockRejectedValueOnce(new Error('offline'))
  app = mount(HomeApps, { target: document.body }); await settle()
  expect(homeAppsStore.data.pins[0]).toBe('b')
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('offline')
  button('homeApps.retry').click(); await settle()
  expect(document.querySelector('[role="alert"]')).toBeNull()
})
it('ignores responses after unmount', async () => {
  let resolve!: (value: unknown) => void
  mocks.invoke.mockImplementation(async cmd => cmd === 'plugin_market_installed' ? new Promise(r => { resolve = r }) : manifests)
  app = mount(HomeApps, { target: document.body }); await settle()
  await unmount(app); app = undefined; resolve([]); await settle()
  expect(homeAppsStore.data.snapshot.day).toBe('')
})
it('pins only after choosing an exact free position and keeps failed saves explainable', async () => {
  app = mount(HomeApps, { target: document.body }); await settle()
  button('homeApps.allApps').click(); await settle()
  document.querySelector<HTMLButtonElement>('[data-app-id="a"]')!.click(); await settle()
  button('homeApps.pin').click(); await settle()
  mocks.save.mockRejectedValueOnce(new Error('disk full'))
  document.querySelector<HTMLButtonElement>('[data-target-slot="6"]')!.click(); await settle()
  expect(homeAppsStore.data.pins[6]).toBeNull()
  expect(document.querySelectorAll('[role="alert"]')).toHaveLength(1)
  expect(document.body.textContent).toContain('disk full')
  expect(document.body.textContent).not.toContain('homeApps.saved')
  document.querySelector<HTMLButtonElement>('[data-target-slot="6"]')!.click(); await settle()
  expect(homeAppsStore.data.pins[6]).toBe('a')
  expect(document.body.textContent).toContain('homeApps.saved')
})
it('lets an automatic app swap with a fixed app using the keyboard position controls', async () => {
  const date = new Date(); const day = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`
  mocks.data.pins[0] = 'b'; mocks.data.snapshot = { day, ids: ['a'] }
  app = mount(HomeApps, { target: document.body }); await settle()
  button('homeApps.edit').click(); await settle()
  document.querySelector<HTMLButtonElement>('[data-home-slot="1"] [data-move]')!.click(); await settle()
  const target = document.querySelector<HTMLButtonElement>('[data-target-slot="0"]')!
  expect(target.disabled).toBe(false); target.click(); await settle()
  expect(homeAppsStore.data.pins.slice(0, 2)).toEqual(['a', 'b'])
})
it('moves through drag/drop atomically and supports context menu keyboard navigation', async () => {
  mocks.data.pins[0] = 'a'; mocks.data.pins[3] = 'b'
  app = mount(HomeApps, { target: document.body }); await settle()
  const tile = document.querySelector<HTMLButtonElement>('[data-home-slot="0"] button')!
  tile.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 })); await settle()
  const menu = document.querySelector('.menu-panel')!
  expect(document.activeElement).toBe(menu.querySelector('button'))
  menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  expect(document.activeElement).toBe(menu.querySelectorAll('button')[1])
  menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await settle()
  expect(document.querySelector('[role="menu"]')).toBeNull()
  expect(document.activeElement).toBe(tile)
  button('homeApps.edit').click(); await settle()
  document.querySelector('[data-home-slot="0"]')!.dispatchEvent(new Event('dragstart', { bubbles: true }))
  document.querySelector('[data-home-slot="3"]')!.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true })); await settle()
  expect(homeAppsStore.data.pins.slice(0, 4)).toEqual(['b', null, null, 'a'])
})
it('offers declared window choices and plugin-specific settings without arbitrary commands', async () => {
  mocks.invoke.mockImplementation(async cmd => cmd === 'plugin_market_installed' ? installed : [
    { id: 'a', name: 'Alpha', settings: { tab_label: 'Alpha', schema: [] }, open_windows: { first: 'main', second: 'other' }, menus: [{ command: 'first', label: 'First window' }, { command: 'second', label: 'Second window', enabled_when: 'false' }, { command: 'erase', label: 'Erase' }] },
  ])
  app = mount(HomeApps, { target: document.body }); await settle()
  button('homeApps.allApps').click(); await settle()
  document.querySelector<HTMLButtonElement>('[data-app-id="a"]')!.click(); await settle()
  expect(mocks.dispatch).not.toHaveBeenCalled()
  const first = document.querySelector<HTMLButtonElement>('[data-app-command="first"]')!
  const second = document.querySelector<HTMLButtonElement>('[data-app-command="second"]')!
  expect(first).toBeTruthy(); expect(second.disabled).toBe(true)
  expect(document.querySelector('[data-app-command="erase"]')).toBeNull()
  button('homeApps.configure').click(); await settle()
  expect(mocks.settings).toHaveBeenCalledWith('a')
})
it('keeps full pin capacity and does not permit a ninth fixed app', async () => {
  const items = Array.from({ length: 9 }, (_, n) => ({ ...installed[0], id: `p${n}`, name: `Plugin ${n}` }))
  mocks.data.pins = items.slice(0,8).map(item => item.id)
  mocks.invoke.mockImplementation(async cmd => cmd === 'plugin_market_installed' ? items : items.map(item => ({ id: item.id, name: item.name })))
  app = mount(HomeApps, { target: document.body }); await settle()
  button('homeApps.allApps').click(); await settle()
  document.querySelector<HTMLButtonElement>('[data-app-id="p8"]')!.click(); await settle()
  button('homeApps.pin').click(); await settle()
  expect(document.body.textContent).toContain('homeApps.full')
  expect([...document.querySelectorAll<HTMLButtonElement>('[data-target-slot]')].every(b => b.disabled)).toBe(true)
  expect(homeAppsStore.data.pins).toHaveLength(8)
})
it('uses the newest refresh and ignores a slower previous catalog', async () => {
  let resolve!: (value: unknown) => void
  mocks.data.pins[0] = 'b'
  mocks.invoke.mockImplementation(async cmd => cmd === 'plugin_market_installed' ? new Promise(r => { resolve = r }) : manifests)
  app = mount(HomeApps, { target: document.body }); await settle()
  mocks.invoke.mockImplementation(async cmd => cmd === 'plugin_market_installed' ? installed : manifests)
  mocks.listen.mock.calls[0][1]({ payload: {} }); await settle()
  resolve([]); await settle()
  expect(homeAppsStore.data.pins[0]).toBe('b')
  button('homeApps.allApps').click(); await settle()
  expect(document.querySelector('[data-app-id="a"]')).toBeTruthy()
})
it('keeps positions while staying on home across midnight and ranks only on the next mount', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(2026, 10, 19, 23, 59, 50))
  mocks.data.snapshot = { day: '2026-11-19', ids: ['a', 'b'] }
  mocks.data.usage = { a: { days: { '2026-11-19': 1 }, lastUsed: Date.now()-1000 }, b: { days: { '2026-11-19': 8 }, lastUsed: Date.now() } }
  mocks.invoke.mockImplementation(async cmd => cmd === 'plugin_market_installed' ? installed.map(item => ({ ...item, enabled: true })) : manifests)
  app = mount(HomeApps, { target: document.body }); await settle()
  expect(homeAppsStore.data.snapshot.ids).toEqual(['a', 'b'])
  vi.setSystemTime(new Date(2026, 10, 20, 0, 0, 10))
  mocks.listen.mock.calls[0][1]({ payload: {} }); await settle()
  expect(homeAppsStore.data.snapshot).toEqual({ day: '2026-11-19', ids: ['a', 'b'] })
  await unmount(app); app = undefined
  app = mount(HomeApps, { target: document.body }); await settle()
  expect(homeAppsStore.data.snapshot).toEqual({ day: '2026-11-20', ids: ['b', 'a'] })
})
it('does not freeze a daily snapshot before the dispatcher and startup runtime are ready', async () => {
  pluginRuntime.ready = false
  mocks.invoke.mockImplementation(async cmd => cmd === 'plugin_market_installed' ? installed : [])
  app = mount(HomeApps, { target: document.body }); await settle()
  expect(homeAppsStore.data.snapshot.day).toBe('')
  expect(document.body.textContent).toContain('homeApps.starting')
  pluginRuntime.ready = true
  mocks.invoke.mockImplementation(async cmd => cmd === 'plugin_market_installed' ? installed : manifests)
  mocks.listen.mock.calls[0][1]({ payload: {} }); await settle()
  expect(homeAppsStore.data.snapshot.day).not.toBe('')
})
it('filters the existing category groups independently of text search', async () => {
  app = mount(HomeApps, { target: document.body }); await settle()
  button('homeApps.allApps').click(); await settle()
  button('pluginCategory.record').click(); await settle()
  expect(document.querySelector('[data-app-id="a"]')).toBeNull()
  expect(document.querySelector('[data-app-id="b"]')).toBeTruthy()
  button('homeApps.all').click(); await settle()
  expect(document.querySelector('[data-app-id="a"]')).toBeTruthy()
})
it('dispatches a declared shortcut once and leaves command usage to the shared dispatcher', async () => {
  mocks.data.pins[0] = 'a'
  app = mount(HomeApps, { target: document.body }); await settle()
  document.querySelector<HTMLButtonElement>('[data-home-slot="0"] button')!.click(); await settle()
  expect(mocks.dispatch).toHaveBeenCalledExactlyOnceWith('a', 'open')
  expect(homeAppsStore.data.usage).toEqual({})
})
it('keeps a gated fixed shortcut at its position and does not count unavailable details', async () => {
  mocks.data.pins[6] = 'a'
  mocks.invoke.mockImplementation(async cmd => cmd === 'plugin_market_installed' ? installed : [{ ...manifests[0], available_when: 'false' }])
  app = mount(HomeApps, { target: document.body }); await settle()
  const tile = document.querySelector<HTMLButtonElement>('[data-home-slot="6"] button')!
  expect(tile.getAttribute('aria-disabled')).toBe('true'); expect(tile.disabled).toBe(false)
  tile.click(); await settle()
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('homeApps.contextUnavailable')
  expect(homeAppsStore.data.pins[6]).toBe('a')
  expect(homeAppsStore.data.usage).toEqual({})
  expect(mocks.dispatch).not.toHaveBeenCalled()
})
it('opens a selected declared detail window through the shared dispatcher', async () => {
  mocks.invoke.mockImplementation(async cmd => cmd === 'plugin_market_installed' ? installed : [{ ...manifests[0], open_windows: { first: 'main', second: 'other' } }])
  app = mount(HomeApps, { target: document.body }); await settle()
  button('homeApps.allApps').click(); await settle()
  document.querySelector<HTMLButtonElement>('[data-app-id="a"]')!.click(); await settle()
  document.querySelector<HTMLButtonElement>('[data-app-command="second"]')!.click(); await settle()
  expect(mocks.dispatch).toHaveBeenCalledExactlyOnceWith('a', 'second')
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})
it('restores the original tile after context-menu details or move closes with Escape', async () => {
  mocks.data.pins[0] = 'a'
  app = mount(HomeApps, { target: document.body }); await settle()
  const tile = document.querySelector<HTMLButtonElement>('[data-home-slot="0"] button')!
  for (const label of ['homeApps.details', 'homeApps.move']) {
    tile.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })); await settle()
    document.querySelector<HTMLButtonElement>('.home-context-menu button')!.parentElement!.querySelectorAll<HTMLButtonElement>('button').forEach(button => { if (button.textContent === label) button.click() })
    await settle()
    document.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await settle()
    expect(document.activeElement).toBe(tile)
  }
})
it('keeps focus in the dialog after placing or unpinning so Escape still closes it', async () => {
  app = mount(HomeApps, { target: document.body }); await settle()
  const opener = button('homeApps.allApps'); opener.focus(); opener.click(); await settle()
  document.querySelector<HTMLButtonElement>('[data-app-id="a"]')!.click(); await settle()
  button('homeApps.pin').click(); await settle()
  const target = document.querySelector<HTMLButtonElement>('[data-target-slot="2"]')!; target.focus(); target.click(); await settle()
  expect(document.activeElement?.tagName).toBe('H3')
  const unpin = button('homeApps.unpin'); unpin.focus(); unpin.click(); await settle()
  expect(document.activeElement?.tagName).toBe('H3')
  document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await settle()
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(document.activeElement).toBe(opener)
})
it('focuses direct tile/context details and direct move targets instead of the directory search', async () => {
  mocks.data.pins[0] = 'b'
  app = mount(HomeApps, { target: document.body }); await settle()
  const tile = document.querySelector<HTMLButtonElement>('[data-home-slot="0"] button')!
  tile.focus(); tile.click(); await settle()
  expect(document.activeElement).toBe(document.querySelector('.app-detail h3'))
  button('homeApps.close').click(); await settle()
  tile.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })); await settle()
  document.querySelector<HTMLButtonElement>('.home-context-menu button')!.click(); await settle()
  expect(document.activeElement).toBe(document.querySelector('.app-detail h3'))
  button('homeApps.close').click(); await settle()
  button('homeApps.edit').click(); await settle()
  document.querySelector<HTMLButtonElement>('[data-home-slot="0"] [data-move]')!.click(); await settle()
  expect(document.activeElement?.matches('[data-target-slot]:not(:disabled)')).toBe(true)
})
it('keeps loading and catalog failure distinct from a successfully empty installed directory', async () => {
  let reject!: (error: unknown) => void
  mocks.invoke.mockImplementation(async cmd => cmd === 'plugin_market_installed' ? new Promise((_resolve, fail) => { reject = fail }) : manifests)
  app = mount(HomeApps, { target: document.body }); await settle()
  button('homeApps.allApps').click(); await settle()
  const dialog = document.querySelector('[role="dialog"]')!
  expect(dialog.textContent).toContain('homeApps.loading')
  expect(dialog.textContent).not.toContain('homeApps.empty')
  reject(new Error('catalog offline')); await settle()
  expect(dialog.textContent).toContain('catalog offline')
  expect(dialog.textContent).not.toContain('homeApps.empty')
  mocks.invoke.mockImplementation(async () => [])
  button('homeApps.retry').click(); await settle()
  expect(dialog.textContent).toContain('homeApps.empty')
})
it('shows a read-only usage path for the official PDF exporter without running export', async () => {
  const item = { ...installed[0], id: 'notemd.md2pdf', name: 'Export to PDF' }
  mocks.invoke.mockImplementation(async cmd => cmd === 'plugin_market_installed' ? [item] : [{ ...manifests[0], id: item.id, name: item.name, open_windows: {}, menus: [{ location: 'file', submenu: 'import-export', command: 'export', label: 'Export to PDF…' }] }])
  app = mount(HomeApps, { target: document.body }); await settle()
  button('homeApps.allApps').click(); await settle()
  document.querySelector<HTMLButtonElement>('[data-app-id="notemd.md2pdf"]')!.click(); await settle()
  expect(document.querySelector('.app-detail')?.textContent).toContain('homeApps.pdfGuide')
  expect(en['homeApps.pdfGuide']).toContain('Plugins → Import & Export → Export to PDF')
  expect(mocks.dispatch).not.toHaveBeenCalled()
  expect(document.querySelector('[data-app-command="export"]')).toBeNull()
})
it('restores dialog focus after a delayed failed position save or unpin', async () => {
  document.body.tabIndex = -1
  mocks.data.pins[0] = 'a'
  app = mount(HomeApps, { target: document.body }); await settle()
  button('homeApps.allApps').focus(); button('homeApps.allApps').click(); await settle()
  document.querySelector<HTMLButtonElement>('[data-app-id="a"]')!.click(); await settle()
  button('homeApps.move').click(); await settle()
  let reject!: (error: unknown) => void
  mocks.save.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
  const target = document.querySelector<HTMLButtonElement>('[data-target-slot="2"]')!; target.focus(); target.click(); await settle()
  expect(target.disabled).toBe(true)
  document.body.focus(); reject(new Error('delayed disk failure')); await settle()
  expect(document.activeElement).toBe(document.querySelector('.app-detail h3'))
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('delayed disk failure')
  expect(homeAppsStore.data.pins[0]).toBe('a')
  mocks.save.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
  const unpin = button('homeApps.unpin'); unpin.focus(); unpin.click(); await settle()
  expect(unpin.disabled).toBe(true)
  document.body.focus(); reject(new Error('delayed unpin failure')); await settle()
  expect(document.activeElement).toBe(document.querySelector('.app-detail h3'))
  document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await settle()
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})
it('recovers a failed initial App runtime read so the shared dispatcher can really open the home shortcut', async () => {
  mocks.invoke.mockRejectedValueOnce(new Error('initial App runtime read failed'))
  await expect(refreshPluginManifests()).rejects.toThrow('initial App runtime read failed')
  expect(pluginRuntime.manifests).toEqual([])
  const opened = vi.fn(async () => {})
  setPluginDispatcher(async (id, command) => {
    // Same live-registry lookup and launch helper as App.svelte's dispatcher.
    if (!pluginRuntime.manifests.find(manifest => manifest.id === id)) return
    await launchPluginApp(id, command, {
      manifests: () => pluginRuntime.manifests,
      context: () => ({ currentTab: null, settings: {}, vaultConfigured: true }),
      openWindow: opened, recordUse: async () => {}, reportUsageError: vi.fn(), fileView: {} as any,
    })
  })
  const actual = await vi.importActual<typeof import('../lib/plugins/runtime.svelte')>('../lib/plugins/runtime.svelte')
  mocks.dispatch.mockImplementation(actual.dispatchPluginCommand)
  mocks.data.pins[0] = 'a'
  app = mount(HomeApps, { target: document.body }); await settle()
  document.querySelector<HTMLButtonElement>('[data-home-slot="0"] button')!.click(); await settle()
  expect(opened).toHaveBeenCalledExactlyOnceWith('a', 'main')
})
it('tracks shared runtime removal and updates immediately without relying on its own catalog reload', async () => {
  mocks.data.pins[0] = 'a'
  app = mount(HomeApps, { target: document.body }); await settle()
  const tile = document.querySelector<HTMLButtonElement>('[data-home-slot="0"] button')!
  expect(tile.getAttribute('aria-disabled')).toBe('false')
  mocks.invoke.mockImplementation(async cmd => cmd === 'get_plugin_manifests' ? [] : installed)
  await refreshPluginManifests(); await settle()
  expect(tile.getAttribute('aria-disabled')).toBe('true')
  tile.click(); await settle()
  expect(document.querySelector('.app-detail')?.textContent).toContain('homeApps.unavailable')
  expect(mocks.dispatch).not.toHaveBeenCalled()
  button('homeApps.close').click(); await settle()
  mocks.invoke.mockImplementation(async cmd => cmd === 'get_plugin_manifests' ? [{ ...manifests[0], name: 'Updated Alpha', version: '2', binary: '', host_capabilities: [], open_windows: { show: 'new-main' } }] : installed)
  await refreshPluginManifests(); await settle()
  expect(tile.getAttribute('aria-disabled')).toBe('false')
  tile.click(); await settle()
  expect(mocks.dispatch).toHaveBeenCalledExactlyOnceWith('a', 'show')
})
