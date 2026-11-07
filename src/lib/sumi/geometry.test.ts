// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { boundsForNative, nativeSurfaceOccluded } from './geometry'

function element(rect: DOMRect, className = '') {
  const node = document.createElement('div')
  node.className = className
  node.getBoundingClientRect = () => rect
  document.body.append(node)
  return node
}
afterEach(() => { document.body.innerHTML = '' })

describe('native surface clipping and host overlays', () => {
  it('clips to the WebView viewport and converts CSS pixels to native points', () => {
    const node = element(new DOMRect(-20, 10, window.innerWidth + 40, 200))
    expect(boundsForNative(node, 1.25)).toEqual({ x: 0, y: 12.5, width: window.innerWidth * 1.25, height: 250 })
  })
  it('hides only when a visible host popup intersects the surface', () => {
    const node = element(new DOMRect(100, 100, 400, 300))
    const menu = element(new DOMRect(0, 0, 80, 80), 'menu-panel')
    expect(nativeSurfaceOccluded(node)).toBe(false)
    menu.getBoundingClientRect = () => new DOMRect(120, 120, 80, 80)
    expect(nativeSurfaceOccluded(node)).toBe(true)
    menu.style.display = 'none'
    expect(nativeSurfaceOccluded(node)).toBe(false)
  })
  it('recognizes modal dialogs without requiring menu styles', () => {
    const node = element(new DOMRect(0, 0, 400, 300))
    const modal = element(new DOMRect(10, 10, 100, 100))
    modal.setAttribute('role', 'dialog')
    expect(nativeSurfaceOccluded(node)).toBe(true)
  })
})
