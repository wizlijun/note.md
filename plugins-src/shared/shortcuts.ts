import { isApplePlatformSync } from '../../src/lib/platform-sync'
import { hasPrimaryModifier } from '../../src/lib/primary-modifier'

export { isApplePlatformSync }

/** App-local shortcuts must not consume an IME action or another handler's event. */
export function shortcutEventBlocked(event: KeyboardEvent): boolean {
  return event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.repeat
}

/** Cmd on Apple, Ctrl elsewhere; never claim the desktop's Super combinations. */
export function primaryShortcut(event: KeyboardEvent, key: string, shift = false): boolean {
  if (shortcutEventBlocked(event) || event.altKey || event.shiftKey !== shift) return false
  return hasPrimaryModifier(event) && event.key.toLowerCase() === key.toLowerCase()
}

export function primaryShortcutLabel(key: string, shift = false): string {
  return isApplePlatformSync()
    ? `${shift ? '⇧' : ''}⌘${key === 'Enter' ? '↵' : key.toUpperCase()}`
    : `Ctrl+${shift ? 'Shift+' : ''}${key}`
}

export function primaryShortcutAria(key: string, shift = false): string {
  return `${isApplePlatformSync() ? 'Meta' : 'Control'}+${shift ? 'Shift+' : ''}${key}`
}
