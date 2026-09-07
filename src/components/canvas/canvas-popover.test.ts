// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { canvasPopover } from './canvas-popover'

const cleanups: Array<() => void> = []
function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, width, height, x: left, y: top, right: left + width, bottom: top + height, toJSON: () => ({}) } as DOMRect
}
function fixture(anchor = { left: 300, top: 55 }, size = { width: 180, height: 120 }, container?: HTMLElement) {
  const surface = container ?? document.createElement('div')
  surface.className = 'canvas-surface'
  if (!surface.isConnected) document.body.appendChild(surface)
  surface.getBoundingClientRect = () => rect(40, 30, 600, 400)
  const details = document.createElement('details')
  details.innerHTML = '<summary>菜单</summary><div class="toolbar-popover-panel"><button>一</button><button disabled>停用</button><button>二</button><input /></div>'
  const toolbar = document.createElement('div')
  toolbar.className = 'canvas-context-toolbar'
  surface.appendChild(toolbar)
  toolbar.appendChild(details)
  const summary = details.querySelector('summary')!
  const panel = details.querySelector<HTMLElement>('.toolbar-popover-panel')!
  summary.getBoundingClientRect = () => rect(anchor.left, anchor.top, 34, 34)
  const width = () => Math.min(size.width, Number.parseFloat(panel.style.maxWidth) || size.width)
  const height = () => panel.style.maxHeight ? Math.min(size.height, Number.parseFloat(panel.style.maxHeight)) : size.height
  panel.getBoundingClientRect = () => rect(anchor.left + (Number.parseFloat(panel.style.left) || 0), anchor.top + (Number.parseFloat(panel.style.top) || 0), width(), height())
  Object.defineProperties(panel, {
    scrollHeight: { configurable: true, get: () => size.height },
    offsetHeight: { configurable: true, get: height },
    clientHeight: { configurable: true, get: height },
  })
  const action = canvasPopover(details)
  cleanups.push(action.destroy)
  const open = () => { details.open = true; details.dispatchEvent(new Event('toggle')) }
  return { surface, toolbar, details, summary, panel, anchor, open, action }
}
function key(target: HTMLElement, key: string) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event
}
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  document.body.replaceChildren()
})

describe('Canvas popover positioning and keyboard behavior', () => {
  it('opens below a top toolbar while retaining the native details container', () => {
    const { details, panel, open } = fixture()
    open()
    expect(panel.parentElement).toBe(details)
    expect(panel.style.position).toBe('absolute')
    expect(panel.style.transform).toBe('none')
    expect(panel.getBoundingClientRect()).toMatchObject({ left: 227, top: 97, bottom: 217 })
  })
  it('flips upward at the bottom and clamps the right edge inside the canvas', () => {
    const { panel, open } = fixture({ left: 600, top: 370 })
    open()
    expect(panel.getBoundingClientRect()).toMatchObject({ right: 632, top: 242, bottom: 362 })
  })
  it('limits oversized panels to visible space and leaves their content scrollable', () => {
    const { surface, panel, open } = fixture({ left: 45, top: 120 }, { width: 400, height: 500 })
    surface.getBoundingClientRect = () => rect(40, 30, 220, 220)
    open()
    expect(panel.getBoundingClientRect()).toMatchObject({ left: 48, right: 252, top: 162, bottom: 242 })
    expect(panel.style.maxHeight).toBe('80px')
    expect(panel.style.overflow).toBe('auto')
  })
  it('repositions after nested toolbar scrolling and container resizing', () => {
    const { surface, details, panel, anchor, open } = fixture()
    open()
    anchor.left = 600
    details.dispatchEvent(new Event('scroll'))
    expect(panel.getBoundingClientRect().right).toBe(632)
    surface.getBoundingClientRect = () => rect(40, 30, 450, 400)
    window.dispatchEvent(new Event('resize'))
    expect(panel.getBoundingClientRect().right).toBe(482)
  })
  it('re-clamps when a canvas viewport update moves the contextual toolbar', async () => {
    const { toolbar, panel, anchor, open } = fixture()
    open()
    anchor.left = 600
    toolbar.style.left = '600px'
    await vi.waitFor(() => expect(panel.getBoundingClientRect().right).toBe(632))
  })
  it('keeps one menu open and dismisses outside without stealing focus', () => {
    const first = fixture()
    const second = fixture(undefined, undefined, first.surface)
    first.open()
    second.open()
    expect(first.details.open).toBe(false)
    const outside = document.createElement('button')
    document.body.appendChild(outside)
    outside.focus()
    outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    expect(second.details.open).toBe(false)
    expect(document.activeElement).toBe(outside)
  })
  it('navigates enabled buttons, preserves input arrows, and closes Escape with summary focus', () => {
    const { surface, details, summary, panel } = fixture()
    const bubbled = vi.fn()
    surface.addEventListener('keydown', bubbled)
    summary.focus()
    expect(key(summary, 'ArrowDown').defaultPrevented).toBe(true)
    const buttons = panel.querySelectorAll('button')
    expect(document.activeElement).toBe(buttons[0])
    key(buttons[0], 'ArrowRight')
    expect(document.activeElement).toBe(buttons[2])
    key(buttons[2], 'ArrowDown')
    expect(document.activeElement).toBe(buttons[0])
    expect(bubbled).not.toHaveBeenCalled()
    const input = panel.querySelector('input')!
    input.focus()
    expect(key(input, 'ArrowLeft').defaultPrevented).toBe(false)
    key(input, 'Escape')
    expect(details.open).toBe(false)
    expect(document.activeElement).toBe(summary)
    // A delayed native toggle notification must not reopen the menu or move focus.
    details.dispatchEvent(new Event('toggle'))
    expect(details.open).toBe(false)
    expect(document.activeElement).toBe(summary)
  })
  it('removes listeners and restores positioning styles when destroyed', () => {
    const { panel, details, action, open } = fixture()
    open()
    action.destroy()
    cleanups.pop()
    expect(panel.style.maxHeight).toBe('')
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    window.dispatchEvent(new Event('resize'))
    expect(details.open).toBe(true)
    expect(panel.style.left).toBe('')
  })
})
