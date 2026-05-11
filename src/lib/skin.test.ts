import { describe, it, expect, beforeEach } from 'vitest'

beforeEach(() => {
  // Reset module state between tests so setSkin mutations don't leak.
  // skin.svelte.ts has no Tauri-store coupling, so module reset is enough.
  // (Vitest re-imports fresh after vi.resetModules, but for this tiny
  // module we rely on declared test order + explicit reset at end of
  // mutating tests. See `setSkin updates skin.current` below.)
})

describe('skin module', () => {
  it('SKINS contains default and effie', async () => {
    const { SKINS } = await import('./skin.svelte')
    const ids = SKINS.map((s) => s.id)
    expect(ids).toContain('default')
    expect(ids).toContain('effie')
  })

  it('every skin entry has id, label, description', async () => {
    const { SKINS } = await import('./skin.svelte')
    for (const s of SKINS) {
      expect(typeof s.id).toBe('string')
      expect(typeof s.label).toBe('string')
      expect(typeof s.description).toBe('string')
      expect(s.label.length).toBeGreaterThan(0)
      expect(s.description.length).toBeGreaterThan(0)
    }
  })

  it('skin.current defaults to "default"', async () => {
    const { skin } = await import('./skin.svelte')
    expect(skin.current).toBe('default')
  })

  it('setSkin updates skin.current', async () => {
    const { skin, setSkin } = await import('./skin.svelte')
    setSkin('effie')
    expect(skin.current).toBe('effie')
    setSkin('default')
    expect(skin.current).toBe('default')
  })

  it('isValidSkinId returns true for known ids, false otherwise', async () => {
    const { isValidSkinId } = await import('./skin.svelte')
    expect(isValidSkinId('default')).toBe(true)
    expect(isValidSkinId('effie')).toBe(true)
    expect(isValidSkinId('nope')).toBe(false)
    expect(isValidSkinId('')).toBe(false)
  })
})
