import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
import { invoke } from '@tauri-apps/api/core'

const call = vi.mocked(invoke)
const bounds = { x: 0, y: 0, width: 700, height: 500 }
let api: typeof import('./session')
beforeEach(async () => {
  vi.resetModules()
  api = await import('./session')
  call.mockReset()
  call.mockImplementation(async (command) => {
    if (command === 'sumi_open_path') return { page_id: 'page', raw: 'original', revision: 1 }
    if (command === 'sumi_mount') return { surface_id: 'surface', generation: 1 }
    if (command === 'sumi_flush' || command === 'sumi_detach') return { raw: 'accepted native text', revision: 7 }
  })
})

describe('Sumi single writer handoff', () => {
  it('sends the expected UUID before the host can attach a reused filename', async () => {
    const owner=await api.openSumiOwner('tab','/vault/02.writing.md',api.SUMI_PLUGIN_ID,'page')
    expect(call).toHaveBeenLastCalledWith('sumi_open_path',expect.objectContaining({expected_page_id:'page'}))
    call.mockRejectedValueOnce(new Error('identity changed'))
    await expect(api.refreshSumiOwner(owner)).rejects.toThrow('identity changed')
    expect(call).toHaveBeenLastCalledWith('sumi_open_path',expect.objectContaining({path:'/vault/02.writing.md',expected_page_id:'page'}))
    expect(owner.raw).toBe('original');expect(owner.pageId).toBe('page')
  })
  it('returns a typed existing-owner outcome without registering a duplicate or focusing implicitly', async () => {
    call.mockResolvedValueOnce({kind:'existing_owner',page_id:'page'})
    await expect(api.openSumiOwner('other-tab','/vault/page.writing.md')).rejects.toBeInstanceOf(api.SumiExistingOwnerError)
    expect(api.sumiOwner('other-tab')).toBeUndefined()
    expect(call.mock.calls.map(([method])=>method)).toEqual(['sumi_open_path'])
    await api.focusExistingSumiPage('page')
    expect(call).toHaveBeenLastCalledWith('sumi_focus_existing',{page_id:'page',plugin_id:'notemd.sumi'})
  })
  it('does not install or detach a foreign surface after a mount ownership race', async () => {
    const owner=await api.openSumiOwner('tab','/vault/page.writing.md')
    call.mockResolvedValueOnce({kind:'existing_owner',page_id:'page'})
    await expect(api.mountSumiOwner(owner,bounds,()=>true)).rejects.toBeInstanceOf(api.SumiExistingOwnerError)
    expect(owner.surface).toBeUndefined()
    expect(owner.editor).toBe('web')
    expect(call.mock.calls.map(([method])=>method)).toEqual(['sumi_open_path','sumi_mount'])
  })
  it('releases the backend owner only after flushing and detaching', async () => {
    const owner = await api.openSumiOwner('tab', '/vault/page.writing.md')
    await api.mountSumiOwner(owner, bounds, () => true)
    await api.closeSumiOwner('tab')
    expect(call.mock.calls.slice(-2).map(([name]) => name)).toEqual(['sumi_detach', 'sumi_close'])
    expect(api.sumiOwner('tab')).toBeUndefined()
  })

  it('keeps native ownership after detach until the final snapshot is installed', async () => {
    const owner = await api.openSumiOwner('tab', '/vault/page.writing.md')
    await api.mountSumiOwner(owner, bounds, () => true)
    const snapshot = await api.flushSumiNative(owner, true)
    expect(snapshot).toEqual({ raw: 'accepted native text', revision: 7 })
    expect(owner.surface).toBeUndefined()
    await expect(api.saveSumiSource(owner, 'stale web text')).rejects.toThrow('still owns')
    api.finishSumiHandoff(owner)
    expect(owner.editor).toBe('web')
    expect(call.mock.calls.map(([name]) => name)).toEqual(['sumi_open_path', 'sumi_mount', 'sumi_detach'])
  })

  it('flushes and detaches a mount that finishes after its component was removed', async () => {
    const owner = await api.openSumiOwner('tab', '/vault/page.writing.md')
    let available = true
    call.mockImplementationOnce(async () => { available = false; return { surface_id: 'late', generation: 3 } })
    expect(await api.mountSumiOwner(owner, bounds, () => available)).toBeUndefined()
    expect(owner.raw).toBe('accepted native text')
    expect(owner.editor).toBe('native')
    expect(owner.surface).toBeUndefined()
    expect(call).toHaveBeenLastCalledWith('sumi_detach', expect.objectContaining({ surface_id: 'late', generation: 3 }))
  })

  it('never detaches or releases a writer when IME flush fails', async () => {
    const owner = await api.openSumiOwner('tab', '/vault/page.writing.md')
    const binding = await api.mountSumiOwner(owner, bounds, () => true)
    call.mockRejectedValueOnce(new Error('composition active'))
    await expect(api.flushSumiNative(owner, true)).rejects.toThrow('composition active')
    expect(owner.surface).toBe(binding)
    expect(owner.editor).toBe('native')
    expect(call).toHaveBeenLastCalledWith('sumi_detach', expect.objectContaining({ surface_id: 'surface' }))
    expect(() => api.finishSumiHandoff(owner)).toThrow('must detach')
  })

  it('does not let stale callbacks mutate a replacement surface', async () => {
    const owner = await api.openSumiOwner('tab', '/vault/page.writing.md')
    const first = await api.mountSumiOwner(owner, bounds, () => true)
    await api.flushSumiNative(owner, true)
    api.finishSumiHandoff(owner)
    call.mockResolvedValueOnce({ surface_id: 'new', generation: 2 })
    const second = await api.mountSumiOwner(owner, bounds, () => true)
    call.mockClear()
    await api.updateSumiSurface(owner, first!, 'sumi_visible', { visible: false })
    await api.detachSumiSurface(owner, first)
    expect(call).not.toHaveBeenCalled()
    expect(owner.surface).toBe(second)
  })

  it('serializes source saves against the revision accepted by the previous save', async () => {
    const owner = await api.openSumiOwner('tab', '/vault/page.writing.md')
    call.mockResolvedValueOnce({ raw: 'first', revision: 2 }).mockResolvedValueOnce({ raw: 'second', revision: 3 })
    await Promise.all([api.saveSumiSource(owner, 'first'), api.saveSumiSource(owner, 'second')])
    expect(call.mock.calls.slice(-2)).toEqual([
      ['sumi_source_save', { page_id: 'page', tab_id: 'tab', plugin_id: 'notemd.sumi', base_revision: 1, raw: 'first' }],
      ['sumi_source_save', { page_id: 'page', tab_id: 'tab', plugin_id: 'notemd.sumi', base_revision: 2, raw: 'second' }],
    ])
  })

  it('retains all conflicting source drafts instead of changing the accepted revision', async () => {
    const owner=await api.openSumiOwner('tab','/vault/page.writing.md')
    call.mockResolvedValueOnce({kind:'conflict',submitted:'A',accepted:'B',draft:'C'})
    await expect(api.rebaseSumiDraft(owner,'A','B','C')).rejects.toThrow('均已保留')
    expect(owner.sourceConflict).toEqual({submitted:'A',accepted:'B',draft:'C'})
    expect(owner.raw).toBe('original')
    expect(owner.revision).toBe(1)
  })

  it('keeps the original revision for a newer draft descended from a pre-merge baseline', async () => {
    const owner = await api.openSumiOwner('tab', '/vault/page.writing.md')
    owner.revision = 5
    owner.sourceBaseRevision = 1
    call.mockResolvedValueOnce({ raw: 'merged draft', revision: 6 })
    await api.saveSumiSource(owner, 'newer draft')
    expect(call).toHaveBeenLastCalledWith('sumi_source_save', expect.objectContaining({ base_revision: 1, raw: 'newer draft' }))
  })
})
