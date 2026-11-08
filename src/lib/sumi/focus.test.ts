// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SumiOwner } from './session'
const mocks = vi.hoisted(() => ({ activate: vi.fn(), active: vi.fn(), owner: vi.fn(), invoke: vi.fn() }))
vi.mock('../tabs.svelte', () => ({ activate: mocks.activate, activeTab: mocks.active }))
vi.mock('./session', () => ({ sumiOwner: mocks.owner }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
import { focusSumiOwner } from './focus'
let owner: SumiOwner
beforeEach(() => {
  vi.clearAllMocks()
  owner = { pageId: 'page', tabId: 'tab', pluginId: 'notemd.sumi', path: '/vault/page.writing.md', raw: 'draft', revision: 4, editor: 'web', tail: Promise.resolve() }
  mocks.owner.mockReturnValue(owner)
  mocks.active.mockReturnValue({ id: 'tab', mode: 'source' })
  mocks.activate.mockResolvedValue(undefined)
  mocks.invoke.mockResolvedValue(undefined)
})
describe('explicit Sumi owner focus', () => {
  it('activates the exact owner and focuses Source without requesting a caret move or mode change', async () => {
    const dispatch = vi.spyOn(window, 'dispatchEvent')
    await focusSumiOwner({ page_id: 'page', tab_id: 'tab' })
    expect(mocks.activate).toHaveBeenCalledWith('tab')
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('sumi_focus_owner', { page_id: 'page', tab_id: 'tab', plugin_id: 'notemd.sumi' })
    expect((dispatch.mock.calls[0][0] as CustomEvent).detail).toEqual({ path: owner.path, preserveSelection: true })
    expect(owner.editor).toBe('web'); expect(owner.raw).toBe('draft')
    dispatch.mockRestore()
  })
  it('does not focus another window after an IME-blocked tab switch', async () => {
    mocks.active.mockReturnValue({ id: 'current-ime-tab' })
    await expect(focusSumiOwner({ page_id: 'page', tab_id: 'tab' })).rejects.toThrow('完成当前输入')
    expect(mocks.invoke).not.toHaveBeenCalled()
  })
  it('rejects stale or mismatched owner identities and never accepts an arbitrary target window', async () => {
    await expect(focusSumiOwner({ page_id: 'other-page', tab_id: 'tab' })).rejects.toThrow('编辑面已改变')
    expect(mocks.activate).not.toHaveBeenCalled()
    mocks.activate.mockImplementationOnce(async () => { mocks.owner.mockReturnValue({ ...owner }) })
    await expect(focusSumiOwner({ page_id: 'page', tab_id: 'tab' })).rejects.toThrow('完成当前输入')
    expect(mocks.invoke).not.toHaveBeenCalled()
  })
  it('keeps a native surface and lets its bound host focus preserve selection', async () => {
    owner.editor = 'native'; owner.surface = { surface_id: 'kept', generation: 8 }
    const dispatch = vi.spyOn(window, 'dispatchEvent')
    await focusSumiOwner({ page_id: 'page', tab_id: 'tab' })
    expect(dispatch).not.toHaveBeenCalled()
    expect(owner.surface).toEqual({ surface_id: 'kept', generation: 8 })
    expect(mocks.invoke.mock.calls[0][1]).not.toHaveProperty('surface_id')
    dispatch.mockRestore()
  })
})
