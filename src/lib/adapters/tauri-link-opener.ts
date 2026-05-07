import type { LinkOpener } from '@moraya/core'

function isLocalFilePath(href: string): boolean {
  if (href.startsWith('/')) return true
  if (/^[A-Za-z]:[/\\]/.test(href)) return true
  if (href.startsWith('file://')) return true
  return false
}

export class TauriLinkOpener implements LinkOpener {
  open(href: string): void {
    if (isLocalFilePath(href)) {
      let path = href
      if (path.startsWith('file://')) {
        try {
          const url = new URL(path)
          path = decodeURIComponent(url.pathname)
        } catch {
          // Fall through with original href if URL parse fails
        }
      }

      import('@tauri-apps/plugin-opener')
        .then(({ openPath }) => openPath(path))
        .catch((e) => { console.warn('[TauriLinkOpener] openPath failed:', path, e) })
    } else {
      import('@tauri-apps/plugin-opener')
        .then(({ openUrl }) => openUrl(href))
        .catch((e) => { console.warn('[TauriLinkOpener] openUrl failed:', href, e) })
    }
  }
}

export const tauriLinkOpener = new TauriLinkOpener()
