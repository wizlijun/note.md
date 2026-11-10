import { afterEach, describe, expect, it, vi } from 'vitest'
import { applicationShortcut } from './application-shortcuts'
import { hasPrimaryModifier } from './primary-modifier'
const chord = (key: string, flags = {}) => ({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, isComposing: false, repeat: false, defaultPrevented: false, ...flags })
afterEach(() => vi.unstubAllGlobals())
describe('application shortcuts respect the desktop platform', () => {
  it.each([['n','new'],['f','find'],['o','open'],['s','save'],['w','close'],['/','toggle-mode']])('Linux Ctrl+%s dispatches %s; Super does not', (key, action) => {
    vi.stubGlobal('navigator', { platform: 'Linux x86_64', userAgent: 'Linux' })
    expect(applicationShortcut(chord(key, { ctrlKey: true }))).toBe(action)
    expect(applicationShortcut(chord(key, { metaKey: true }))).toBeNull()
  })
  it.each([['f','replace'],['s','save-as'],['b','refresh-blocks']])('Linux Ctrl+Shift+%s has a distinct command', (key, action) => {
    vi.stubGlobal('navigator', { platform: 'Linux', userAgent: 'Linux' })
    expect(applicationShortcut(chord(key, { ctrlKey: true, shiftKey: true }))).toBe(action)
  })
  it.each([{altKey:true},{metaKey:true},{isComposing:true},{repeat:true},{defaultPrevented:true},{shiftKey:true}])('does not trigger new-file with extra modifiers or handled input: %j', flags => {
    vi.stubGlobal('navigator', { platform: 'Linux', userAgent: 'Linux' })
    expect(applicationShortcut(chord('n', { ctrlKey: true, ...flags }))).toBeNull()
  })
  it('Apple keeps Command and rejects Control or mixed modifiers', () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel', userAgent: 'Macintosh' })
    expect(applicationShortcut(chord('s', { metaKey: true }))).toBe('save')
    expect(applicationShortcut(chord('s', { ctrlKey: true }))).toBeNull()
    expect(hasPrimaryModifier(chord('s', { metaKey: true, ctrlKey: true }))).toBe(false)
  })
})
