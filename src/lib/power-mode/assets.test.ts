import { describe, it, expect } from 'vitest'
import { assetBase, assetsStatus, normalizeAssets, refreshAssets } from './assets'
import { presetConfig } from './presets'
import { normalizeConfig, resolveExplosion } from './config'

describe('installed Power Mode resources', () => {
  it('accepts only the two fixed resource bridge locations', () => {
    for (const base of ['/__power_mode__/', 'plugin://notemd.power-mode/__power_mode__/']) {
      expect(normalizeAssets({ status: 'ready', base })).toEqual({ status: 'ready', base })
    }
    for (const base of ['https://example.com/', '/assets/power-mode/', 'file:///tmp/', 'javascript:alert(1)']) {
      expect(normalizeAssets({ status: 'ready', base }).base).toBeNull()
    }
  })
  it('an old plugin without assets has no image URL or bundled fallback', async () => {
    await refreshAssets(async () => undefined)
    expect(assetsStatus()).toBe('missing')
    expect(presetConfig('particle').imageList).toEqual([])
    expect(resolveExplosion(normalizeConfig({ overrides: { imageList: ['/assets/power-mode/coin/1.gif'] } })).imageList).toEqual([])
  })
  it('uses installed images and clears them on disable or a failed query', async () => {
    await refreshAssets(async () => ({ status: 'ready', base: '/__power_mode__/' }))
    expect(presetConfig('coin').imageList).toEqual(['/__power_mode__/coin/1.gif'])
    await refreshAssets(async () => ({ status: 'disabled' }))
    expect(assetBase()).toBeNull()
    await refreshAssets(async () => { throw new Error('offline bridge') })
    expect(assetsStatus()).toBe('disabled')
  })
  it('late responses cannot restore resources after disable/update', async () => {
    let finish!: (value: unknown) => void
    const older = refreshAssets(() => new Promise((resolve) => { finish = resolve }))
    await refreshAssets(async () => ({ status: 'disabled' }))
    finish({ status: 'ready', base: '/__power_mode__/' })
    await older
    expect(assetsStatus()).toBe('disabled')
  })
})
