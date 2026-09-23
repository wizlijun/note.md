import { mount, tick, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App.svelte'

const bridge = vi.hoisted(() => ({
  listener: undefined as ((document: { uri: string; content: string; requestId: number }) => void) | undefined,
  renderDocument: vi.fn(),
  renderNext: vi.fn(),
  loadBookStyleRule: vi.fn(),
  saveBookStyleRule: vi.fn(),
  cancelRender: vi.fn(),
  loadPage: vi.fn(),
  downloadFonts: vi.fn(),
  fontDownloadStatus: vi.fn(),
}))

vi.mock('./lib/bridge', () => ({
  locale: () => 'zh',
  onDocument: (listener: typeof bridge.listener) => {
    bridge.listener = listener
    return () => { bridge.listener = undefined }
  },
  renderDocument: bridge.renderDocument,
  renderNext: bridge.renderNext,
  loadBookStyleRule: bridge.loadBookStyleRule,
  saveBookStyleRule: bridge.saveBookStyleRule,
  cancelRender: bridge.cancelRender,
  loadPage: bridge.loadPage,
  downloadFonts: bridge.downloadFonts,
  fontDownloadStatus: bridge.fontDownloadStatus,
}))

describe('Typst Reader', () => {
  let component: ReturnType<typeof mount> | undefined

  beforeEach(() => {
    bridge.loadBookStyleRule.mockResolvedValue('auto')
    bridge.cancelRender.mockResolvedValue(undefined)
    bridge.loadPage.mockResolvedValue('<svg></svg>')
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:page'), revokeObjectURL: vi.fn() }))
    bridge.saveBookStyleRule.mockResolvedValue(undefined)
  })

  afterEach(async () => {
    if (component) await unmount(component)
    component = undefined
    bridge.listener = undefined
    bridge.renderDocument.mockReset()
    bridge.renderNext.mockReset()
    bridge.loadBookStyleRule.mockReset()
    bridge.saveBookStyleRule.mockReset()
    bridge.cancelRender.mockReset()
    bridge.loadPage.mockReset()
    bridge.downloadFonts.mockReset()
    bridge.fontDownloadStatus.mockReset()
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('shows pages after the first batch and keeps rendering later batches', async () => {
    let finishContinuation: ((value: unknown) => void) | undefined
    bridge.renderDocument.mockResolvedValue({ render_id: 'render-1', stage: 'rendering', completed_chunks: 1, total_chunks: 2, cache_key: 'a'.repeat(64), page_count: 0, hit: false, complete: false, busy: false })
    bridge.renderNext
      .mockResolvedValueOnce({ render_id: 'render-1', stage: 'rendering', completed_chunks: 1, total_chunks: 2, cache_key: 'a'.repeat(64), page_count: 0, hit: false, complete: false, busy: true })
      .mockResolvedValueOnce({ render_id: 'render-1', stage: 'rendering', completed_chunks: 1, total_chunks: 2, cache_key: 'a'.repeat(64), page_count: 2, hit: false, complete: false, busy: false })
      .mockImplementationOnce(() => new Promise(resolve => { finishContinuation = resolve }))

    component = mount(App, { target: document.body })
    await tick()
    bridge.listener?.({ uri: '/vault/book.typeset.md', content: '# One\n\n# Two', requestId: 1 })
    await vi.waitFor(() => expect(document.querySelectorAll('.page-slot')).toHaveLength(2))
    await vi.waitFor(() => expect(bridge.renderNext).toHaveBeenCalledTimes(3))
    expect(document.querySelector('.progress')?.textContent).toContain('2 页')

    finishContinuation?.({ render_id: 'render-1', stage: 'complete', completed_chunks: 1, total_chunks: 2, cache_key: 'a'.repeat(64), page_count: 4, hit: false, complete: true, busy: false })
    await vi.waitFor(() => expect(document.querySelectorAll('.page-slot')).toHaveLength(4))
    expect(document.querySelector('.progress')).toBeNull()
  })

  it('puts zoom choices in the page context menu', async () => {
    bridge.renderDocument.mockResolvedValue({ render_id: 'render-1', stage: 'complete', completed_chunks: 1, total_chunks: 2, cache_key: 'b'.repeat(64), page_count: 1, hit: true, complete: true, busy: false })
    component = mount(App, { target: document.body })
    await tick()
    bridge.listener?.({ uri: '/vault/book.typeset.md', content: '# Book', requestId: 1 })
    await vi.waitFor(() => expect(document.querySelector('.pages')).not.toBeNull())

    document.querySelector('.pages')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 80, clientY: 90 }))
    await tick()
    const menu = document.querySelector('[role="menu"]')
    expect(menu?.classList.contains('menu-panel')).toBe(true)
    expect([...document.querySelectorAll('[role="menuitemradio"]')].map(item => item.textContent?.trim())).toEqual([
      '自动（根据正文语言）✓', 'Wonderous Book', '中文书籍（CJK）', '75%', '100%✓', '125%', '150%',
    ])

    ;(document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')[5]).click()
    await tick()
    expect(document.querySelector('.scaled')?.getAttribute('style')).toContain('992.5px')
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })

  it('downloads the selected template fonts and rerenders after installation', async () => {
    bridge.renderDocument.mockResolvedValue({ render_id: 'render-1', stage: 'complete', completed_chunks: 1, total_chunks: 1, cache_key: 'd'.repeat(64), page_count: 1, hit: true, complete: true, busy: false })
    bridge.downloadFonts.mockResolvedValue({ style: 'cjk', stage: 'complete', completed: 3, total: 3 })
    component = mount(App, { target: document.body })
    await tick()
    const opened = { uri: '/vault/book.typeset.md', content: '# 中文书', requestId: 1 }
    bridge.listener?.(opened)
    await vi.waitFor(() => expect(document.querySelector('.pages')).not.toBeNull())
    document.querySelector('main')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
    await tick()
    const download = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find(button => button.textContent?.includes('下载中文模板字体'))!
    download.click()
    await vi.waitFor(() => expect(bridge.downloadFonts).toHaveBeenCalledWith('cjk'))
    await vi.waitFor(() => expect(bridge.renderDocument).toHaveBeenCalledTimes(2))
    expect(bridge.renderDocument).toHaveBeenLastCalledWith(opened, 'auto')
  })

  it('persists a template rule from the context menu and rerenders the document', async () => {
    bridge.renderDocument.mockResolvedValue({ render_id: 'render-1', stage: 'complete', completed_chunks: 1, total_chunks: 2, cache_key: 'c'.repeat(64), page_count: 1, hit: true, complete: true, busy: false })
    component = mount(App, { target: document.body })
    await tick()
    const opened = { uri: '/vault/book.typeset.md', content: '# Book', requestId: 1 }
    bridge.listener?.(opened)
    await vi.waitFor(() => expect(document.querySelector('.pages')).not.toBeNull())

    document.querySelector('main')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 80, clientY: 90 }))
    await tick()
    const wonderous = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
      .find(item => item.textContent?.includes('Wonderous'))!
    wonderous.click()

    await vi.waitFor(() => expect(bridge.saveBookStyleRule).toHaveBeenCalledWith('wonderous-book'))
    await vi.waitFor(() => expect(bridge.renderDocument).toHaveBeenLastCalledWith(opened, 'wonderous-book'))
  })
  it('shows an initial partial result even when subsequent polls add no pages', async () => {
    const partial = { render_id: 'first', stage: 'rendering', completed_chunks: 1, total_chunks: 2, cache_key: 'first-cache', page_count: 2, hit: false, complete: false, busy: true }
    bridge.renderDocument.mockResolvedValue(partial)
    bridge.renderNext.mockResolvedValue({ ...partial, stage: 'complete', complete: true, busy: false })
    component = mount(App, { target: document.body })
    await tick()
    bridge.listener?.({ uri: '/vault/book.typeset.md', content: '# Book', requestId: 1 })
    await vi.waitFor(() => expect(document.querySelectorAll('.page-slot')).toHaveLength(2))
    await vi.waitFor(() => expect(document.querySelector('.progress')).toBeNull())
    expect(bridge.renderNext).toHaveBeenCalledWith('first')
  })

  it('keeps completed pages and exposes backend errors with a retry', async () => {
    bridge.renderDocument.mockResolvedValue({ render_id: 'failed', stage: 'error', completed_chunks: 1, total_chunks: 2, cache_key: 'partial-cache', page_count: 2, hit: false, complete: false, busy: false, error: 'Missing font' })
    component = mount(App, { target: document.body })
    await tick()
    bridge.listener?.({ uri: '/vault/book.typeset.md', content: '# Book', requestId: 1 })
    await vi.waitFor(() => expect(document.querySelectorAll('.page-slot')).toHaveLength(2))
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Missing font')
    expect(document.querySelector('.retry-toast button')).not.toBeNull()
    expect(document.querySelector('.progress')).toBeNull()
    expect(bridge.renderNext).not.toHaveBeenCalled()
    expect(bridge.cancelRender).not.toHaveBeenCalled()
    document.querySelector<HTMLButtonElement>('.retry-toast button')!.click()
    await vi.waitFor(() => expect(bridge.cancelRender).toHaveBeenCalledWith('failed'))
  })

  it('cancels a render response arriving after unmount without starting polling', async () => {
    let finish!: (value: unknown) => void
    bridge.renderDocument.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    component = mount(App, { target: document.body })
    await tick()
    bridge.listener?.({ uri: '/vault/book.typeset.md', content: '# Book', requestId: 1 })
    await vi.waitFor(() => expect(bridge.renderDocument).toHaveBeenCalled())
    await unmount(component)
    component = undefined
    finish({ render_id: 'late', stage: 'queued', completed_chunks: 0, total_chunks: 0, cache_key: '', page_count: 0, hit: false, complete: false, busy: true })
    await vi.waitFor(() => expect(bridge.cancelRender).toHaveBeenCalledWith('late'))
    expect(bridge.renderNext).not.toHaveBeenCalled()
  })

  it('cancels only the old session and ignores its late poll after switching documents', async () => {
    let finish!: (value: unknown) => void
    const old = { render_id: 'old', stage: 'rendering', completed_chunks: 1, total_chunks: 2, cache_key: 'old-cache', page_count: 1, hit: false, complete: false, busy: true }
    bridge.renderDocument.mockResolvedValueOnce(old).mockResolvedValueOnce({ ...old, render_id: 'new', cache_key: 'new-cache', page_count: 2, complete: true, busy: false })
    bridge.renderNext.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    component = mount(App, { target: document.body })
    await tick()
    bridge.listener?.({ uri: '/vault/old.typeset.md', content: '# Old', requestId: 1 })
    await vi.waitFor(() => expect(bridge.renderNext).toHaveBeenCalledWith('old'))
    bridge.listener?.({ uri: '/vault/new.typeset.md', content: '# New', requestId: 2 })
    await vi.waitFor(() => expect(document.querySelectorAll('.page-slot')).toHaveLength(2))
    finish({ ...old, page_count: 10 })
    await tick()
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(document.querySelectorAll('.page-slot')).toHaveLength(2)
    expect(bridge.renderNext).toHaveBeenCalledTimes(1)
    expect(bridge.cancelRender.mock.calls).toEqual([['old']])
  })

  it('bounds mounted pages for large books and updates the range when scrolling', async () => {
    bridge.renderDocument.mockResolvedValue({ render_id: 'large', stage: 'complete', completed_chunks: 1, total_chunks: 1, cache_key: 'large-cache', page_count: 1000, hit: true, complete: true, busy: false })
    component = mount(App, { target: document.body })
    await tick()
    bridge.listener?.({ uri: '/vault/large.typeset.md', content: '# Large', requestId: 1 })
    await vi.waitFor(() => expect(document.querySelector('.pages')).not.toBeNull())
    expect(document.querySelectorAll('.page-slot').length).toBeLessThan(10)
    const pages = document.querySelector<HTMLElement>('.pages')!
    pages.scrollTop = 1145 * 500 + 24
    pages.dispatchEvent(new Event('scroll'))
    await tick()
    expect(document.querySelectorAll('.page-slot').length).toBeLessThan(10)
    expect(document.getElementById('page-501')).not.toBeNull()
    expect(document.getElementById('page-1')).toBeNull()
    expect(document.querySelector('.scaled')?.getAttribute('style')).toContain('1144978px')
    pages.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
    await tick()
    document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')[6].click()
    await tick()
    await tick()
    expect(pages.scrollTop).toBe(24 + 500 * (1123 * 1.5 + 22))
    expect(document.getElementById('page-501')).not.toBeNull()
  })

  it('re-enables template choices as soon as saving finishes while compilation continues', async () => {
    bridge.renderDocument.mockResolvedValueOnce({ render_id: 'initial', stage: 'complete', completed_chunks: 1, total_chunks: 1, cache_key: 'cache', page_count: 1, hit: true, complete: true, busy: false })
      .mockImplementationOnce(() => new Promise(() => {}))
    component = mount(App, { target: document.body })
    await tick()
    bridge.listener?.({ uri: '/vault/book.typeset.md', content: '# Book', requestId: 1 })
    await vi.waitFor(() => expect(document.querySelector('.pages')).not.toBeNull())
    const openMenu = async () => {
      document.querySelector('main')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
      await tick()
    }
    await openMenu()
    document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')[1].click()
    await vi.waitFor(() => expect(bridge.renderDocument).toHaveBeenCalledTimes(2))
    await openMenu()
    expect(document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')[2].disabled).toBe(false)
  })

  it('leaves the loading state on a poll transport failure and allows a fresh retry', async () => {
    bridge.renderDocument.mockResolvedValueOnce({ render_id: 'broken', stage: 'preparing', completed_chunks: 0, total_chunks: 0, cache_key: '', page_count: 0, hit: false, complete: false, busy: true })
      .mockResolvedValueOnce({ render_id: 'retry', stage: 'complete', completed_chunks: 1, total_chunks: 1, cache_key: 'retry-cache', page_count: 1, hit: false, complete: true, busy: false })
    bridge.renderNext.mockRejectedValue(new Error('Renderer disconnected'))
    component = mount(App, { target: document.body })
    await tick()
    bridge.listener?.({ uri: '/vault/book.typeset.md', content: '# Book', requestId: 1 })
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('Renderer disconnected'))
    expect(document.querySelector('.spinner')).toBeNull()
    expect(bridge.cancelRender).not.toHaveBeenCalled()
    document.querySelector<HTMLButtonElement>('[role="alert"] button')!.click()
    await vi.waitFor(() => expect(document.querySelectorAll('.page-slot')).toHaveLength(1))
    expect(document.querySelector('[role="alert"]')).toBeNull()
    expect(bridge.cancelRender).toHaveBeenCalledWith('broken')
  })

})
