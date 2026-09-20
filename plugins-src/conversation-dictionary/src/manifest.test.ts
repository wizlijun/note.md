import { describe, expect, it } from 'vitest'
import manifest from '../manifest.v2.json'

describe('manifest', () => {
  it('declares a native singleton window and one action-routed CLI without approval commands', () => {
    expect(manifest.id).toBe('notemd.conversation-dictionary')
    expect(manifest.version).toBe('0.1.3')
    expect(manifest.kind).toBe('native')
    expect(manifest.contributes.menus[0].submenu).toBe('ai')
    expect(manifest.contributes.windows[0]).toMatchObject({ id: 'main', open_command: 'open', singleton: true })
    expect(manifest.activation.events).toContain('onCli:conversation-dictionary')
    expect(manifest.contributes.cli).toHaveLength(1)
    expect(manifest.contributes.cli[0]).toMatchObject({ subcommand: 'conversation-dictionary', command: 'conversation-dictionary' })
    expect(manifest.contributes.cli[0].args[0]).toMatchObject({ name: 'action', required: true })
    expect(JSON.stringify(manifest.contributes.cli)).not.toMatch(/approve|confirm|commit/)
    expect(manifest.capabilities).not.toContain('network')
  })
})
