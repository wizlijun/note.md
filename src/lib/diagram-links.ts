export function diagramViewportFor(target: EventTarget | null): Element | null {
  return target instanceof Element ? target.closest('.diagram-viewport[data-diagram-interaction]') : null
}

/** Runs in the bubble phase, after the viewer has rejected drag-generated clicks. */
export function followDiagramLink(event: MouseEvent, open: (href: string) => void): boolean {
  const viewport = diagramViewportFor(event.target)
  if (!viewport || event.button !== 0 || !(event.target instanceof Element)) return false
  const anchor = event.target.closest('a')
  if (!anchor || !viewport.contains(anchor)) return false
  const href = anchor.getAttribute('href') ?? anchor.getAttributeNS('http://www.w3.org/1999/xlink', 'href') ?? anchor.getAttribute('xlink:href')
  if (href === null) return false
  // ProseMirror may already prevent native navigation without following the
  // link. That is not a handled diagram click: drag rejection stops propagation
  // in the viewport before this bubble listener can run.
  event.preventDefault()
  event.stopPropagation()
  // SVG links must never execute script/data navigation inside the WebView.
  if (!/^(?:javascript|vbscript|data):/i.test(href.replace(/[\u0000-\u0020\u007f]/g, ''))) open(href)
  return true
}
