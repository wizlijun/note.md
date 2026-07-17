import { describe, it, expect, vi } from 'vitest'
import { handleCustomEditorMessage, type IncomingMessage } from './custom-editor-msg'

const ORIGIN = 'plugin://notemd.base'
// Stand-in for the iframe's contentWindow — identity is all the router checks.
const SOURCE = { marker: 'iframe-window' }

const evt = (over: Partial<IncomingMessage> = {}): IncomingMessage => ({
  origin: ORIGIN,
  source: SOURCE,
  data: { type: 'change', content: 'edited' },
  ...over,
})

describe('handleCustomEditorMessage', () => {
  it('routes a valid change to onChange and returns true', () => {
    const onChange = vi.fn()
    const handled = handleCustomEditorMessage(evt(), { pluginOrigin: ORIGIN, expectedSource: SOURCE, onChange })
    expect(handled).toBe(true)
    expect(onChange).toHaveBeenCalledWith('edited')
  })

  it('ignores a message from the wrong origin', () => {
    const onChange = vi.fn()
    const handled = handleCustomEditorMessage(
      evt({ origin: 'plugin://evil.plugin' }),
      { pluginOrigin: ORIGIN, expectedSource: SOURCE, onChange },
    )
    expect(handled).toBe(false)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('ignores a message from the wrong source window (right origin, forged frame)', () => {
    const onChange = vi.fn()
    const handled = handleCustomEditorMessage(
      evt({ source: { marker: 'other-frame' } }),
      { pluginOrigin: ORIGIN, expectedSource: SOURCE, onChange },
    )
    expect(handled).toBe(false)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('ignores unknown message types and malformed payloads', () => {
    const onChange = vi.fn()
    const opts = { pluginOrigin: ORIGIN, expectedSource: SOURCE, onChange }
    expect(handleCustomEditorMessage(evt({ data: { type: 'other' } }), opts)).toBe(false)
    expect(handleCustomEditorMessage(evt({ data: { type: 'change' } }), opts)).toBe(false) // no content
    expect(handleCustomEditorMessage(evt({ data: { type: 'change', content: 42 } }), opts)).toBe(false)
    expect(handleCustomEditorMessage(evt({ data: null }), opts)).toBe(false)
    expect(handleCustomEditorMessage(evt({ data: 'change' }), opts)).toBe(false)
    expect(onChange).not.toHaveBeenCalled()
  })
})
