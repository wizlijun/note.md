// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultPreferences, type SumiState } from './contract'

const state = (overrides: Partial<SumiState> = {}): SumiState => ({
  available: true, pages: [{ id: 'page-a', excerpt: '第一行', deleted: false }], activePageId: 'page-a',
  preferences: defaultPreferences, sync: { connected: false, pending: 0 }, saveState: 'saved', ...overrides,
})
const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve() }
async function setup(next = state(), mount?: () => Promise<unknown>) {
  vi.resetModules()
  document.body.innerHTML = '<div id="app"></div>'
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const request = vi.fn(async (method: string, _params?: unknown) => {
    if (method === 'host.sumi.state' || method === 'host.sumi.page' || method === 'host.sumi.preferences' || method === 'host.sumi.pair') return next
    if (method === 'host.sumi.invite') return { invitation: '{"spaceId":"test-space","code":"test-only","expiresAt":123456}' }
    if (method === 'host.sumi.mount') return mount ? mount() : { id: 'surface-a', generation: 1 }
    return null
  })
  window.notemd = { locale: 'zh', request, onMessage: vi.fn() }
  await import('./main')
  await settle()
  return request
}
afterEach(() => { sessionStorage.clear(); window.dispatchEvent(new Event('pagehide')); delete window.notemd; vi.unstubAllGlobals() })

