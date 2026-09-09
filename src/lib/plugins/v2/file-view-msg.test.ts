import { describe, expect, it, vi } from 'vitest'
import { handleFileViewMessage } from './file-view-msg'

describe('read-only file display channel', () => {
  const source = {}
  const origin = 'plugin://notemd.timeline'
  const options = () => ({ pluginOrigin: origin, expectedSource: source, requestId: 3, onReady: vi.fn(), onFallback: vi.fn() })
  const event = (data: unknown) => ({ origin, source, data })

  it('accepts ready and fallback only for the current request', () => {
    const opts = options()
    expect(handleFileViewMessage(event({ type: 'file_view.ready', requestId: 3 }), opts)).toBe(true)
    expect(opts.onReady).toHaveBeenCalledOnce()
    expect(handleFileViewMessage(event({ type: 'file_view.fallback', requestId: 3, reason: 'edit' }), opts)).toBe(true)
    expect(opts.onFallback).toHaveBeenCalledWith('edit')
  })

  it.each([
    { type: 'change', content: 'rewrite user Markdown', requestId: 3 },
    { type: 'file_view.change', content: 'rewrite user file', requestId: 3 },
    { type: 'custom_editor.ready', requestId: 3 },
    { type: 'custom_editor.fallback', requestId: 3 },
    { type: 'file_view.ready', requestId: 2 },
    { type: 'file_view.fallback', requestId: '3' },
    { type: 'file_view.ready' },
    null,
  ])('ignores mutations, stale snapshots and malformed messages', (data) => {
    const opts = options()
    expect(handleFileViewMessage(event(data), opts)).toBe(false)
    expect(opts.onReady).not.toHaveBeenCalled()
    expect(opts.onFallback).not.toHaveBeenCalled()
  })

  it('rejects another origin, another frame, and an absent iframe', () => {
    const opts = options()
    const data = { type: 'file_view.ready', requestId: 3 }
    expect(handleFileViewMessage({ ...event(data), origin: 'https://example.com' }, opts)).toBe(false)
    expect(handleFileViewMessage({ ...event(data), source: {} }, opts)).toBe(false)
    expect(handleFileViewMessage({ ...event(data), source: undefined }, { ...opts, expectedSource: undefined })).toBe(false)
    expect(opts.onReady).not.toHaveBeenCalled()
  })

  it('accepts a validated page action on the same authenticated channel', () => {
    const opts = { ...options(), onOpenPage: vi.fn() }
    const data = { type: 'file_view.open_page', requestId: 3, operationId: 1, target: '主题/设计' }
    expect(handleFileViewMessage(event(data), opts)).toBe(true)
    expect(opts.onOpenPage).toHaveBeenCalledWith(data)
    expect(handleFileViewMessage({ ...event(data), origin: 'https://untrusted.test' }, opts)).toBe(false)
    expect(handleFileViewMessage({ ...event(data), source: {} }, opts)).toBe(false)
    expect(handleFileViewMessage(event({ ...data, requestId: 2 }), opts)).toBe(false)
    expect(opts.onOpenPage).toHaveBeenCalledOnce()
  })

  it.each([
    { operationId: 0 }, { operationId: -1 }, { operationId: 1.5 }, { operationId: '1' },
    { operationId: Number.MAX_SAFE_INTEGER + 1 }, { target: '' }, { target: '  ' },
    { target: 'bad\nname' }, { target: 'bad\u0000name' }, { target: 'a'.repeat(1025) }, { target: null },
  ])('rejects malformed page requests: %j', (invalid) => {
    const opts = { ...options(), onOpenPage: vi.fn() }
    expect(handleFileViewMessage(event({ type: 'file_view.open_page', requestId: 3, operationId: 1, target: '开发', ...invalid }), opts)).toBe(false)
    expect(opts.onOpenPage).not.toHaveBeenCalled()
  })
})
