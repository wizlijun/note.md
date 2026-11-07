/** @vitest-environment happy-dom */
import { afterEach, expect, it, vi } from 'vitest'
import { diagramViewportFor, followDiagramLink } from './diagram-links'

afterEach(() => document.body.replaceChildren())
function fixture(href: string, xlink = false, preventNative = false) {
  const host = document.createElement('div'), viewport = document.createElement('div')
  viewport.className = 'diagram-viewport'; viewport.dataset.diagramInteraction = ''
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  const anchor = document.createElementNS('http://www.w3.org/2000/svg', 'a')
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  if (xlink) anchor.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', href)
  else anchor.setAttribute('href', href)
  anchor.append(path); svg.append(anchor); viewport.append(svg); host.append(viewport); document.body.append(host)
  const open = vi.fn(), earlyOpen = vi.fn()
  host.addEventListener('mousedown', event => { if (!diagramViewportFor(event.target)) earlyOpen() }, true)
  // ProseMirror installs this fallback before RichEditor's delegated listener.
  if (preventNative) host.addEventListener('click', event => event.preventDefault())
  host.addEventListener('click', event => followDiagramLink(event, open))
  return { host, viewport, path, open, earlyOpen }
}
function click(target: Element) {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true })
  target.dispatchEvent(event); return event
}
it.each([false, true])('follows a completed SVG link through the host opener once (xlink=%s)', xlink => {
  const f = fixture('../linked.md', xlink)
  f.path.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
  expect(f.earlyOpen).not.toHaveBeenCalled(); expect(f.open).not.toHaveBeenCalled()
  expect(click(f.path).defaultPrevented).toBe(true)
  expect(f.open).toHaveBeenCalledExactlyOnceWith('../linked.md')
})
it('lets the viewer reject a drag click before the host opens any link', () => {
  const f = fixture('https://example.com')
  f.viewport.addEventListener('click', event => { event.preventDefault(); event.stopImmediatePropagation() }, true)
  f.path.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
  expect(click(f.path).defaultPrevented).toBe(true)
  expect(f.earlyOpen).not.toHaveBeenCalled(); expect(f.open).not.toHaveBeenCalled()
})
it.each(['javascript:alert(1)', ' JaVa\tScript:alert(1)', 'data:text/html,bad', 'vbscript:bad'])('blocks active-content URL %s and native navigation', href => {
  const f = fixture(href)
  expect(click(f.path).defaultPrevented).toBe(true)
  expect(f.open).not.toHaveBeenCalled()
})
it('follows a diagram link after ProseMirror has only prevented native navigation', () => {
  const f = fixture('https://example.com', false, true)
  expect(click(f.path).defaultPrevented).toBe(true)
  expect(f.open).toHaveBeenCalledExactlyOnceWith('https://example.com')
})
it('leaves ordinary body links to their existing owner', () => {
  const f = fixture('https://example.com')
  f.viewport.removeAttribute('data-diagram-interaction')
  expect(click(f.path).defaultPrevented).toBe(false)
  expect(f.open).not.toHaveBeenCalled()
})