describe('Sumi native writing shell', () => {
  it('does not create a page or mount a fake web editor on unsupported systems', async () => {
    const request = await setup(state({ available: false, activePageId: null, reason: '需要 macOS 13 或更新版本' }))
    expect(request.mock.calls.map(call => call[0])).toEqual(['host.sumi.state'])
    expect(document.getElementById('notice')!.textContent).toContain('macOS 13')
    expect(document.querySelector('[contenteditable],textarea')).toBeNull()
  })
  it('mounts the selected page once without sending its body through JavaScript', async () => {
    const request = await setup()
    expect(request.mock.calls.map(call => call[0])).toEqual(['host.sumi.state', 'host.sumi.mount', 'host.sumi.visible', 'host.sumi.focus'])
    expect(document.querySelector('[contenteditable],textarea')).toBeNull()
  })
  it('detaches a mount that completes after the window is unloaded', async () => {
    let resolve!: (value: unknown) => void
    const request = await setup(state(), () => new Promise(done => { resolve = done }))
    window.dispatchEvent(new Event('pagehide'))
    resolve({ id: 'late', generation: 9 }); await settle()
    expect(request.mock.calls.map(call => call[0])).toContain('host.sumi.detach')
    expect(request.mock.calls.map(call => call[0])).not.toContain('host.sumi.focus')
  })
  it('focuses an existing writer only for an explicit open, without installing its surface', async () => {
    const request=await setup(state(),async()=>({kind:'existing_owner',page_id:'page-a'}))
    expect(request).toHaveBeenCalledWith('host.sumi.focus_existing',{pageId:'page-a'})
    expect(request.mock.calls.map(call=>call[0])).not.toContain('host.sumi.visible')
    const receive=vi.mocked(window.notemd!.onMessage!).mock.calls[0][0]
    request.mockClear()
    receive({type:'sumi-state',state:state({activePageId:'other',navigationVersion:2})});await settle()
    expect(request.mock.calls.map(call=>call[0])).not.toContain('host.sumi.focus_existing')
    expect(request.mock.calls.map(call=>call[0])).not.toContain('host.sumi.focus')
  })
  it('focuses its current bound writer without remounting or changing pages', async () => {
    const request=await setup()
    document.getElementById('pages')!.click();await settle()
    const receive=vi.mocked(window.notemd!.onMessage!).mock.calls[0][0]
    request.mockClear()
    receive({type:'sumi-focus-owner',pageId:'page-a'});await settle()
    expect(document.getElementById('panel')!.hidden).toBe(true)
    expect(request.mock.calls.map(call=>call[0])).toEqual(['host.sumi.visible','host.sumi.focus'])
    request.mockClear();receive({type:'sumi-focus-owner',pageId:'stale-page'});await settle()
    expect(request).not.toHaveBeenCalled()
  })
  it('shows page previews as text, and hides the native surface before showing controls', async () => {
    const request = await setup(state({ pages: [{ id: 'page-a', excerpt: '<img src=x onerror=alert(1)>', deleted: false }] }))
    document.getElementById('pages')!.click(); await settle()
    expect(document.querySelector('.page-open')!.textContent).toContain('<img')
    expect(document.querySelector('#panel img')).toBeNull()
    expect(document.getElementById('panel')!.hidden).toBe(false)
    expect(request.mock.calls.filter(call => call[0] === 'host.sumi.visible')).toHaveLength(2)
  })
  it('labels native fullscreen enter and exit and supports the standard shortcut in panels', async () => {
    const request = await setup()
    request.mockResolvedValueOnce({ fullscreen: true } as never)
    document.getElementById('fullscreen')!.click(); await settle()
    expect(document.getElementById('fullscreen')!.getAttribute('aria-label')).toContain('退出全屏')
    expect(document.getElementById('fullscreen')!.getAttribute('aria-pressed')).toBe('true')
    request.mockResolvedValueOnce({ fullscreen: false } as never)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true, ctrlKey: true, cancelable: true }))
    await settle()
    expect(request.mock.calls.filter(call => call[0] === 'host.sumi.fullscreen')).toHaveLength(2)
    expect(document.getElementById('fullscreen')!.getAttribute('aria-label')).toContain('进入全屏')
  })
  it('makes an unsuccessful save visible instead of reporting success', async () => {
    await setup(state({ saveState: 'error' }))
    expect(document.getElementById('notice')!.textContent).toContain('保存失败')
    expect(document.getElementById('notice')!.hidden).toBe(false)
  })
  it.each(['Sumi Plex', 'Sumi WenKai', 'Sumi Zhaohua', 'Sumi Youcha', 'Sumi Fangsong'])('applies the %s font combination without changing other preferences', async (fontFamily) => {
    const preferences = { ...defaultPreferences, theme: 'sepia' as const, fontSize: 32, lineHeight: 1.8 }
    const request = await setup(state({ preferences }))
    document.getElementById('appearance')!.click(); await settle()
    const form = document.querySelector('#panel-body form') as HTMLFormElement
    const fonts = form.elements.namedItem('fontFamily') as HTMLSelectElement
    expect(fonts.tagName).toBe('SELECT')
    expect([...fonts.options].map(option => option.value)).toEqual(['Sumi Plex', 'Sumi WenKai', 'Sumi Zhaohua', 'Sumi Youcha', 'Sumi Fangsong'])
    fonts.value = fontFamily
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle()
    expect(request).toHaveBeenCalledWith('host.sumi.preferences', { preferences: { ...preferences, fontFamily } })
  })
  it.each(['breathing', 'steady'] as const)('restores and applies the %s caret preference', async (caretMotion) => {
    const preferences = { ...defaultPreferences, caretMotion, fontFamily: 'Sumi Youcha', fontSize: 32 }
    const request = await setup(state({ preferences }))
    document.getElementById('appearance')!.click(); await settle()
    const form = document.querySelector('#panel-body form') as HTMLFormElement
    const caret = form.elements.namedItem('caretMotion') as HTMLSelectElement
    expect(caret.value).toBe(caretMotion)
    expect([...caret.options].map(option => option.value)).toEqual(['breathing', 'steady'])
    expect(caret.options[1].textContent).toBe('不闪烁（常亮）')
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle()
    expect(request).toHaveBeenCalledWith('host.sumi.preferences', { preferences })
  })
  it('submits the service URL and complete pairing code through the host contract', async () => {
    const request = await setup()
    document.getElementById('sync')!.click(); await settle()
    const form = document.querySelector('#panel-body form') as HTMLFormElement
    ;(form.elements.namedItem('serviceUrl') as HTMLInputElement).value = 'https://sumi.example.test'
    const invitation = '{"spaceId":"test-space","code":"test-only","expiresAt":123456}'
    ;(form.elements.namedItem('invitation') as HTMLInputElement).value = invitation
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle()
    expect(request).toHaveBeenCalledWith('host.sumi.pair', { serviceUrl: 'https://sumi.example.test', invitation })
    expect(document.getElementById('panel')!.hidden).toBe(true)
  })
  it('displays the complete one-time invitation for another device', async () => {
    const request = await setup(state({ sync: { connected: true, pending: 0 } }))
    document.getElementById('sync')!.click(); await settle()
    const button = [...document.querySelectorAll<HTMLButtonElement>('#panel-body button')].find(item => item.textContent === '配对另一台设备')!
    button.click(); await settle()
    expect(request).toHaveBeenCalledWith('host.sumi.invite', undefined)
    const output = document.querySelector('#panel-body textarea') as HTMLTextAreaElement
    expect(JSON.parse(output.value)).toEqual({ spaceId: 'test-space', code: 'test-only', expiresAt: 123456 })
    expect(output.readOnly).toBe(true)
  })
  it('updates an open sync panel on connection and failure without replacing pairing input', async () => {
    await setup()
    document.getElementById('sync')!.click(); await settle()
    const input = document.querySelector<HTMLInputElement>('input[name="serviceUrl"]')!
    input.value = 'https://sumi.example.test'
    const receive = vi.mocked(window.notemd!.onMessage!).mock.calls[0][0]
    expect(document.getElementById('sync-invite')!.hidden).toBe(true)
    receive({ type: 'sumi-state', state: state({ sync: { connected: true, pending: 0 } }) }); await settle()
    expect(document.getElementById('sync-status')!.textContent).toBe('已连接')
    expect(document.getElementById('sync-invite')!.hidden).toBe(false)
    expect(document.querySelector('input[name="serviceUrl"]')).toBe(input)
    expect(input.value).toBe('https://sumi.example.test')
    receive({ type: 'sumi-state', state: state({ sync: { connected: false, pending: 0, message: '连接关闭' } }) }); await settle()
    expect(document.getElementById('sync-status')!.textContent).toContain('离线')
    expect(document.getElementById('sync-invite')!.hidden).toBe(true)
    expect(document.getElementById('notice')!.textContent).toBe('连接关闭')
    expect(input.value).toBe('https://sumi.example.test')
  })
  it('shows loading and waits for the target snapshot before mounting a new page', async () => {
    const request = await setup()
    const ordinary = request.getMockImplementation()!
    let ready!: (value: SumiState) => void
    request.mockImplementation((method, params) => method === 'host.sumi.page'
      ? new Promise(resolve => { ready = resolve as (value: SumiState) => void })
      : ordinary(method, params))
    document.getElementById('next')!.click(); await settle()
    expect(document.getElementById('notice')!.textContent).toContain('正在打开纸页')
    expect(request.mock.calls.filter(call => call[0] === 'host.sumi.mount')).toHaveLength(1)
    ready(state({ activePageId: 'page-b', navigationVersion: 2 })); await settle()
    expect(request.mock.calls.filter(call => call[0] === 'host.sumi.mount')).toHaveLength(2)
    expect(request).toHaveBeenCalledWith('host.sumi.mount', expect.objectContaining({ pageId: 'page-b' }))
    expect(document.getElementById('notice')!.textContent).not.toContain('正在打开纸页')
  })
  it('retains a refused native detach and retries it before changing the page', async () => {
    const request = await setup(state({ navigationVersion: 1 }))
    const base = request.getMockImplementation()!
    let reject = true
    request.mockImplementation(async (method, params) => {
      if (method === 'host.sumi.detach' && reject) { reject = false; throw new Error('IME active') }
      if (method === 'host.sumi.page') return state({ activePageId: 'page-b', navigationVersion: 2 })
      return base(method, params)
    })
    document.getElementById('new')!.click(); await settle()
    expect(request.mock.calls.filter(call => call[0] === 'host.sumi.page')).toHaveLength(0)
    expect(document.getElementById('notice')!.textContent).toContain('IME active')
    document.getElementById('new')!.click(); await settle()
    const detaches = request.mock.calls.filter(call => call[0] === 'host.sumi.detach')
    expect(detaches).toHaveLength(2)
    expect(detaches[0][1]).toEqual(detaches[1][1])
    expect(request).toHaveBeenCalledWith('host.sumi.page', expect.objectContaining({ action: 'create', pageId: undefined, fromPageId: 'page-a', requestId: expect.any(String) }))
    expect(request).toHaveBeenCalledWith('host.sumi.mount', expect.objectContaining({ pageId: 'page-b' }))
  })
  it('remounts the original page if navigation fails after a successful detach', async () => {
    const request = await setup()
    const base = request.getMockImplementation()!
    request.mockImplementation(async (method, params) => {
      if (method === 'host.sumi.page') throw new Error('directory unavailable')
      return base(method, params)
    })
    document.getElementById('next')!.click(); await settle()
    expect(request.mock.calls.filter(call => call[0] === 'host.sumi.mount')).toHaveLength(2)
    expect(request.mock.calls.filter(call => call[0] === 'host.sumi.mount').at(-1)![1]).toEqual(expect.objectContaining({ pageId: 'page-a' }))
    expect(document.getElementById('notice')!.textContent).toContain('directory unavailable')
  })
  it('deletes only after detach and mounts the surviving page without stale-handle detach', async () => {
    const request = await setup(state({ navigationVersion: 1 }))
    document.getElementById('pages')!.click(); await settle()
    const base = request.getMockImplementation()!
    const after = state({ activePageId: 'page-b', navigationVersion: 2, pages: [{ id: 'page-a', excerpt: 'old', deleted: true }, { id: 'page-b', excerpt: 'next', deleted: false }] })
    request.mockImplementation(async (method, params) => method === 'host.sumi.page' || method === 'host.sumi.state' ? after : base(method, params))
    ;(document.querySelector('button[aria-label="移到废纸篓"]') as HTMLButtonElement).click(); await settle(); await settle()
    expect(request.mock.calls.filter(call => call[0] === 'host.sumi.detach')).toHaveLength(1)
    const methods = request.mock.calls.map(call => call[0])
    expect(methods.indexOf('host.sumi.detach')).toBeLessThan(methods.indexOf('host.sumi.page'))
    expect(request.mock.calls.filter(call => call[0] === 'host.sumi.mount').at(-1)![1]).toEqual(expect.objectContaining({ pageId: 'page-b' }))
  })
  it('mounts a pushed recovered page and ignores a late older active-page state', async () => {
    const request = await setup(state({ navigationVersion: 1 }))
    const receive = vi.mocked(window.notemd!.onMessage!).mock.calls[0][0]
    receive({ type: 'sumi-state', state: state({ activePageId: 'recovered-page', navigationVersion: 2 }) })
    await settle(); await settle()
    receive({ type: 'sumi-state', state: state({ activePageId: 'page-a', navigationVersion: 1 }) })
    await settle()
    expect(request.mock.calls.filter(call => call[0] === 'host.sumi.mount')).toHaveLength(2)
    expect(request.mock.calls.filter(call => call[0] === 'host.sumi.mount').at(-1)![1]).toEqual(expect.objectContaining({ pageId: 'recovered-page' }))
  })
  it('does not mount pushed pages while the singleton is hidden and resumes only on explicit show', async () => {
    const request = await setup(state({ navigationVersion: 1 }))
    const receive = vi.mocked(window.notemd!.onMessage!).mock.calls[0][0]
    receive({ type: 'sumi-window-state', visible: false, detached: true })
    receive({ type: 'sumi-state', state: state({ activePageId: 'page-b', navigationVersion: 2 }) })
    await settle(); await settle()
    expect(request.mock.calls.filter(call => call[0] === 'host.sumi.mount')).toHaveLength(1)
    expect(request.mock.calls.filter(call => call[0] === 'host.sumi.detach')).toHaveLength(0)
    const base = request.getMockImplementation()!
    request.mockImplementation(async (method, params) => method === 'host.sumi.state' ? state({ activePageId: 'page-b', navigationVersion: 2 }) : base(method, params))
    receive({ type: 'sumi-window-state', visible: true }); await settle(); await settle()
    expect(request.mock.calls.filter(call => call[0] === 'host.sumi.mount')).toHaveLength(2)
    expect(request).toHaveBeenLastCalledWith('host.sumi.focus', expect.anything())
    expect(request).toHaveBeenCalledWith('host.sumi.mount', expect.objectContaining({ pageId: 'page-b' }))
  })
  it('does not retain a late surface after host close already flushed and detached it', async () => {
    let finish!: (value: unknown) => void
    const request = await setup(state(), () => new Promise(resolve => { finish = resolve }))
    const receive = vi.mocked(window.notemd!.onMessage!).mock.calls[0][0]
    receive({ type: 'sumi-window-state', visible: false, detached: true })
    finish({ id: 'already-detached', generation: 1 }); await settle()
    receive({ type: 'sumi-state', state: state({ activePageId: 'recovered', navigationVersion: 2 }) }); await settle()
    expect(request.mock.calls.map(call => call[0])).not.toContain('host.sumi.focus')
    expect(request.mock.calls.map(call => call[0])).not.toContain('host.sumi.detach')
    expect(request.mock.calls.filter(call => call[0] === 'host.sumi.mount')).toHaveLength(1)
  })
  it('retries explicit show after an older mount request finishes', async () => {
    let finish!: (value: unknown) => void
    let mounts = 0
    const request = await setup(state(), () => ++mounts === 1 ? new Promise(resolve => { finish = resolve }) : Promise.resolve({ id: 'new-surface', generation: 2 }))
    const receive = vi.mocked(window.notemd!.onMessage!).mock.calls[0][0]
    receive({ type: 'sumi-window-state', visible: false, detached: true })
    receive({ type: 'sumi-window-state', visible: true })
    finish({ id: 'old-surface', generation: 1 }); await settle(); await settle()
    expect(request.mock.calls.filter(call => call[0] === 'host.sumi.mount')).toHaveLength(2)
    expect(request).toHaveBeenLastCalledWith('host.sumi.focus', { surface: { id: 'new-surface', generation: 2 } })
  })
  it('opens an explicitly recovered empty page without creating another paper or navigating again', async () => {
    const request = await setup(state({ navigationVersion: 1 }))
    const receive = vi.mocked(window.notemd!.onMessage!).mock.calls[0][0]
    const base = request.getMockImplementation()!
    request.mockImplementation(async (method, params) => method === 'host.sumi.page' ? state({ activePageId: 'recovered', navigationVersion: 2 }) : base(method, params))
    receive({ type: 'seed', payload: { kind: 'sumi-navigation', pageId: 'recovered', action: 'open_page' } }); await settle(); await settle()
    expect(request.mock.calls.filter(call => call[0] === 'host.sumi.page').map(call => call[1])).toEqual([{ action: 'open', pageId: 'recovered', fromPageId: 'page-a' }])
  })
  it('navigates a main-tab request only after successfully releasing the existing writer', async () => {
    const request = await setup(state({ navigationVersion: 1 }))
    const receive = vi.mocked(window.notemd!.onMessage!).mock.calls[0][0]
    const base = request.getMockImplementation()!
    let version = 1
    request.mockImplementation(async (method, params) => {
      if (method === 'host.sumi.page') {
        const action = params as { action: string; pageId?: string }
        return state({ activePageId: action.action === 'open' ? action.pageId : 'created-page', navigationVersion: ++version })
      }
      return base(method, params)
    })
    receive({ type: 'seed', payload: { kind: 'sumi-navigation', pageId: 'main-tab-page', action: 'new_page' } })
    await settle(); await settle(); await settle()
    expect(request.mock.calls.filter(call => call[0] === 'host.sumi.page').map(call => call[1])).toEqual([
      { action: 'open', pageId: 'main-tab-page', fromPageId: 'page-a' },
      { action: 'create', pageId: undefined, fromPageId: 'main-tab-page', requestId: expect.any(String) },
    ])
    const methods = request.mock.calls.map(call => call[0])
    expect(methods.indexOf('host.sumi.detach')).toBeLessThan(methods.indexOf('host.sumi.page'))
    expect(request.mock.calls.filter(call => call[0] === 'host.sumi.mount').at(-1)![1]).toEqual(expect.objectContaining({ pageId: 'created-page' }))
  })

  it('retries a lost create response with its original operation and origin after a pushed active change', async () => {
    const request = await setup(state({ navigationVersion: 1 }))
    const base = request.getMockImplementation()!
    let lost = true
    request.mockImplementation(async (method, params) => {
      if (method === 'host.sumi.page') {
        if (lost) { lost = false; throw new Error('response lost') }
        return state({ activePageId: 'created-page', navigationVersion: 2 })
      }
      return base(method, params)
    })
    document.getElementById('new')!.click(); await settle()
    const receive = vi.mocked(window.notemd!.onMessage!).mock.calls[0][0]
    receive({ type: 'sumi-state', state: state({ activePageId: 'created-page', navigationVersion: 2 }) }); await settle()
    document.getElementById('new')!.click(); await settle()
    const calls = request.mock.calls.filter(call => call[0] === 'host.sumi.page')
    expect(calls).toHaveLength(2)
    expect(calls[1][1]).toEqual(calls[0][1])
    expect(calls[1][1]).toEqual(expect.objectContaining({ fromPageId: 'page-a', requestId: expect.any(String) }))
    expect(sessionStorage.getItem('notemd.sumi.pending-page-operation')).toBeNull()
  })
  it('reports a blocked file projection as locally saved, distinct from failed durability', async () => {
    await setup(state({ saveState: 'projection-pending' }))
    expect(document.getElementById('notice')!.textContent).toContain('已保存在本机')
    expect(document.getElementById('notice')!.textContent).not.toContain('保存失败')
  })

})
