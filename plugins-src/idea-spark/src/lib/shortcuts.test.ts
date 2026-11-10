// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { primaryShortcut, primaryShortcutAria, primaryShortcutLabel, shortcutEventBlocked } from '../../../shared/shortcuts'

afterEach(() => vi.restoreAllMocks())

function platform(value: string) {
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue(value)
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(value)
}

describe('plugin application shortcuts', () => {
  it.each(['Linux x86_64', 'Win32', 'MacIntel'])('matches only the platform primary modifier on %s', value => {
    platform(value)
    const apple = value === 'MacIntel'
    const modifier = apple ? { metaKey: true } : { ctrlKey: true }
    expect(primaryShortcut(new KeyboardEvent('keydown', { key: 's', ...modifier }), 's')).toBe(true)
    expect(primaryShortcut(new KeyboardEvent('keydown', { key: 's', ...(apple ? { ctrlKey: true } : { metaKey: true }) }), 's')).toBe(false)
    for (const extra of [{ altKey: true }, { shiftKey: true }, { ctrlKey: true, metaKey: true }, { repeat: true }, { isComposing: true }, { keyCode: 229 }]) {
      expect(primaryShortcut(new KeyboardEvent('keydown', { key: 's', ...modifier, ...extra }), 's')).toBe(false)
    }
    const consumed = new KeyboardEvent('keydown', { key: 's', ...modifier, cancelable: true })
    consumed.preventDefault()
    expect(primaryShortcut(consumed, 's')).toBe(false)
    expect(primaryShortcut(new KeyboardEvent('keydown', { key: 'N', ...modifier, shiftKey: true }), 'n', true)).toBe(true)
    expect(primaryShortcutLabel('Enter')).toBe(apple ? '⌘↵' : 'Ctrl+Enter')
    expect(primaryShortcutLabel('N', true)).toBe(apple ? '⇧⌘N' : 'Ctrl+Shift+N')
    expect(primaryShortcutAria('N', true)).toBe(apple ? 'Meta+Shift+N' : 'Control+Shift+N')
  })
  it('leaves composing Escape and already handled Escape to their owner', () => {
    expect(shortcutEventBlocked(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true }))).toBe(true)
    const consumed = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }); consumed.preventDefault()
    expect(shortcutEventBlocked(consumed)).toBe(true)
    expect(shortcutEventBlocked(new KeyboardEvent('keydown', { key: 'Escape' }))).toBe(false)
  })
})
