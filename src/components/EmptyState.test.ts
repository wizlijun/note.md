// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mount, unmount, flushSync } from 'svelte'
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks'
const mocks = vi.hoisted(() => ({ platform: vi.fn(async () => 'ios'), note: vi.fn(), canvas: vi.fn(async () => {}), pick: vi.fn(async () => null), open: vi.fn(async () => {}), error: vi.fn(), refreshContent: vi.fn() }))
vi.mock('../lib/platform.svelte', () => ({ platform: mocks.platform }))
vi.mock('../lib/tabs.svelte', () => ({ newFile: mocks.note, newCanvas: mocks.canvas, openFile: mocks.open }))
vi.mock('../lib/dialogs', () => ({ pickOpenFile: mocks.pick, showError: mocks.error }))
vi.mock('../lib/i18n/store.svelte', () => ({ i18n: { locale: 'en' }, t: (key: string) => key }))
vi.mock('../lib/home-content/store.svelte', () => ({ homeContentStore: { newItems: [], continueItems: [], ready: true, busy: false, error: null, skipped: 0 }, dismissHomeContent: vi.fn(), refreshHomeContent: mocks.refreshContent }))
import EmptyState from './EmptyState.svelte'
let app: ReturnType<typeof mount> | undefined
async function settle() { await new Promise(r => setTimeout(r, 0)); flushSync() }
const commands: string[] = []
beforeEach(() => {
  vi.clearAllMocks(); commands.length = 0; document.body.innerHTML = ''
  mockIPC((command) => {
    commands.push(command)
    if (command === 'plugin:store|load') return 1
    if (command === 'plugin:store|get') return [undefined, false]
    if (command === 'get_plugin_manifests' || command === 'plugin_market_installed') return []
    if (command === 'vault_inspect') return { root: null, homeDir: '/fixture', accessible: false, git: { state: 'none' } }
    return null
  }, { shouldMockEvents: true })
})
afterEach(async () => { if (app) await unmount(app); app = undefined; clearMocks() })
it('orders desktop favorites, preview lists, AI layout and compact status/settings without requesting AI content', async () => {
  mocks.platform.mockResolvedValueOnce('macos')
  app = mount(EmptyState, { target: document.body }); await settle(); await settle()
  expect(document.querySelector('.home-create')).toBeNull()
  const sections = [...document.querySelector('.welcome')!.children].map(el => el.classList[0])
  expect(sections).toEqual(['identity', 'home-apps', 'home-content', 'home-ai', 'home-footer'])
  expect(document.querySelectorAll('.home-functions-grid > div')).toHaveLength(12)
  expect(document.querySelector('.home-footer .vault-overview.compact')).toBeTruthy()
  expect(document.querySelector('.home-footer .settings-button')).toBeTruthy()
  expect(document.querySelector('.home-ai')?.textContent).toContain('homeAi.empty')
  expect(document.querySelector('.home-ai button')).toBeNull()
  expect(commands.some(command => /smart_lookup|agent|completion|suggestion/.test(command))).toBe(false)
  document.querySelector('.home-ai')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  document.querySelector('.home-footer')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  expect(mocks.note).not.toHaveBeenCalled()
})
it('places creation icon buttons first and omits desktop apps on iOS', async () => {
  app = mount(EmptyState, { target: document.body }); await settle()
  expect(document.querySelector('.home-grid')).toBeTruthy()
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('.home-create button')]
  expect(buttons.map(b => b.textContent?.trim())).toEqual(['homeApps.newNote', 'homeApps.newCanvas', 'homeApps.openFile'])
  expect(buttons.every(b => b.querySelector('svg'))).toBe(true)
  expect(document.querySelector('.home-apps')).toBeNull()
  expect(document.querySelector('.home-content')).toBeNull()
  expect(mocks.refreshContent).not.toHaveBeenCalled()
  buttons[0].click(); expect(mocks.note).toHaveBeenCalledOnce()
  buttons[0].dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); expect(mocks.note).toHaveBeenCalledOnce()
})
it('reports asynchronous open and creation failures', async () => {
  mocks.pick.mockRejectedValueOnce(new Error('picker failed')); mocks.note.mockRejectedValueOnce(new Error('new failed'))
  app = mount(EmptyState, { target: document.body }); await settle()
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('button')]
  buttons.find(b => b.textContent === 'homeApps.openFile')!.click(); await settle()
  buttons.find(b => b.textContent === 'homeApps.newNote')!.click(); await settle()
  expect(mocks.error).toHaveBeenCalledWith('Error: picker failed')
  expect(mocks.error).toHaveBeenCalledWith('Error: new failed')
})

it('does not create a note when the document-list background is double-clicked', async () => {
  app = mount(EmptyState, { target: document.body }); await settle()
  const region = document.createElement('div')
  region.className = 'home-content'
  const background = document.createElement('span')
  region.append(background); document.querySelector('.welcome')!.append(region)
  background.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  expect(mocks.note).not.toHaveBeenCalled()
  document.querySelector('.identity')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  expect(mocks.note).toHaveBeenCalledOnce()
})
