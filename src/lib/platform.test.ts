import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@tauri-apps/plugin-os', () => ({
  platform: vi.fn(),
}))

import { platform as tauriPlatform } from '@tauri-apps/plugin-os'
import { platform, isIOS, isMacOS, _resetCacheForTests } from './platform.svelte'

describe('platform()', () => {
  beforeEach(() => {
    _resetCacheForTests()
    vi.clearAllMocks()
  })

  it('returns "macos" when tauri reports macos', async () => {
    ;(tauriPlatform as any).mockResolvedValue('macos')
    expect(await platform()).toBe('macos')
    expect(await isMacOS()).toBe(true)
    expect(await isIOS()).toBe(false)
  })

  it('returns "ios" when tauri reports ios', async () => {
    ;(tauriPlatform as any).mockResolvedValue('ios')
    expect(await platform()).toBe('ios')
    expect(await isIOS()).toBe(true)
  })

  it('returns "unknown" for non-Apple platforms', async () => {
    ;(tauriPlatform as any).mockResolvedValue('linux')
    expect(await platform()).toBe('unknown')
  })

  it('caches the first result', async () => {
    ;(tauriPlatform as any).mockResolvedValue('ios')
    await platform()
    await platform()
    expect((tauriPlatform as any).mock.calls.length).toBe(1)
  })

  it('parallel calls share a single in-flight promise', async () => {
    ;(tauriPlatform as any).mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve('ios'), 10)),
    )
    const [a, b, c] = await Promise.all([platform(), platform(), platform()])
    expect(a).toBe('ios')
    expect(b).toBe('ios')
    expect(c).toBe('ios')
    expect((tauriPlatform as any).mock.calls.length).toBe(1)
  })
})
