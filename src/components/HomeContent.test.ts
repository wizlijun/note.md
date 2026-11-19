// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mount, unmount, flushSync } from 'svelte'
const mocks = vi.hoisted(() => ({
  open: vi.fn(async (_path: string) => {}),
  dismiss: vi.fn(async (_kind: string, _path: string) => {}),
  refresh: vi.fn(async () => {}),
  store: { newItems: [] as Array<{ path: string; title: string; detail: string; at: number }>, continueItems: [] as Array<{ path: string; title: string; detail: string; at: number }>, ready: true, busy: false, error: null as string | null, skipped: 0 },
}))
vi.mock('../lib/tabs.svelte', () => ({ openFile: mocks.open }))
vi.mock('../lib/home-content/store.svelte', () => ({ homeContentStore: mocks.store, dismissHomeContent: mocks.dismiss, refreshHomeContent: mocks.refresh }))
vi.mock('../lib/i18n/store.svelte', async () => {
  const { en } = await import('../lib/i18n/en')
  return { i18n: { locale: 'en' }, t: (key: keyof typeof en, vars: Record<string, string> = {}) => en[key].replace(/\{(\w+)\}/g, (match, name) => vars[name] ?? match) }
})
import HomeContent from './HomeContent.svelte'
let app: ReturnType<typeof mount> | undefined
async function settle() { await new Promise(r => setTimeout(r, 0)); flushSync() }
const fresh = { path: '/vault/reports/new.md', title: 'New report', detail: 'reports', at: Date.UTC(2026, 10, 19, 12) }
const previous = { path: '/vault/notes/ongoing.md', title: 'Ongoing note', detail: 'notes', at: Date.UTC(2026, 10, 18, 12) }
function button(label: string) { return [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.getAttribute('aria-label') === label || b.textContent?.trim() === label)! }
beforeEach(() => {
  vi.clearAllMocks()
  mocks.open.mockReset().mockResolvedValue(undefined)
  mocks.dismiss.mockReset().mockResolvedValue(undefined)
  mocks.refresh.mockReset().mockResolvedValue(undefined)
  Object.assign(mocks.store, { newItems: [fresh], continueItems: [previous], ready: true, busy: false, error: null, skipped: 0 })
  document.body.innerHTML = ''
})
afterEach(async () => { if (app) await unmount(app); app = undefined })
it('renders independent new and continue lists with title, folder and date', async () => {
  app = mount(HomeContent, { target: document.body }); await settle()
  expect([...document.querySelectorAll('h2')].map(h => h.textContent)).toEqual(['New content', 'Continue reading'])
  expect(document.querySelector('[data-content-kind="new"] .content-title')?.textContent).toBe('New report')
  expect(document.querySelector('[data-content-kind="continue"] .content-detail')?.textContent).toBe('notes')
  expect(document.querySelector('.content-date')?.textContent).toBe('Nov 19')
  expect(document.querySelector('.content-open')?.getAttribute('title')).toBe(fresh.path)
  expect(document.querySelector('button button')).toBeNull()
})
it('opens an item and independently dismisses an item in its own list', async () => {
  app = mount(HomeContent, { target: document.body }); await settle()
  document.querySelector<HTMLButtonElement>('[data-content-kind="new"] .content-open')!.click(); await settle()
  expect(mocks.open).toHaveBeenCalledExactlyOnceWith(fresh.path)
  mocks.open.mockClear()
  button('Remove Ongoing note from this list').click(); await settle()
  expect(mocks.dismiss).toHaveBeenCalledExactlyOnceWith('continue', previous.path)
  expect(mocks.open).not.toHaveBeenCalled()
  button('Remove New report from this list').click(); await settle()
  expect(mocks.dismiss).toHaveBeenLastCalledWith('new', fresh.path)
})
it('keeps a failed dismissal explainable and permits retry without opening the file', async () => {
  mocks.dismiss.mockRejectedValueOnce(new Error('disk full'))
  app = mount(HomeContent, { target: document.body }); await settle()
  button('Remove New report from this list').click(); await settle()
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('disk full')
  expect(document.querySelector('[data-content-kind="new"]')).toBeTruthy()
  expect(mocks.open).not.toHaveBeenCalled()
  button('Remove New report from this list').click(); await settle()
  expect(mocks.dismiss).toHaveBeenCalledTimes(2)
  expect(document.querySelector('[role="alert"]')).toBeNull()
})
it('reports failed opens without dismissing any history', async () => {
  mocks.open.mockRejectedValueOnce(new Error('file missing'))
  app = mount(HomeContent, { target: document.body }); await settle()
  document.querySelector<HTMLButtonElement>('.content-open')!.click(); await settle()
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('file missing')
  expect(mocks.dismiss).not.toHaveBeenCalled()
})
it('shows a retry action when loading failed and reports retry errors', async () => {
  mocks.store.error = 'scan failed'
  mocks.refresh.mockRejectedValueOnce(new Error('still offline'))
  app = mount(HomeContent, { target: document.body }); await settle()
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('scan failed')
  button('Retry').click(); await settle()
  expect(mocks.refresh).toHaveBeenCalledOnce()
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('still offline')
})
it('shows separate empty states without presenting them during initial loading', async () => {
  mocks.store.newItems = []; mocks.store.continueItems = []
  mocks.store.ready = false; mocks.store.busy = true
  app = mount(HomeContent, { target: document.body }); await settle()
  expect(document.querySelectorAll('[role="status"]')).toHaveLength(2)
  expect(document.body.textContent).not.toContain('No new unread content.')
  await unmount(app); app = undefined
  mocks.store.ready = true; mocks.store.busy = false
  app = mount(HomeContent, { target: document.body }); await settle()
  expect(document.body.textContent).toContain('No new unread content.')
  expect(document.body.textContent).toContain('Documents you edit or spend time reading appear here.')
})
it('prevents duplicate actions while a dismissal is saving', async () => {
  let resolve!: () => void
  mocks.dismiss.mockImplementationOnce(() => new Promise<void>(r => { resolve = r }))
  app = mount(HomeContent, { target: document.body }); await settle()
  const dismiss = button('Remove New report from this list')
  dismiss.click(); dismiss.click(); await settle()
  expect(mocks.dismiss).toHaveBeenCalledOnce()
  expect(dismiss.disabled).toBe(true)
  resolve(); await settle()
  expect(dismiss.disabled).toBe(false)
})

it('warns when scanning skipped entries while preserving readable documents', async () => {
  mocks.store.skipped = 3
  app = mount(HomeContent, { target: document.body }); await settle()
  expect(document.querySelector('[role="status"]')?.textContent).toBe('3 items could not be read. This list may be incomplete.')
  expect(document.querySelector('[data-content-kind="new"] .content-title')?.textContent).toBe('New report')
})
