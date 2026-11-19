import { beforeEach, expect, it, vi } from 'vitest'
const mocked = vi.hoisted(() => ({ prepare: vi.fn(async () => {}), mode: vi.fn(async (_id: string, _mode: string) => {}) }))
let tab: any
vi.mock('../tabs.svelte', () => ({ isManagedMemoryTab: () => false,
  setMode: (id: string, mode: string) => mocked.mode(id, mode), prepareFileViewTransition: () => mocked.prepare() }))
vi.mock('../sumi/session', () => ({ sumiOwner: () => null }))
vi.mock('../dialogs', () => ({ showError: vi.fn() }))
import { selectFileView, selectSourceFileView, resetFileViewPresentation } from './file-view-presentation.svelte'
const view = { pluginId: 'native', viewId: 'view', entry: 'index.html', icon: 'generic' as const, surface: 'native-editor' as const }
beforeEach(() => {
  tab = { id: 'tab', mode: 'source', kind: 'markdown', filePath: '/test.md' }
  mocked.mode.mockReset().mockImplementation(async (_id, mode) => { tab.mode = mode })
  mocked.prepare.mockReset().mockResolvedValue(undefined)
  resetFileViewPresentation('tab')
})
it('acknowledges selection only after native handoff and mode acceptance', async () => {
  let finish!: () => void
  mocked.prepare.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const complete = vi.fn()
  selectFileView(tab, view, complete)
  await vi.waitFor(() => expect(mocked.prepare).toHaveBeenCalled())
  expect(complete).not.toHaveBeenCalled()
  finish()
  await vi.waitFor(() => expect(complete).toHaveBeenCalledExactlyOnceWith(true))
})
it('reports failed handoffs and swallowed mode rejection as unaccepted', async () => {
  const complete = vi.fn()
  mocked.prepare.mockRejectedValue(new Error('busy'))
  selectFileView(tab, view, complete)
  await vi.waitFor(() => expect(complete).toHaveBeenCalledExactlyOnceWith(false))
  complete.mockClear(); mocked.prepare.mockResolvedValue(undefined)
  mocked.mode.mockResolvedValue(undefined)
  selectFileView(tab, view, complete)
  await vi.waitFor(() => expect(complete).toHaveBeenCalledExactlyOnceWith(false))
})
it('does not accept stale handoff after the user chooses Source', async () => {
  let finish!: () => void
  mocked.prepare.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const complete = vi.fn()
  selectFileView(tab, view, complete)
  await vi.waitFor(() => expect(mocked.prepare).toHaveBeenCalled())
  selectSourceFileView(tab)
  finish()
  await vi.waitFor(() => expect(complete).toHaveBeenCalledExactlyOnceWith(false))
})
