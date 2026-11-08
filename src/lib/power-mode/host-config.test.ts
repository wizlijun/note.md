/** @vitest-environment happy-dom */
import { expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(), save: vi.fn(), listeners: new Map<string, (event: any) => unknown>(),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async (name, fn) => { mocks.listeners.set(name, fn); return () => {} }) }))
vi.mock('../settings.svelte', () => ({ getPluginScopedValue: () => ({ surfaces: { main: true } }), setPluginScopedValue: mocks.save }))
import { initPowerModeHost, mainWindowConfig } from './host-config.svelte'
import { assetBase } from './assets'

it('main editor uses installed assets, disables on uninstall, and never persists runtime URLs', async () => {
  mocks.invoke.mockResolvedValue({ status: 'ready', base: 'plugin://notemd.power-mode/__power_mode__/' })
  await initPowerModeHost()
  expect(mainWindowConfig()).not.toBeNull()
  expect(assetBase()).toBe('plugin://notemd.power-mode/__power_mode__/')
  mocks.invoke.mockResolvedValue({ status: 'disabled', base: null })
  mocks.listeners.get('plugins-changed')!({})
  await vi.waitFor(() => expect(mainWindowConfig()).toBeNull())
  mocks.invoke.mockResolvedValue({ status: 'missing', base: null })
  window.dispatchEvent(new Event('focus'))
  await vi.waitFor(() => expect(mainWindowConfig()).not.toBeNull())
  expect(assetBase()).toBeNull()
  await mocks.listeners.get('power-mode://update')!({ payload: { surfaces: { main: true }, assets: { base: 'do-not-save' } } })
  expect(mocks.save).toHaveBeenCalledWith('notemd.power-mode', 'config', expect.not.objectContaining({ assets: expect.anything() }))
})
