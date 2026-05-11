import { describe, it, expect, vi } from 'vitest'
import {
  basenameOf, extensionOf, inferKind, interpretActions,
  type CliPayload,
} from './cli-runner'
import type { PluginAction, PluginManifest } from '../plugins/types'

function basePayload(overrides: Partial<CliPayload> = {}): CliPayload {
  return {
    subcommand: 'share',
    plugin_id: 'share',
    plugin_command: 'publish',
    file: '/tmp/draft.md',
    flags: {},
    global: { json: false, quiet: false, clipboard: true, yes: false },
    ...overrides,
  }
}

describe('basenameOf / extensionOf / inferKind', () => {
  it('extracts basename and extension', () => {
    expect(basenameOf('/tmp/x.md')).toBe('x.md')
    expect(extensionOf('x.md')).toBe('.md')
  })
  it('infers markdown / html / code / image', () => {
    expect(inferKind('.md')).toBe('markdown')
    expect(inferKind('.HTML')).toBe('html')
    expect(inferKind('.ts')).toBe('code')
    expect(inferKind('.png')).toBe('image')
    expect(inferKind(null)).toBe('plaintext')
  })
})

describe('interpretActions', () => {
  const m = { id: 'share', name: 'Share', host_capabilities: [] } as unknown as PluginManifest

  it('extracts URL from cli.result for default stdout', () => {
    const actions = [
      { type: 'cli.result', data: { url: 'https://x', slug: 'abc', is_update: false } },
    ] as PluginAction[]
    const r = interpretActions(actions, m, basePayload(), { isTty: false })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe('https://x')
  })

  it('emits JSON when global.json is set', () => {
    const actions = [
      { type: 'cli.result', data: { url: 'https://x', slug: 'abc' } },
    ] as PluginAction[]
    const r = interpretActions(actions, m, basePayload({ global: { json: true, quiet: false, clipboard: true, yes: false } }), { isTty: false })
    const parsed = JSON.parse(r.stdout || '')
    expect(parsed.ok).toBe(true)
    expect(parsed.data.url).toBe('https://x')
  })

  it('maps toast(error) to exit code 4 and stderr line', () => {
    const actions = [
      { type: 'toast', level: 'error', message: '❌ Share: 未配置 API Key' },
    ] as PluginAction[]
    const r = interpretActions(actions, m, basePayload(), { isTty: true })
    expect(r.exitCode).toBe(4)
    expect(r.stderr.some(s => s.includes('未配置 API Key'))).toBe(true)
  })

  it('skips toast progress on non-TTY by default', () => {
    const actions = [
      { type: 'toast', level: 'success', message: '✓ Shared' },
      { type: 'cli.result', data: { url: 'https://x' } },
    ] as PluginAction[]
    const r = interpretActions(actions, m, basePayload(), { isTty: false })
    expect(r.stderr).toEqual([])
  })

  it('honors --no-clipboard', () => {
    const writeText = vi.fn()
    const actions = [
      { type: 'clipboard.write', text: 'https://x' },
      { type: 'cli.result', data: { url: 'https://x' } },
    ] as PluginAction[]
    interpretActions(
      actions, m,
      basePayload({ global: { json: false, quiet: false, clipboard: false, yes: false } }),
      { isTty: false, writeClipboard: writeText },
    )
    expect(writeText).not.toHaveBeenCalled()
  })

  it('writes clipboard when enabled and not in JSON mode', () => {
    const writeText = vi.fn()
    const actions = [
      { type: 'clipboard.write', text: 'https://x' },
      { type: 'cli.result', data: { url: 'https://x' } },
    ] as PluginAction[]
    interpretActions(
      actions, m, basePayload(),
      { isTty: false, writeClipboard: writeText },
    )
    expect(writeText).toHaveBeenCalledWith('https://x')
  })

  it('skips clipboard in JSON mode even when enabled', () => {
    const writeText = vi.fn()
    const actions = [
      { type: 'clipboard.write', text: 'https://x' },
      { type: 'cli.result', data: { url: 'https://x' } },
    ] as PluginAction[]
    interpretActions(
      actions, m,
      basePayload({ global: { json: true, quiet: false, clipboard: true, yes: false } }),
      { isTty: false, writeClipboard: writeText },
    )
    expect(writeText).not.toHaveBeenCalled()
  })

  it('emits failure JSON on error-only outcome', () => {
    const actions = [
      { type: 'toast', level: 'error', message: '❌ Share: network failure' },
    ] as PluginAction[]
    const r = interpretActions(
      actions, m,
      basePayload({ global: { json: true, quiet: false, clipboard: true, yes: false } }),
      { isTty: false },
    )
    expect(r.exitCode).toBe(4)
    const parsed = JSON.parse(r.stdout || '')
    expect(parsed.ok).toBe(false)
    expect(parsed.error.code).toBe('plugin_failed')
  })
})
