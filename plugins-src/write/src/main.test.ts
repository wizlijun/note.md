// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultPreferences, fontPresets, type SumiState, type FontState, type SoundState } from './contract'

const state = (overrides: Partial<SumiState> = {}): SumiState => ({
  available: true, pages: [{ id: 'page-a', excerpt: '第一行', deleted: false }], activePageId: 'page-a',
  preferences: defaultPreferences, sync: { connected: false, pending: 0 }, saveState: 'saved', ...overrides,
})
const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve() }
const fontState = (overrides: Partial<FontState> = {}): FontState => ({
  fonts: fontPresets.map(([family]) => ({ family, status: 'not_downloaded', downloadedBytes: 0, totalBytes: 10_000_000 })),
  selectedFont: 'Sumi Plex', pendingFont: null, ...overrides,
})
const fontButton = (family: string) => document.querySelector<HTMLButtonElement>(`button[data-font="${family}"]`)!
async function setup(next = state(), mount?: () => Promise<unknown>, locale = 'zh') {
  vi.resetModules()
  document.body.innerHTML = '<div id="app"></div>'
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const request = vi.fn(async (method: string, _params?: unknown): Promise<unknown> => {
    if (method === 'host.sumi.state' || method === 'host.sumi.page' || method === 'host.sumi.preferences' || method === 'host.sumi.pair') return next
    if (method === 'host.sumi.invite') return { invitation: '{"spaceId":"test-space","code":"test-only","expiresAt":123456}' }
    if (method === 'host.sumi.mount') return mount ? mount() : { id: 'surface-a', generation: 1 }
    if (method === 'host.sumi.sound_state') return { enabled: true, preset: 'typewriter', permission: 'granted', status: 'ready' }
    if (method === 'host.sumi.fonts') return fontState({ selectedFont: next.preferences.fontFamily })
    return null
  })
  window.notemd = { locale, request, onMessage: vi.fn() }
  await import('./main')
  await settle()
  return request
}
afterEach(() => { sessionStorage.clear(); window.dispatchEvent(new Event('pagehide')); delete window.notemd; vi.unstubAllGlobals(); vi.useRealTimers() })

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
  it('waits for explicit composition handoff before showing appearance, and can retry a rejected handoff', async () => {
    const request = await setup()
    let reject!: (reason: Error) => void
    request.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
    document.getElementById('appearance')!.click(); await settle()
    expect(request).toHaveBeenLastCalledWith('host.sumi.visible', { surface: { id: 'surface-a', generation: 1 }, visible: false, preparePanel: true })
    expect(document.getElementById('panel')!.hidden).toBe(true)
    reject(new Error('暂时无法打开面板，文字已保留，请重试')); await settle()
    expect(document.getElementById('panel')!.hidden).toBe(true)
    expect(document.getElementById('notice')!.textContent).toContain('文字已保留')
    expect((document.getElementById('appearance') as HTMLButtonElement).disabled).toBe(false)
    document.getElementById('appearance')!.click(); await settle()
    expect(document.getElementById('panel')!.hidden).toBe(false)
    expect(document.querySelector('#panel-body form')).not.toBeNull()
    document.getElementById('close')!.click(); await settle()
    expect(request).toHaveBeenCalledWith('host.sumi.visible', { surface: { id: 'surface-a', generation: 1 }, visible: true })
    expect(request).toHaveBeenLastCalledWith('host.sumi.focus', { surface: { id: 'surface-a', generation: 1 } })
  })
  it.each(fontPresets.map(([family]) => family))('selects the downloaded %s combination without changing other preferences', async (fontFamily) => {
    const preferences = { ...defaultPreferences, theme: 'sepia' as const, fontSize: 32, lineHeight: 1.8 }
    const request = await setup(state({ preferences }))
    const base = request.getMockImplementation()!
    const cached = fontState({ fonts: fontState().fonts.map(font => ({ ...font, status: 'ready', downloadedBytes: font.totalBytes })) })
    request.mockImplementation(async (method, params) => method === 'host.sumi.fonts' ? cached
      : method === 'host.sumi.font_select' ? { ...cached, selectedFont: fontFamily } : base(method, params))
    document.getElementById('appearance')!.click(); await settle()
    const form = document.querySelector('#panel-body form') as HTMLFormElement
    expect([...form.querySelectorAll<HTMLButtonElement>('[data-font]')].map(button => button.dataset.font)).toEqual(fontPresets.map(([family]) => family))
    fontButton(fontFamily).click(); await settle()
    expect(request).toHaveBeenCalledWith('host.sumi.font_select', { fontFamily })
    const receive = vi.mocked(window.notemd!.onMessage!).mock.calls[0][0]
    receive({ type: 'sumi-state', state: state({ preferences: { ...preferences, fontFamily } }) }); await settle()
    expect(fontButton(fontFamily).getAttribute('aria-pressed')).toBe('true')
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle()
    expect(request).toHaveBeenCalledWith('host.sumi.preferences', { preferences: { ...preferences, fontFamily }, preserveFont: true })
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
    expect(request).toHaveBeenCalledWith('host.sumi.preferences', { preferences, preserveFont: true })
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

describe('Sumi focused document commands', () => {
  it('routes native save/close/zoom only through writing commands', async () => {
    const request = await setup()
    const receive = vi.mocked(window.notemd!.onMessage!).mock.calls[0][0]
    for (const action of ['save', 'zoom_in', 'zoom_out', 'zoom_reset', 'close']) {
      receive({ type: 'sumi-action', action }); await settle()
      expect(request).toHaveBeenCalledWith('host.sumi.command', { action })
    }
    expect(request.mock.calls.map(call => call[0])).not.toContain('host.file.save')
  })
  it('opens appearance from its command and ignores actions after hiding', async () => {
    const request = await setup()
    const receive = vi.mocked(window.notemd!.onMessage!).mock.calls[0][0]
    receive({ type: 'sumi-action', action: 'settings' }); await settle()
    expect(document.querySelector('button[data-font="Sumi Plex"]')).not.toBeNull()
    receive({ type: 'sumi-window-state', visible: false, detached: true }); await settle()
    request.mockClear()
    receive({ type: 'sumi-action', action: 'new_page' }); await settle()
    expect(request).not.toHaveBeenCalled()
  })
  it('exports the current page archive without creating another paper', async () => {
    const request = await setup()
    request.mockImplementation(async (method: string) => method === 'host.sumi.export' ? { saved: true } : null)
    const receive = vi.mocked(window.notemd!.onMessage!).mock.calls[0][0]
    receive({ type: 'sumi-action', action: 'export' }); await settle()
    expect(request).toHaveBeenCalledWith('host.sumi.export', { pageId: 'page-a', format: 'archive' })
    expect(request.mock.calls.map(call => call[0])).not.toContain('host.sumi.page')
  })
})

describe('Sumi on-demand font settings', () => {
  it.each([
    ['crt', 'zh', '复古绿磷 CRT'],
    ['crt-blue', 'zh', '复古蓝磷 CRT'],
    ['crt', 'en', 'Retro Green Phosphor CRT'],
    ['crt-blue', 'en', 'Retro Blue Phosphor CRT'],
  ] as const)('restores and applies %s in %s without downloading fonts', async (themeId, locale, label) => {
    const preferences = { ...defaultPreferences, theme: themeId, fontFamily: 'Sumi WenKai', fontSize: 32, caretMotion: 'steady' as const }
    const request = await setup(state({ preferences }), undefined, locale)
    document.getElementById('appearance')!.click(); await settle()
    expect(document.documentElement.dataset.theme).toBe(themeId)
    const form = document.querySelector<HTMLFormElement>('#panel-body form')!
    const theme = form.elements.namedItem('theme') as HTMLSelectElement
    expect(theme.value).toBe(themeId)
    expect([...theme.options].find(option => option.value === themeId)!.textContent).toBe(label)
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle()
    expect(request).toHaveBeenCalledWith('host.sumi.preferences', { preferences, preserveFont: true })
    expect(request.mock.calls.some(([method]) => method === 'host.sumi.font_select')).toBe(false)
  })
  it('labels the CRT font and theme in English without coupling either choice or changing font size', async () => {
    const preferences = { ...defaultPreferences, theme: 'sepia' as const, fontSize: 32 }
    const request = await setup(state({ preferences }), undefined, 'en')
    const base = request.getMockImplementation()!
    request.mockImplementation(async (method, params) => method === 'host.sumi.font_select' ? fontState({ pendingFont: 'Sumi CRT' }) : base(method, params))
    document.getElementById('appearance')!.click(); await settle()
    const form = document.querySelector<HTMLFormElement>('#panel-body form')!
    const theme = form.elements.namedItem('theme') as HTMLSelectElement
    expect([...theme.options].find(option => option.value === 'crt')!.textContent).toBe('Retro Green Phosphor CRT')
    expect(fontButton('Sumi CRT').textContent).toContain('Retro Green Phosphor CRT · GNU Unifont')
    fontButton('Sumi CRT').click(); await settle()
    expect(request).toHaveBeenCalledWith('host.sumi.font_select', { fontFamily: 'Sumi CRT' })
    expect(theme.value).toBe('sepia')
    expect((form.elements.namedItem('fontSize') as HTMLInputElement).value).toBe('32')
    expect(request.mock.calls.some(([method]) => method === 'host.sumi.preferences')).toBe(false)
  })
  it('lists all fonts without downloading on startup or when opening settings', async () => {
    vi.useFakeTimers()
    const request = await setup()
    expect(request.mock.calls.some(([method]) => method === 'host.sumi.fonts')).toBe(false)
    document.getElementById('appearance')!.click(); await settle()
    expect(document.querySelectorAll('.font-option')).toHaveLength(fontPresets.length)
    expect(document.getElementById('font-list-status')!.textContent).toContain('系统字体')
    expect(fontButton('Sumi Plex').textContent).toContain('未下载，点击下载')
    expect(fontButton('Sumi Plex').textContent).toContain('10.0 MB')
    expect(request.mock.calls.filter(([method]) => method === 'host.sumi.fonts')).toHaveLength(1)
    expect(request.mock.calls.some(([method]) => method === 'host.sumi.font_select')).toBe(false)
    request.mockClear(); await vi.advanceTimersByTimeAsync(3000)
    expect(request).not.toHaveBeenCalled()
  })
  it('starts the default font only on click and does not duplicate a pending request or block writing', async () => {
    const request = await setup()
    const base = request.getMockImplementation()!
    let finish!: (value: FontState) => void
    request.mockImplementation((method, params) => method === 'host.sumi.font_select'
      ? new Promise(resolve => { finish = resolve as (value: FontState) => void }) : base(method, params))
    document.getElementById('appearance')!.click(); await settle()
    const button = fontButton('Sumi Plex')
    button.click(); button.click(); await settle()
    expect(request.mock.calls.filter(([method]) => method === 'host.sumi.font_select')).toHaveLength(1)
    expect(button.textContent).toContain('正在开始')
    expect((document.getElementById('close') as HTMLButtonElement).disabled).toBe(false)
    document.getElementById('close')!.click(); await settle()
    expect(document.getElementById('panel')!.hidden).toBe(true)
    expect(request).toHaveBeenLastCalledWith('host.sumi.focus', { surface: { id: 'surface-a', generation: 1 } })
    finish(fontState({ pendingFont: 'Sumi Plex' })); await settle()
    expect(document.getElementById('panel')!.hidden).toBe(true)
  })
  it.each(['not_downloaded', 'ready'] as const)('keeps a queued %s font nonblocking and prevents duplicate clicks before the download/apply worker runs', async (phase) => {
    const request = await setup()
    const base = request.getMockImplementation()!
    const queued = fontState({ pendingFont: 'Sumi Youcha', fonts: fontState().fonts.map(font => font.family === 'Sumi Youcha' ? { ...font, status: phase } : font) })
    request.mockImplementation(async (method, params) => method === 'host.sumi.font_select' ? queued : base(method, params))
    document.getElementById('appearance')!.click(); await settle()
    fontButton('Sumi Youcha').click(); await settle()
    expect(fontButton('Sumi Youcha').textContent).toContain(phase === 'ready' ? '正在应用' : '准备下载')
    expect(fontButton('Sumi Youcha').disabled).toBe(true)
    fontButton('Sumi Youcha').click(); await settle()
    expect(request.mock.calls.filter(([method]) => method === 'host.sumi.font_select')).toHaveLength(1)
    expect((document.getElementById('close') as HTMLButtonElement).disabled).toBe(false)
  })
  it('restores background progress on reopen and stops polling when the panel closes', async () => {
    vi.useFakeTimers()
    const request = await setup()
    const base = request.getMockImplementation()!
    let next = fontState()
    request.mockImplementation(async (method, params) => {
      if (method === 'host.sumi.fonts') return next
      if (method === 'host.sumi.font_select') {
        next = fontState({ pendingFont: 'Sumi Youcha', fonts: fontState().fonts.map(font => font.family === 'Sumi Youcha' ? { ...font, status: 'downloading', downloadedBytes: 2_500_000 } : font) })
        return next
      }
      return base(method, params)
    })
    document.getElementById('appearance')!.click(); await settle()
    fontButton('Sumi Youcha').click(); await settle()
    expect(fontButton('Sumi Youcha').textContent).toContain('下载中 25%')
    expect(fontButton('Sumi Youcha').querySelector('progress')!.value).toBe(2_500_000)
    document.getElementById('close')!.click(); await settle()
    request.mockClear(); await vi.advanceTimersByTimeAsync(3000)
    expect(request).not.toHaveBeenCalled()
    next = { ...next, fonts: next.fonts.map(font => font.family === 'Sumi Youcha' ? { ...font, downloadedBytes: 7_500_000 } : font) }
    document.getElementById('appearance')!.click(); await settle()
    expect(fontButton('Sumi Youcha').textContent).toContain('下载中 75%')
    expect(request.mock.calls.some(([method]) => method === 'host.sumi.font_select')).toBe(false)
  })
  it('keeps other appearance drafts while progress and background completion arrive', async () => {
    vi.useFakeTimers()
    const request = await setup()
    const base = request.getMockImplementation()!
    let next = fontState({ pendingFont: 'Sumi WenKai', fonts: fontState().fonts.map(font => font.family === 'Sumi WenKai' ? { ...font, status: 'downloading', downloadedBytes: 1_000_000 } : font) })
    request.mockImplementation(async (method, params) => method === 'host.sumi.fonts' ? next : base(method, params))
    document.getElementById('appearance')!.click(); await settle()
    const form = document.querySelector<HTMLFormElement>('#panel-body form')!
    const size = form.elements.namedItem('fontSize') as HTMLInputElement
    const theme = form.elements.namedItem('theme') as HTMLSelectElement
    size.value = '45'; theme.value = 'sepia'
    await vi.advanceTimersByTimeAsync(750)
    expect(form.elements.namedItem('fontSize')).toBe(size)
    next = fontState({ selectedFont: 'Sumi WenKai', fonts: next.fonts.map(font => font.family === 'Sumi WenKai' ? { ...font, status: 'ready', downloadedBytes: font.totalBytes } : font) })
    const receive = vi.mocked(window.notemd!.onMessage!).mock.calls[0][0]
    receive({ type: 'sumi-state', state: state({ preferences: { ...defaultPreferences, fontFamily: 'Sumi WenKai' } }) }); await settle()
    await vi.advanceTimersByTimeAsync(750)
    expect(size.value).toBe('45'); expect(theme.value).toBe('sepia')
    expect(fontButton('Sumi WenKai').textContent).toContain('使用中')
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle()
    expect(request).toHaveBeenCalledWith('host.sumi.preferences', { preferences: { ...defaultPreferences, fontFamily: 'Sumi WenKai', fontSize: 45, theme: 'sepia' }, preserveFont: true })
  })
  it('retries a failed download without changing the current font or the document notice', async () => {
    const request = await setup()
    const base = request.getMockImplementation()!
    let tries = 0
    request.mockImplementation(async (method, params) => {
      if (method === 'host.sumi.font_select') {
        if (++tries === 1) throw new Error('网络断开')
        return fontState({ pendingFont: 'Sumi Fangsong', fonts: fontState().fonts.map(font => font.family === 'Sumi Fangsong' ? { ...font, status: 'downloading' } : font) })
      }
      return base(method, params)
    })
    document.getElementById('appearance')!.click(); await settle()
    fontButton('Sumi Fangsong').click(); await settle()
    expect(fontButton('Sumi Fangsong').textContent).toContain('下载失败，点击重试')
    expect(fontButton('Sumi Fangsong').textContent).toContain('网络断开')
    expect(fontButton('Sumi Plex').getAttribute('aria-pressed')).toBe('true')
    expect(document.getElementById('notice')!.textContent).not.toContain('网络断开')
    fontButton('Sumi Fangsong').click(); await settle()
    expect(tries).toBe(2)
    expect(fontButton('Sumi Fangsong').textContent).toContain('下载中')
  })
  it('shows background download failures from polling and keeps retry available', async () => {
    const request = await setup()
    const base = request.getMockImplementation()!
    const failed = fontState({ fonts: fontState().fonts.map(font => font.family === 'Sumi Zhaohua' ? { ...font, status: 'error', error: '文件校验失败' } : font) })
    request.mockImplementation(async (method, params) => method === 'host.sumi.fonts' ? failed : base(method, params))
    document.getElementById('appearance')!.click(); await settle()
    expect(fontButton('Sumi Zhaohua').textContent).toContain('文件校验失败')
    expect(fontButton('Sumi Zhaohua').disabled).toBe(false)
  })
  it('retries status reads without downloading or replacing the appearance form', async () => {
    vi.useFakeTimers()
    const request = await setup()
    const base = request.getMockImplementation()!
    let reads = 0
    request.mockImplementation(async (method, params) => {
      if (method === 'host.sumi.fonts' && ++reads === 1) throw new Error('temporary status error')
      return base(method, params)
    })
    document.getElementById('appearance')!.click(); await settle()
    expect(document.getElementById('font-list-status')!.textContent).toContain('将自动重试')
    const size = document.querySelector<HTMLInputElement>('input[name="fontSize"]')!
    size.value = '36'
    await vi.advanceTimersByTimeAsync(750)
    expect(reads).toBe(2)
    expect(document.getElementById('font-list-status')!.textContent).toContain('系统字体')
    expect(document.querySelector('input[name="fontSize"]')).toBe(size)
    expect(size.value).toBe('36')
    expect(request.mock.calls.some(([method]) => method === 'host.sumi.font_select')).toBe(false)
  })
  it('does not let an old status response replace the latest selection result', async () => {
    const request = await setup()
    const base = request.getMockImplementation()!
    let finishStatus!: (value: FontState) => void
    request.mockImplementation((method, params) => method === 'host.sumi.fonts'
      ? new Promise(resolve => { finishStatus = resolve as (value: FontState) => void })
      : method === 'host.sumi.font_select' ? Promise.resolve(fontState({ pendingFont: 'Sumi Youcha', fonts: fontState().fonts.map(font => font.family === 'Sumi Youcha' ? { ...font, status: 'downloading' } : font) }))
        : base(method, params))
    document.getElementById('appearance')!.click(); await settle()
    fontButton('Sumi Youcha').click(); await settle()
    finishStatus(fontState()); await settle()
    expect(fontButton('Sumi Youcha').textContent).toContain('下载中')
    expect(fontButton('Sumi Youcha').textContent).toContain('完成后使用')
  })
  it('ignores older selection replies when another font was chosen later', async () => {
    const request = await setup()
    const base = request.getMockImplementation()!
    const finishes = new Map<string, (value: FontState) => void>()
    request.mockImplementation((method, params) => method === 'host.sumi.font_select'
      ? new Promise(resolve => { finishes.set((params as { fontFamily: string }).fontFamily, resolve as (value: FontState) => void) })
      : base(method, params))
    document.getElementById('appearance')!.click(); await settle()
    fontButton('Sumi WenKai').click(); fontButton('Sumi Youcha').click(); await settle()
    const downloading = fontState().fonts.map(font => ['Sumi WenKai', 'Sumi Youcha'].includes(font.family) ? { ...font, status: 'downloading' as const } : font)
    finishes.get('Sumi Youcha')!(fontState({ pendingFont: 'Sumi Youcha', fonts: downloading })); await settle()
    finishes.get('Sumi WenKai')!(fontState({ pendingFont: 'Sumi WenKai', fonts: downloading })); await settle()
    expect(fontButton('Sumi Youcha').textContent).toContain('完成后使用')
    expect(fontButton('Sumi WenKai').textContent).not.toContain('完成后使用')
  })
  it('discards late font responses after switching panels or unloading', async () => {
    vi.useFakeTimers()
    const request = await setup()
    const base = request.getMockImplementation()!
    let finish!: (value: FontState) => void
    request.mockImplementation((method, params) => method === 'host.sumi.fonts'
      ? new Promise(resolve => { finish = resolve as (value: FontState) => void }) : base(method, params))
    document.getElementById('appearance')!.click(); await settle()
    document.getElementById('sync')!.click(); await settle()
    finish(fontState()); await settle()
    expect(document.querySelector('#panel-body .font-list')).toBeNull()
    expect(document.querySelector('input[name="serviceUrl"]')).not.toBeNull()
    request.mockClear(); await vi.advanceTimersByTimeAsync(3000)
    expect(request).not.toHaveBeenCalled()
    document.getElementById('appearance')!.click(); await settle()
    window.dispatchEvent(new Event('pagehide'))
    request.mockClear(); finish(fontState()); await settle(); await vi.advanceTimersByTimeAsync(3000)
    expect(request).not.toHaveBeenCalled()
  })
  it('pauses hidden-window polling and resumes with a fresh local status read', async () => {
    vi.useFakeTimers()
    const request = await setup()
    document.getElementById('appearance')!.click(); await settle()
    const receive = vi.mocked(window.notemd!.onMessage!).mock.calls[0][0]
    receive({ type: 'sumi-window-state', visible: false }); await settle()
    request.mockClear(); await vi.advanceTimersByTimeAsync(3000)
    expect(request).not.toHaveBeenCalled()
    receive({ type: 'sumi-window-state', visible: true }); await settle()
    expect(request).toHaveBeenCalledWith('host.sumi.fonts', undefined)
  })
})

describe('Sumi complete interface localization', () => {
  it.each([
    { locale: 'zh-CN', lang: 'zh', name: '玄霜打字机', appearance: '外观', pages: '纸页', sync: '同步', blue: '复古蓝磷 CRT', plainExport: '仅导出 Markdown 正文…', exported: '已导出。', pairing: '一次性配对码', download: '下载失败，点击重试', fontError: '字体大小或 SHA-256 校验失败。', offline: '离线保存中。', keychain: '正在等待系统钥匙串授权', connection: '连接' },
    { locale: 'ja-JP', lang: 'ja', name: 'すみ', appearance: '外観', pages: 'ページ', sync: '同期', blue: 'レトロブルー蛍光 CRT', plainExport: 'Markdown 本文のみを書き出す…', exported: '書き出しました。', pairing: 'ワンタイムペアリングコード', download: 'ダウンロード失敗。クリックして再試行', fontError: 'フォントサイズまたは SHA-256 の検証に失敗しました。', offline: 'オフラインで保存中。', keychain: 'キーチェーンへのアクセス許可を待っています', connection: '接続' },
    { locale: 'en-US', lang: 'en', name: 'Sumi Typewriter', appearance: 'Appearance', pages: 'Pages', sync: 'Sync', blue: 'Retro Blue Phosphor CRT', plainExport: 'Export Markdown text only…', exported: 'Exported.', pairing: 'One-time pairing code', download: 'Download failed; click to retry', fontError: 'Font size or SHA-256 verification failed.', offline: 'Saving offline.', keychain: 'Waiting for Keychain access', connection: 'Connect' },
  ])('covers appearance, fonts, pages, export, sync and diagnostics in $locale', async labels => {
    const userText = '第一行 / ユーザーの文章 / <img src=x>'
    const preferences = { ...defaultPreferences, theme: 'crt-blue' as const, fontFamily: 'Sumi WenKai', fontSize: 32, caretMotion: 'steady' as const }
    const current = state({ preferences, pages: [{ id: 'page-a', excerpt: userText, deleted: false }, { id: 'page-trash', excerpt: '原稿', deleted: true }], sync: { connected: true, pending: 0 } })
    const request = await setup(current, undefined, labels.locale)
    const base = request.getMockImplementation()!
    request.mockImplementation(async (method, params) => {
      if (method === 'host.sumi.export') return { saved: true }
      if (method === 'host.sumi.fonts') return fontState({ fonts: fontState().fonts.map(font => ({ ...font, status: 'error', error: 'Font size or SHA-256 verification failed' })) })
      return base(method, params)
    })
    expect(document.documentElement.lang).toBe(labels.lang)
    expect(document.title).toBe(labels.name)
    expect(document.getElementById('surface')!.getAttribute('aria-label')).toBe(labels.name)
    expect(document.getElementById('tools')!.getAttribute('aria-label')).toBe(labels.name)
    expect(document.getElementById('appearance')!.getAttribute('aria-label')).toBe(labels.appearance)
    expect(document.getElementById('panel')!.getAttribute('aria-labelledby')).toBe('panel-title')
    document.getElementById('appearance')!.click(); await settle()
    expect(document.getElementById('panel-title')!.textContent).toBe(labels.appearance)
    const appearanceForm = document.querySelector<HTMLFormElement>('#panel-body form')!
    expect(appearanceForm.querySelector('option[value="crt-blue"]')!.textContent).toBe(labels.blue)
    expect(document.querySelector('.font-detail')!.textContent).toContain(labels.download)
    expect(document.querySelector('.font-detail')!.textContent).toContain(labels.fontError)
    expect(request.mock.calls.some(([method]) => method === 'host.sumi.font_select')).toBe(false)
    appearanceForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle()
    expect(request).toHaveBeenCalledWith('host.sumi.preferences', { preferences, preserveFont: true })

    document.getElementById('pages')!.click(); await settle()
    expect(document.getElementById('panel-title')!.textContent).toBe(labels.pages)
    expect(document.querySelector('.page-open')!.textContent).toBe(userText)
    expect(document.querySelector('#panel img')).toBeNull()
    const exportButton = [...document.querySelectorAll<HTMLButtonElement>('#panel-body button')].find(button => button.textContent === labels.plainExport)!
    expect(exportButton).toBeDefined(); exportButton.click(); await settle()
    expect(request).toHaveBeenCalledWith('host.sumi.export', { pageId: 'page-a', format: 'markdown' })
    expect(document.getElementById('notice')!.textContent).toBe(labels.exported)

    document.getElementById('sync')!.click(); await settle()
    expect(document.getElementById('panel-title')!.textContent).toBe(labels.sync)
    expect(document.querySelector('#panel-body button[type="submit"]')!.textContent).toBe(labels.connection)
    document.getElementById('sync-invite')!.click(); await settle()
    expect(document.querySelector('textarea')!.getAttribute('aria-label')).toBe(labels.pairing)
    const input = document.querySelector<HTMLInputElement>('input[name="serviceUrl"]')!
    input.value = 'https://user.example/同期'
    const receive = vi.mocked(window.notemd!.onMessage!).mock.calls[0][0]
    receive({ type: 'sumi-state', state: { ...current, sync: { connected: false, pending: 1, message: '正在等待系统钥匙串授权，请查看系统授权窗口；文字保存在本机' } } }); await settle()
    expect(document.getElementById('notice')!.textContent).toContain(labels.keychain)
    expect(input.value).toBe('https://user.example/同期')
    receive({ type: 'sumi-state', state: { ...current, sync: { connected: false, pending: 1, message: '离线保存中：NET_RESET' } } }); await settle()
    expect(document.getElementById('notice')!.textContent).toContain(labels.offline)
    expect(document.getElementById('notice')!.textContent).toContain('NET_RESET')
    receive({ type: 'sumi-error', message: '-32000: CUSTOM_KEEP_ME' }); await settle()
    expect(document.getElementById('notice')!.textContent).toContain('-32000: ')
    expect(document.getElementById('notice')!.textContent).toContain('CUSTOM_KEEP_ME')
  })
  it('uses the bridge language, falls back to English, and reloads without changing preferences', async () => {
    const preferences = { ...defaultPreferences, theme: 'crt-blue' as const, fontFamily: 'Sumi CRT', fontSize: 45 }
    await setup(state({ preferences }), undefined, 'ja-JP')
    expect(document.title).toBe('すみ')
    window.dispatchEvent(new Event('pagehide'))
    const request = await setup(state({ preferences }), undefined, 'fr-FR')
    expect(document.documentElement.lang).toBe('en')
    expect(document.title).toBe('Sumi Typewriter')
    document.getElementById('appearance')!.click(); await settle()
    const form = document.querySelector<HTMLFormElement>('#panel-body form')!
    expect(document.getElementById('panel-title')!.textContent).toBe('Appearance')
    expect((form.elements.namedItem('theme') as HTMLSelectElement).value).toBe('crt-blue')
    expect((form.elements.namedItem('fontSize') as HTMLInputElement).value).toBe('45')
    expect(request.mock.calls.some(([method]) => method === 'host.sumi.font_select')).toBe(false)
  })
})


describe('Sumi independent typing sound settings', () => {
  const sound = (overrides: Partial<SoundState> = {}): SoundState => ({ enabled: true, preset: 'typewriter', permission: 'required', status: 'permission_required', ...overrides })
  const enabled = () => document.querySelector<HTMLInputElement>('#sound-enabled')!
  const preset = () => document.querySelector<HTMLSelectElement>('#sound-preset')!
  const change = (element: HTMLElement) => element.dispatchEvent(new Event('change', { bubbles: true }))
  async function open(locale = 'en', initial = sound()) {
    const request = await setup(state(), undefined, locale), base = request.getMockImplementation()!
    request.mockImplementation(async (method, params) => method === 'host.sumi.sound_state' ? initial : base(method, params))
    document.getElementById('appearance')!.click(); await settle()
    return request
  }
  it.each([
    ['zh', '键盘音效', '打字机', '低沉机械键', '允许输入监控'],
    ['en', 'Typing sounds', 'Typewriter', 'Thock', 'Allow Input Monitoring'],
    ['ja', '打鍵音', 'タイプライター', '低音メカニカル', '入力監視を許可'],
  ])('reads defaults and exposes localized controls without requesting permission in %s', async (locale, heading, first, second, permission) => {
    const request = await open(locale)
    expect(document.querySelector('.sound-settings')!.getAttribute('aria-label')).toBe(heading)
    expect(Array.from(preset().options).map(option => option.textContent)).toEqual([first, second])
    expect(enabled().checked).toBe(true); expect(preset().value).toBe('typewriter')
    expect(document.getElementById('sound-permission')!.textContent).toBe(permission)
    expect(document.getElementById('sound-permission')!.hidden).toBe(false)
    expect(request).toHaveBeenCalledWith('host.sumi.sound_state', {})
    expect(request.mock.calls.some(([method]) => ['host.sumi.sound_set', 'host.sumi.sound_request_permission', 'host.sumi.font_select'].includes(method))).toBe(false)
  })
  it('saves disabling and changing the retained preset without changing appearance or enabling sound', async () => {
    const request = await open(), base = request.getMockImplementation()!
    request.mockImplementation(async (method, params) => method === 'host.sumi.sound_set' ? sound({ ...(params as Partial<SoundState>), status: 'off' }) : base(method, params))
    enabled().checked = false; change(enabled()); await settle()
    expect(request).toHaveBeenCalledWith('host.sumi.sound_set', { enabled: false, preset: 'typewriter' })
    preset().value = 'thock'; change(preset()); await settle()
    expect(request).toHaveBeenCalledWith('host.sumi.sound_set', { enabled: false, preset: 'thock' })
    expect(enabled().checked).toBe(false); expect(preset().disabled).toBe(false)
    expect(request.mock.calls.some(([method]) => method === 'host.sumi.preferences')).toBe(false)
    document.querySelector<HTMLFormElement>('#panel-body form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle()
    expect(request).toHaveBeenCalledWith('host.sumi.preferences', { preferences: defaultPreferences, preserveFont: true })
    expect(request.mock.calls.filter(([method]) => method === 'host.sumi.sound_set')).toHaveLength(2)
  })
  it('requests Input Monitoring only after the explicit button and displays the returned status', async () => {
    const request = await open(), base = request.getMockImplementation()!
    request.mockImplementation(async (method, params) => method === 'host.sumi.sound_request_permission' ? sound({ permission: 'granted', status: 'ready' }) : base(method, params))
    document.getElementById('sound-permission')!.click(); await settle()
    expect(request).toHaveBeenCalledWith('host.sumi.sound_request_permission', {})
    expect(document.getElementById('sound-status')!.textContent).toContain('ready')
    expect(document.getElementById('sound-permission')!.hidden).toBe(true)
  })
  it('keeps controls disabled after a failed read and retries without assuming readiness', async () => {
    const request = await setup(state(), undefined, 'en'), base = request.getMockImplementation()!
    let reads = 0
    request.mockImplementation(async (method, params) => {
      if (method === 'host.sumi.sound_state') { if (++reads === 1) throw new Error('-32000: AUDIO_UNAVAILABLE'); return sound({ permission: 'unsupported', status: 'unavailable' }) }
      return base(method, params)
    })
    document.getElementById('appearance')!.click(); await settle()
    expect(enabled().disabled).toBe(true)
    expect(document.getElementById('sound-status')!.textContent).toContain('-32000: ')
    expect(document.getElementById('sound-status')!.textContent).toContain('AUDIO_UNAVAILABLE')
    expect(document.getElementById('sound-status')!.textContent).not.toContain('ready')
    document.getElementById('sound-retry')!.click(); await settle()
    expect(reads).toBe(2); expect(document.getElementById('sound-status')!.textContent).toContain('unavailable')
    expect(document.getElementById('sound-permission')!.hidden).toBe(true)
  })
  it('serializes writes and retries the failed intent without changing unrelated fields', async () => {
    const request = await open(), base = request.getMockImplementation()!
    let reject!: (reason: Error) => void, writes = 0
    request.mockImplementation((method, params) => {
      if (method === 'host.sumi.sound_set') {
        if (++writes === 1) return new Promise((_, fail) => { reject = fail })
        return Promise.resolve(sound({ ...(params as Partial<SoundState>), status: 'off' }))
      }
      return base(method, params)
    })
    enabled().checked = false; change(enabled()); await settle()
    expect(enabled().disabled).toBe(true); expect(preset().disabled).toBe(true)
    preset().value = 'thock'; change(preset()); await settle(); expect(writes).toBe(1)
    reject(new Error('AUDIO_WRITE_FAILED')); await settle()
    expect(enabled().checked).toBe(true)
    expect(document.getElementById('sound-status')!.textContent).toContain('AUDIO_WRITE_FAILED')
    document.getElementById('sound-retry')!.click(); await settle()
    expect(writes).toBe(2); expect(enabled().checked).toBe(false); expect(preset().value).toBe('typewriter')
    expect(request.mock.calls.filter(([method]) => method === 'host.sumi.sound_set').map(([, params]) => params)).toEqual([{ enabled: false, preset: 'typewriter' }, { enabled: false, preset: 'typewriter' }])
  })
  it('discards late results after switching panels and refreshes after a hidden window returns', async () => {
    const request = await open(), base = request.getMockImplementation()!
    let finish!: (value: SoundState) => void
    request.mockImplementation((method, params) => method === 'host.sumi.sound_set' ? new Promise(resolve => { finish = resolve as (value: SoundState) => void }) : base(method, params))
    enabled().checked = false; change(enabled()); await settle()
    document.getElementById('sync')!.click(); await settle()
    finish(sound({ enabled: false, status: 'off' })); await settle()
    expect(document.getElementById('sound-status')).toBeNull()
    expect(document.querySelector('input[name="serviceUrl"]')).not.toBeNull()
    document.getElementById('appearance')!.click(); await settle()
    const receive = vi.mocked(window.notemd!.onMessage!).mock.calls[0][0]
    receive({ type: 'sumi-window-state', visible: false }); await settle()
    request.mockClear(); receive({ type: 'sumi-window-state', visible: true }); await settle()
    expect(request).toHaveBeenCalledWith('host.sumi.sound_state', {})
    expect(request.mock.calls.some(([method]) => method === 'host.sumi.sound_request_permission')).toBe(false)
  })
})
