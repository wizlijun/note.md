// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks'
vi.mock('@tauri-apps/plugin-store', () => ({ Store: { load: vi.fn() } }))
beforeEach(() => vi.resetModules())
afterEach(() => clearMocks())
it('missing machine-local decoration override migrates to automatic', async () => {
  mockIPC(() => ({ version: 1 }))
  const { loadLinuxWindowDecorations, settings } = await import('./settings.svelte')
  settings.linuxWindowDecorations = true
  await loadLinuxWindowDecorations()
  expect(settings.linuxWindowDecorations).toBe(null)
})
it('restores explicit false instead of treating it as automatic', async () => {
  mockIPC(() => ({ version: 1, linuxWindowDecorations: false }))
  const { loadLinuxWindowDecorations, settings } = await import('./settings.svelte')
  await loadLinuxWindowDecorations()
  expect(settings.linuxWindowDecorations).toBe(false)
})
