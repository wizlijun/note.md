// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mount, unmount, flushSync } from 'svelte'
const mocks = vi.hoisted(() => ({ platform: vi.fn(async () => 'ios'), note: vi.fn(), canvas: vi.fn(async () => {}), pick: vi.fn(async () => null), open: vi.fn(async () => {}), error: vi.fn() }))
vi.mock('../lib/platform.svelte', () => ({ platform: mocks.platform }))
vi.mock('../lib/tabs.svelte', () => ({ newFile: mocks.note, newCanvas: mocks.canvas, openFile: mocks.open }))
vi.mock('../lib/dialogs', () => ({ pickOpenFile: mocks.pick, showError: mocks.error }))
vi.mock('../lib/i18n/store.svelte', () => ({ i18n: { locale: 'en' }, t: (key: string) => key }))
import EmptyState from './EmptyState.svelte'
let app: ReturnType<typeof mount> | undefined
async function settle() { await new Promise(r => setTimeout(r, 0)); flushSync() }
beforeEach(() => { vi.clearAllMocks(); document.body.innerHTML = '' })
afterEach(async () => { if (app) await unmount(app); app = undefined })
it('places creation icon buttons first and omits desktop apps on iOS', async () => {
  app = mount(EmptyState, { target: document.body }); await settle()
  expect(document.querySelector('.home-grid')).toBeTruthy()
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('.home-create button')]
  expect(buttons.map(b => b.textContent?.trim())).toEqual(['homeApps.newNote', 'homeApps.newCanvas', 'homeApps.openFile'])
  expect(buttons.every(b => b.querySelector('svg'))).toBe(true)
  expect(document.querySelector('.home-apps')).toBeNull()
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
