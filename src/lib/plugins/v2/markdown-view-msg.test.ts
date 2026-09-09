import { describe, expect, it, vi } from 'vitest'
import { handleMarkdownViewerMessage } from './markdown-view-msg'

describe('read-only Markdown display channel', () => {
  const source = {}
  const origin = 'plugin://notemd.timeline'
  const options = () => ({ pluginOrigin: origin, expectedSource: source, requestId: 3, onReady: vi.fn(), onFallback: vi.fn() })
  const event = (data: unknown) => ({ origin, source, data })

  it('accepts ready and fallback only for the current request', () => {
    const opts = options()
    expect(handleMarkdownViewerMessage(event({ type: 'custom_editor.ready', requestId: 3 }), opts)).toBe(true)
    expect(opts.onReady).toHaveBeenCalledOnce()
    expect(handleMarkdownViewerMessage(event({ type: 'custom_editor.fallback', requestId: 3, reason: 'edit' }), opts)).toBe(true)
    expect(opts.onFallback).toHaveBeenCalledWith('edit')
  })

  it.each([
    { type: 'change', content: 'rewrite user Markdown', requestId: 3 },
    { type: 'custom_editor.ready', requestId: 2 },
    { type: 'custom_editor.fallback', requestId: '3' },
    { type: 'custom_editor.ready' },
    null,
  ])('ignores mutations, stale snapshots and malformed messages', (data) => {
    const opts = options()
    expect(handleMarkdownViewerMessage(event(data), opts)).toBe(false)
    expect(opts.onReady).not.toHaveBeenCalled()
    expect(opts.onFallback).not.toHaveBeenCalled()
  })

  it('rejects another origin, another frame, and an absent iframe', () => {
    const opts = options()
    const data = { type: 'custom_editor.ready', requestId: 3 }
    expect(handleMarkdownViewerMessage({ ...event(data), origin: 'https://example.com' }, opts)).toBe(false)
    expect(handleMarkdownViewerMessage({ ...event(data), source: {} }, opts)).toBe(false)
    expect(handleMarkdownViewerMessage({ ...event(data), source: undefined }, { ...opts, expectedSource: undefined })).toBe(false)
    expect(opts.onReady).not.toHaveBeenCalled()
  })
})
