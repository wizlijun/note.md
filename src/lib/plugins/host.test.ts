import { describe, it, expect, vi } from 'vitest'
import { buildContext, parseAndFilterResponse } from './host'
import type { PluginManifest, PluginResponse } from './types'

const baseManifest: PluginManifest = {
  id: 'share', name: 'Share', version: '1.0.0', binary: 'bin',
  host_capabilities: ['renderer.html', 'settings.read', 'settings.write:share.records', 'toast', 'clipboard.write'],
}

describe('buildContext', () => {
  it('includes raw_content only when capability is present', async () => {
    const tab = { path: '/p/foo.md', filename: 'foo.md', extension: 'md', kind: 'markdown' as const, title: 'foo', isDirty: false, isUntitled: false, content: '# Hi' }
    const m = { ...baseManifest, host_capabilities: ['renderer.raw'] as never[] }
    const r = await buildContext(m, tab, { htmlBaker: async () => 'NEVER CALLED' })
    expect(r.context.raw_content).toBe('# Hi')
    expect(r.context.rendered_html).toBeUndefined()
  })

  it('calls htmlBaker only when renderer.html declared', async () => {
    const tab = { path: '/p/foo.md', filename: 'foo.md', extension: 'md', kind: 'markdown' as const, title: 'foo', isDirty: false, isUntitled: false, content: '# Hi' }
    const baker = vi.fn().mockResolvedValue('<html>x</html>')

    const m1 = { ...baseManifest, host_capabilities: ['toast'] as never[] }
    await buildContext(m1, tab, { htmlBaker: baker })
    expect(baker).not.toHaveBeenCalled()

    const m2 = { ...baseManifest, host_capabilities: ['renderer.html'] as never[] }
    const r = await buildContext(m2, tab, { htmlBaker: baker })
    expect(baker).toHaveBeenCalledOnce()
    expect(r.context.rendered_html).toBe('<html>x</html>')
  })

  it('omits settings field when settings.read is absent', async () => {
    const tab = { path: '/p/foo.md', filename: 'foo.md', extension: 'md', kind: 'markdown' as const, title: 'foo', isDirty: false, isUntitled: false, content: '' }
    const m = { ...baseManifest, host_capabilities: ['toast'] as never[] }
    const r = await buildContext(m, tab, { htmlBaker: async () => '', settingsReader: () => ({ 'share.x': 1 }) })
    expect(r.settings).toBeUndefined()
  })

  it('includes scoped settings when settings.read declared', async () => {
    const tab = { path: '/p/foo.md', filename: 'foo.md', extension: 'md', kind: 'markdown' as const, title: 'foo', isDirty: false, isUntitled: false, content: '' }
    const r = await buildContext(baseManifest, tab,
      { htmlBaker: async () => '<x/>', settingsReader: () => ({ 'share.baseUrl': 'https://x' }) })
    expect(r.settings).toEqual({ 'share.baseUrl': 'https://x' })
  })
})

describe('parseAndFilterResponse', () => {
  const m = { ...baseManifest }

  it('parses valid JSON', () => {
    const line = JSON.stringify({ success: true, actions: [] } satisfies PluginResponse)
    expect(parseAndFilterResponse(line, m).ok).toBe(true)
  })

  it('rejects non-JSON', () => {
    const r = parseAndFilterResponse('not json', m)
    expect(r.ok).toBe(false)
  })

  it('drops actions outside declared capabilities', () => {
    const line = JSON.stringify({
      success: true,
      actions: [
        { type: 'toast', level: 'info', message: 'ok' },
        { type: 'dialog.message', title: 't', message: 'm', level: 'info' },
      ],
    })
    const r = parseAndFilterResponse(line, m)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.actions.length).toBe(1)
      expect(r.value.actions[0].type).toBe('toast')
    }
  })

  it('drops settings.merge keys outside declared scope', () => {
    const line = JSON.stringify({
      success: true,
      actions: [
        { type: 'settings.merge', patch: { 'share.records': { a: 1 }, 'share.other': 2 } },
      ],
    })
    const r = parseAndFilterResponse(line, m)
    expect(r.ok).toBe(true)
    if (r.ok) {
      const a = r.value.actions[0] as { type: 'settings.merge'; patch: Record<string, unknown> }
      expect(Object.keys(a.patch)).toEqual(['share.records'])
    }
  })

  it('drops settings.merge entirely if no settings.write capability declared', () => {
    const m2 = { ...baseManifest, host_capabilities: ['toast'] as never[] }
    const line = JSON.stringify({
      success: true,
      actions: [
        { type: 'settings.merge', patch: { 'share.records': {} } },
      ],
    })
    const r = parseAndFilterResponse(line, m2)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.actions).toEqual([])
  })

  it('passes cli.result actions through unconditionally', () => {
    const manifest = {
      id: 'demo', name: 'Demo', version: '0.1.0', binary: 'bin',
      host_capabilities: [],  // intentionally no capabilities
    } as PluginManifest
    const line = JSON.stringify({
      success: true,
      actions: [{ type: 'cli.result', data: { url: 'https://example.com' } }],
    })
    const r = parseAndFilterResponse(line, manifest)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.actions).toEqual([
      { type: 'cli.result', data: { url: 'https://example.com' } },
    ])
  })
})
