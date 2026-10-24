function preventBrowserMenu(event: Event): void {
  event.preventDefault()
}

/** Keep native webview refresh/navigation menus out of host windows while
 * allowing each surface's own contextmenu handler to run normally. */
export function installBrowserContextMenuGuard(target: Document = document): () => void {
  target.addEventListener('contextmenu', preventBrowserMenu, true)
  return () => target.removeEventListener('contextmenu', preventBrowserMenu, true)
}
