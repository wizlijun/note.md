import { mount, tick, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App.svelte'

const bridge = vi.hoisted(() => ({
  listener: undefined as ((document: { uri: string; content: string; requestId: number }) => void) | undefined,
  renderDocument: vi.fn(),
  renderNext: vi.fn(),
  loadBookStyleRule: vi.fn(),
  saveBookStyleRule: vi.fn(),
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
}))

describe('Typst Reader', () => {
  let component: ReturnType<typeof mount> | undefined

  beforeEach(() => {
    bridge.loadBookStyleRule.mockResolvedValue('auto')
    bridge.saveBookStyleRule.mockResolvedValue(undefined)
  })

  afterEach(() => {
    if (component) unmount(component)
    component = undefined
    bridge.listener = undefined
    bridge.renderDocument.mockReset()
    bridge.renderNext.mockReset()
    bridge.loadBookStyleRule.mockReset()
    bridge.saveBookStyleRule.mockReset()
    document.body.innerHTML = ''
  })

  it('shows pages after the first batch and keeps rendering later batches', async () => {
    let finishContinuation: ((value: unknown) => void) | undefined
    bridge.renderDocument.mockResolvedValue({ cache_key: 'a'.repeat(64), page_count: 0, hit: false, complete: false, busy: false })
    bridge.renderNext
      .mockResolvedValueOnce({ cache_key: 'a'.repeat(64), page_count: 0, hit: false, complete: false, busy: true })
      .mockResolvedValueOnce({ cache_key: 'a'.repeat(64), page_count: 2, hit: false, complete: false, busy: false })
      .mockImplementationOnce(() => new Promise(resolve => { finishContinuation = resolve }))

    component = mount(App, { target: document.body })
    await tick()
    bridge.listener?.({ uri: '/vault/book.typeset.md', content: '# One\n\n# Two', requestId: 1 })
    await vi.waitFor(() => expect(document.querySelectorAll('.page-slot')).toHaveLength(2))
    expect(bridge.renderNext).toHaveBeenCalledTimes(3)
    expect(document.querySelector('.progress')?.textContent).toContain('已完成 2 页')

    finishContinuation?.({ cache_key: 'a'.repeat(64), page_count: 4, hit: false, complete: true, busy: false })
    await vi.waitFor(() => expect(document.querySelectorAll('.page-slot')).toHaveLength(4))
    expect(document.querySelector('.progress')).toBeNull()
  })

  it('puts zoom choices in the page context menu', async () => {
    bridge.renderDocument.mockResolvedValue({ cache_key: 'b'.repeat(64), page_count: 1, hit: true, complete: true, busy: false })
    component = mount(App, { target: document.body })
    await tick()
    bridge.listener?.({ uri: '/vault/book.typeset.md', content: '# Book', requestId: 1 })
    await vi.waitFor(() => expect(document.querySelector('.pages')).not.toBeNull())

    document.querySelector('.pages')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 80, clientY: 90 }))
    await tick()
    const menu = document.querySelector('[role="menu"]')
    expect(menu?.classList.contains('menu-panel')).toBe(true)
    expect([...document.querySelectorAll('[role="menuitemradio"]')].map(item => item.textContent?.trim())).toEqual([
      '自动（根据正文语言）✓', 'Wonderous Book', 'AI Writer（中日韩）', '75%', '100%✓', '125%', '150%',
    ])

    ;(document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')[5]).click()
    await tick()
    expect(document.querySelector('.scaled')?.getAttribute('style')).toContain('992.5px')
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })

  it('persists a template rule from the context menu and rerenders the document', async () => {
    bridge.renderDocument.mockResolvedValue({ cache_key: 'c'.repeat(64), page_count: 1, hit: true, complete: true, busy: false })
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
})
