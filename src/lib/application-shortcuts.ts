import { hasPrimaryModifier } from './primary-modifier'

type KeyEvent = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'isComposing' | 'repeat' | 'defaultPrevented'> & Partial<Pick<KeyboardEvent, 'keyCode'>>
export type ApplicationShortcut = 'new' | 'find' | 'replace' | 'open' | 'save' | 'save-as' | 'close' | 'toggle-mode' | 'refresh-blocks'

/** Window commands use Ctrl on Linux/Windows and Command on Apple. */
export function applicationShortcut(event: KeyEvent): ApplicationShortcut | null {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.repeat || event.altKey || !hasPrimaryModifier(event)) return null
  const key = event.key.toLowerCase()
  if (event.shiftKey) {
    if (key === 'f') return 'replace'
    if (key === 's') return 'save-as'
    if (key === 'b') return 'refresh-blocks'
    return null
  }
  switch (key) {
    case 'n': return 'new'
    case 'f': return 'find'
    case 'o': return 'open'
    case 's': return 'save'
    case 'w': return 'close'
    case '/': return 'toggle-mode'
    default: return null
  }
}
