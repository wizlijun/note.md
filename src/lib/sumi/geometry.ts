import type { NativeBounds } from './session'

/** Native NSViews do not participate in DOM z-index; hide for intersecting host popups. */
export function nativeSurfaceOccluded(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect()
  for (const overlay of document.querySelectorAll<HTMLElement>('.menu-panel, [role="dialog"], [aria-modal="true"], dialog[open], [data-native-editor-occlusion]')) {
    if (element.contains(overlay) || overlay.contains(element)) continue
    const style = getComputedStyle(overlay)
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue
    const other = overlay.getBoundingClientRect()
    if (other.width > 0 && other.height > 0 && other.left < rect.right && other.right > rect.left && other.top < rect.bottom && other.bottom > rect.top) return true
  }
  return document.hidden
}
export function boundsForNative(element: HTMLElement, scale = 1): NativeBounds {
  const rect = element.getBoundingClientRect()
  const left = Math.max(0, rect.left), top = Math.max(0, rect.top)
  return { x: left * scale, y: top * scale, width: Math.max(0, Math.min(window.innerWidth, rect.right) - left) * scale, height: Math.max(0, Math.min(window.innerHeight, rect.bottom) - top) * scale }
}
