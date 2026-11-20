// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mount, unmount, flushSync } from 'svelte'
const mocks = vi.hoisted(() => ({
  open: vi.fn(async (_path: string) => {}),
  dismiss: vi.fn(async (_kind: string, _path: string) => {}),
  refresh: vi.fn(async () => {}),
  openSettings: vi.fn((_tab?: string) => {}),
  store: { newItems: [] as Array<{ path: string; title: string; detail: string; at: number; preview?: string }>, continueItems: [] as Array<{ path: string; title: string; detail: string; at: number; preview?: string }>, ready: true, busy: false, error: null as string | null, skipped: 0 },
}))
vi.mock('../lib/tabs.svelte', () => ({ openFile: mocks.open }))
vi.mock('../lib/home-content/store.svelte', () => ({
  homeContentStore: mocks.store, dismissHomeContent: mocks.dismiss, refreshHomeContent: mocks.refresh,
}))
vi.mock('../lib/ui-state.svelte', () => ({ openSettings: mocks.openSettings }))
vi.mock('../lib/i18n/store.svelte', async () => {
  const { en } = await import('../lib/i18n/en')
  return { i18n: { locale: 'en' }, t: (key: keyof typeof en, vars: Record<string, string> = {}) => en[key].replace(/\{(\w+)\}/g, (match, name) => vars[name] ?? match) }
})
import HomeContent from './HomeContent.svelte'
let app: ReturnType<typeof mount> | undefined
async function settle() { await new Promise(r => setTimeout(r, 0)); flushSync() }
const fresh = { path: '/vault/reports/new.md', title: 'New report', detail: 'reports', preview: 'The report explains the decisions and their supporting evidence.', at: Date.UTC(2026, 10, 19, 12) }
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
it('renders document titles, dates, real previews and full path tooltips', async () => {
  app = mount(HomeContent, { target: document.body }); await settle()
  expect([...document.querySelectorAll('h2')].map(h => h.textContent)).toEqual(['New content', 'Continue reading'])
  expect(document.querySelector('[data-content-kind="new"] .content-title')?.textContent).toBe('New report')
  expect(document.querySelector('[data-content-kind="continue"] .content-open')?.getAttribute('title')).toBe(previous.path)
  expect(document.querySelector('.content-date')?.textContent).toBe('Nov 19')
  expect(document.querySelector('.content-open')?.getAttribute('title')).toBe(fresh.path)
  expect(document.querySelector('button button')).toBeNull()
  expect(document.querySelector('[data-content-kind="new"] .content-preview')?.textContent).toBe(fresh.preview)
  expect(document.querySelector('[data-content-kind="continue"] .content-preview')?.textContent).toBe(previous.detail)
})
it('toggles each list independently and loads the next ten rows from the bottom', async () => {
  mocks.store.newItems = Array.from({ length: 35 }, (_, i) => ({ ...fresh, path: `/vault/new-${i}.md`, title: `New ${i}` }))
  mocks.store.continueItems = Array.from({ length: 21 }, (_, i) => ({ ...previous, path: `/vault/read-${i}.md`, title: `Read ${i}` }))
  app = mount(HomeContent, { target: document.body }); await settle()
  const rows = (kind: string) => document.querySelectorAll(`[data-content-kind="${kind}"]`).length
  const control = (selector: string, kind: string) => document.querySelector<HTMLButtonElement>(`${selector}[aria-controls="home-content-list-${kind}"]`)
  const toggle = (kind: string) => control('.content-more', kind)!
  const loadMore = (kind: string) => control('.content-load-more', kind)

  expect([rows('new'), rows('continue')]).toEqual([4, 4])
  expect(toggle('new').textContent?.trim()).toBe('More')
  expect(toggle('new').getAttribute('aria-expanded')).toBe('false')
  expect(loadMore('new')).toBeNull()
  toggle('new').click(); await settle()
  expect([rows('new'), rows('continue')]).toEqual([20, 4])
  expect(toggle('new').textContent?.trim()).toBe('Less')
  expect(toggle('new').getAttribute('aria-expanded')).toBe('true')
  expect(loadMore('new')?.previousElementSibling?.id).toBe('home-content-list-new')
  expect(loadMore('new')?.textContent?.trim()).toBe('Load more')

  loadMore('new')!.click(); await settle()
  expect([rows('new'), rows('continue')]).toEqual([30, 4])
  toggle('continue').click(); await settle()
  expect([rows('new'), rows('continue')]).toEqual([30, 20])
  loadMore('new')!.click(); await settle()
  expect([rows('new'), rows('continue')]).toEqual([35, 20])
  expect(loadMore('new')).toBeNull()
  loadMore('continue')!.click(); await settle()
  expect([rows('new'), rows('continue')]).toEqual([35, 21])
  expect(loadMore('continue')).toBeNull()

  toggle('new').click(); await settle()
  expect([rows('new'), rows('continue')]).toEqual([4, 21])
  expect(toggle('new').textContent?.trim()).toBe('More')
  toggle('new').click(); await settle()
  expect([rows('new'), rows('continue')]).toEqual([35, 21])
  button('Remove New 34 from this list').click(); await settle()
  expect(mocks.dismiss).toHaveBeenCalledExactlyOnceWith('new', '/vault/new-34.md')
  expect(mocks.open).not.toHaveBeenCalled()
})
it('opens the folder rules from the new-content heading', async () => {
  app = mount(HomeContent, { target: document.body }); await settle()
  button('Folder rules').click(); await settle()
  expect(mocks.openSettings).toHaveBeenCalledExactlyOnceWith('search')
})
it.each([0, 1, 4])('omits more when the list has %i rows', async count => {
  mocks.store.newItems = Array.from({ length: count }, (_, i) => ({ ...fresh, path: `/vault/new-${i}.md` }))
  app = mount(HomeContent, { target: document.body }); await settle()
  expect(document.querySelectorAll('[data-content-kind="new"]')).toHaveLength(count)
  expect(document.querySelector('[aria-controls="home-content-list-new"]')).toBeNull()
  expect(document.querySelector('.content-load-more')).toBeNull()
})
it('keeps a large catalog bounded and resets to four when home is reopened', async () => {
  mocks.store.newItems = Array.from({ length: 1000 }, (_, i) => ({ ...fresh, path: `/vault/new-${i}.md` }))
  app = mount(HomeContent, { target: document.body }); await settle()
  expect(document.querySelectorAll('[data-content-kind="new"]')).toHaveLength(4)
  button('More').click(); await settle()
  expect(document.querySelectorAll('[data-content-kind="new"]')).toHaveLength(20)
  await unmount(app)
  app = mount(HomeContent, { target: document.body }); await settle()
  expect(document.querySelectorAll('[data-content-kind="new"]')).toHaveLength(4)
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

it('renders preview markup as text and never creates executable or remote elements', async () => {
  const preview = '<img src="https://remote.invalid/a.png" onerror="alert(1)"><script>alert(2)</script>'
  mocks.store.newItems = [{ ...fresh, preview }]
  app = mount(HomeContent, { target: document.body }); await settle()
  expect(document.querySelector('.content-preview')?.textContent).toBe(preview)
  expect(document.querySelectorAll('.home-content img, .home-content script, .home-content iframe')).toHaveLength(0)
})

it('uses a readable path fallback for external or root-level documents without body metadata', async () => {
  mocks.store.newItems = [{ ...fresh, preview: '  ', detail: '.' }]
  mocks.store.continueItems = [{ ...previous, path: '/external/book.pdf', detail: '~/Books', preview: undefined }]
  app = mount(HomeContent, { target: document.body }); await settle()
  const previews = [...document.querySelectorAll('.content-preview')]
  expect(previews.map(p => p.textContent)).toEqual([fresh.path, '~/Books'])
  expect(previews.every(p => p.classList.contains('fallback'))).toBe(true)
})
