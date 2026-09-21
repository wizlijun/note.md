import { mount, tick, unmount } from 'svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from './App.svelte'

const bridge = vi.hoisted(() => ({
  listener: undefined as ((document: { uri: string; content: string; requestId: number }) => void) | undefined,
  renderDocument: vi.fn(),
  renderNext: vi.fn(),
}))

vi.mock('./lib/bridge', () => ({
  locale: () => 'zh',
  onDocument: (listener: typeof bridge.listener) => {
    bridge.listener = listener
    return () => { bridge.listener = undefined }
  },
  renderDocument: bridge.renderDocument,
  renderNext: bridge.renderNext,
}))

describe('Typst Reader', () => {
  let component: ReturnType<typeof mount> | undefined

  afterEach(() => {
    if (component) unmount(component)
    component = undefined
    bridge.listener = undefined
    bridge.renderDocument.mockReset()
    bridge.renderNext.mockReset()
    document.body.innerHTML = ''
  })

  it('shows pages after the first batch and keeps rendering later batches', async () => {
    let finishContinuation: ((value: unknown) => void) | undefined
    bridge.renderDocument.mockResolvedValue({ cache_key: 'a'.repeat(64), page_count: 0, hit: false, complete: false })
    bridge.renderNext
      .mockResolvedValueOnce({ cache_key: 'a'.repeat(64), page_count: 2, hit: false, complete: false })
      .mockImplementationOnce(() => new Promise(resolve => { finishContinuation = resolve }))

    component = mount(App, { target: document.body })
    await tick()
    bridge.listener?.({ uri: '/vault/book.typeset.md', content: '# One\n\n# Two', requestId: 1 })
    await vi.waitFor(() => expect(document.querySelectorAll('.page-slot')).toHaveLength(2))
    expect(document.querySelector('.progress')?.textContent).toContain('已完成 2 页')

    finishContinuation?.({ cache_key: 'a'.repeat(64), page_count: 4, hit: false, complete: true })
    await vi.waitFor(() => expect(document.querySelectorAll('.page-slot')).toHaveLength(4))
    expect(document.querySelector('.progress')).toBeNull()
  })

  it('puts zoom choices in the page context menu', async () => {
    bridge.renderDocument.mockResolvedValue({ cache_key: 'b'.repeat(64), page_count: 1, hit: true, complete: true })
    component = mount(App, { target: document.body })
    await tick()
    bridge.listener?.({ uri: '/vault/book.typeset.md', content: '# Book', requestId: 1 })
    await vi.waitFor(() => expect(document.querySelector('.pages')).not.toBeNull())

    document.querySelector('.pages')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 80, clientY: 90 }))
    await tick()
    const menu = document.querySelector('[role="menu"]')
    expect(menu?.classList.contains('menu-panel')).toBe(true)
    expect([...document.querySelectorAll('[role="menuitemradio"]')].map(item => item.textContent?.trim())).toEqual(['75%', '100%✓', '125%', '150%'])

    ;(document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')[2]).click()
    await tick()
    expect(document.querySelector('.scaled')?.getAttribute('style')).toContain('992.5px')
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })
})
