const popovers = new Set<HTMLDetailsElement>()
const GAP = 8
const managedStyles = ['position', 'left', 'top', 'right', 'bottom', 'transform', 'max-width', 'min-width', 'max-height', 'overflow', 'box-sizing']

/** Keep native details menus inside the visible canvas, including translated toolbars. */
export function canvasPopover(details: HTMLDetailsElement): { destroy: () => void } {
  const summary = details.querySelector('summary')
  const panel = details.querySelector<HTMLElement>('.toolbar-popover-panel')
  if (!summary || !panel) return { destroy() {} }
  const surface = details.closest<HTMLElement>('.canvas-surface')
  const originalStyles = managedStyles.map((property) => [property, panel.style.getPropertyValue(property), panel.style.getPropertyPriority(property)])
  const minWidth = Number.parseFloat(getComputedStyle(panel).minWidth) || 0
  let destroyed = false

  Object.assign(panel.style, {
    position: 'absolute', left: '0px', top: '0px', right: 'auto', bottom: 'auto',
    transform: 'none', overflow: 'auto', boxSizing: 'border-box',
  })
  popovers.add(details)

  function position(): void {
    if (destroyed || !details.open || !panel || !summary) return
    const bounds = surface?.getBoundingClientRect()
    const left = Math.max(0, bounds?.left ?? 0) + GAP
    const top = Math.max(0, bounds?.top ?? 0) + GAP
    const right = Math.max(left, Math.min(window.innerWidth, bounds?.right ?? window.innerWidth) - GAP)
    const bottom = Math.max(top, Math.min(window.innerHeight, bounds?.bottom ?? window.innerHeight) - GAP)
    panel.style.maxWidth = `${right - left}px`
    panel.style.minWidth = `${Math.min(minWidth, right - left)}px`

    const anchor = summary.getBoundingClientRect()
    const before = panel.getBoundingClientRect()
    const naturalHeight = Math.max(before.height, panel.scrollHeight + panel.offsetHeight - panel.clientHeight)
    const below = Math.max(0, bottom - anchor.bottom - GAP)
    const above = Math.max(0, anchor.top - GAP - top)
    const opensAbove = naturalHeight > below && above > below
    panel.style.maxHeight = `${Math.min(bottom - top, opensAbove ? above : below)}px`
    const current = panel.getBoundingClientRect()
    const desiredLeft = Math.min(Math.max(anchor.left + (anchor.width - current.width) / 2, left), Math.max(left, right - current.width))
    const desiredTop = Math.min(Math.max(opensAbove ? anchor.top - GAP - current.height : anchor.bottom + GAP, top), Math.max(top, bottom - current.height))
    // Work in screen-space deltas: fixed positioning would still be relative to
    // the transformed toolbar and would place this menu at the wrong origin.
    panel.style.left = `${(Number.parseFloat(panel.style.left) || 0) + desiredLeft - current.left}px`
    panel.style.top = `${(Number.parseFloat(panel.style.top) || 0) + desiredTop - current.top}px`
  }

  function close(focusSummary = false): void {
    details.open = false
    if (focusSummary) summary?.focus()
  }

  function onToggle(): void {
    if (!details.open) return
    for (const other of popovers) {
      if (other !== details && other.closest('.canvas-surface') === surface) other.open = false
    }
    position()
  }

  function onPointerDown(event: PointerEvent): void {
    if (details.open && event.target instanceof Node && !details.contains(event.target)) close()
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.isComposing) return
    if (event.key === 'Escape' && details.open) {
      event.preventDefault()
      event.stopPropagation()
      close(true)
      return
    }
    const target = event.target
    if (!(target instanceof Element) || target.closest('input,textarea,select,[contenteditable="true"]')) return
    const fromSummary = summary?.contains(target)
    if ((!details.open && !fromSummary) || !['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    if (!details.open && !['ArrowDown', 'ArrowUp'].includes(event.key)) return
    event.preventDefault()
    event.stopPropagation()
    details.open = true
    onToggle()
    const buttons = Array.from(panel?.querySelectorAll<HTMLButtonElement>('button:not(:disabled):not([aria-disabled="true"])') ?? [])
      .filter((button) => !button.closest('[hidden],[aria-hidden="true"]') && getComputedStyle(button).display !== 'none')
    if (!buttons.length) return
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const backwards = event.key === 'ArrowUp' || event.key === 'ArrowLeft'
    const index = event.key === 'Home' ? 0
      : event.key === 'End' ? buttons.length - 1
        : current < 0 ? (backwards ? buttons.length - 1 : 0)
          : (current + (backwards ? -1 : 1) + buttons.length) % buttons.length
    buttons[index].focus()
  }

  // Canvas viewport changes move the toolbar with inline styles rather than a
  // DOM scroll event; re-clamp the menu when that anchor position changes.
  const toolbar = details.closest('.canvas-context-toolbar,.canvas-toolbar')
  const movementObserver = typeof MutationObserver === 'undefined' ? null : new MutationObserver(position)
  if (toolbar) movementObserver?.observe(toolbar, { attributes: true, attributeFilter: ['style'] })
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(position)
  observer?.observe(summary)
  observer?.observe(panel)
  if (surface) observer?.observe(surface)
  details.addEventListener('toggle', onToggle)
  details.addEventListener('keydown', onKeyDown)
  document.addEventListener('pointerdown', onPointerDown, true)
  window.addEventListener('resize', position)
  window.addEventListener('scroll', position, true)
  onToggle()

  return {
    destroy() {
      destroyed = true
      popovers.delete(details)
      observer?.disconnect()
      movementObserver?.disconnect()
      details.removeEventListener('toggle', onToggle)
      details.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('resize', position)
      window.removeEventListener('scroll', position, true)
      for (const [property, value, priority] of originalStyles) {
        if (value) panel.style.setProperty(property, value, priority)
        else panel.style.removeProperty(property)
      }
    },
  }
}
