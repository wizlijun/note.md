// @vitest-environment happy-dom
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks'

const direct = {
  distributionChannel: 'direct', cliInstall: true, themeFontInstall: true,
  setDefaultApp: true, location: true, globalShortcuts: true, windowDecorations: true,
}

beforeEach(() => vi.resetModules())
afterEach(() => clearMocks())

it('concurrent callers share the authoritative request and cache its successful result', async () => {
  let resolve!: (value: unknown) => void
  let requests = 0
  mockIPC((command) => {
    expect(command).toBe('desktop_capabilities')
    requests++
    return new Promise((done) => { resolve = done })
  })
  const { desktopCapabilities, loadDesktopCapabilities } = await import('./desktop-capabilities.svelte')
  const first = loadDesktopCapabilities()
  const second = loadDesktopCapabilities()
  expect(first).toBe(second)
  expect(desktopCapabilities.loading).toBe(true)
  expect(desktopCapabilities.value).toBe(null)
  resolve(direct)
  expect(await first).toEqual(direct)
  expect(await loadDesktopCapabilities()).toEqual(direct)
  expect(desktopCapabilities.value?.cliInstall).toBe(true)
  expect(desktopCapabilities.loading).toBe(false)
  expect(requests).toBe(1)
})

it('failed IPC leaves no granted capabilities and can be retried', async () => {
  let failed = false
  mockIPC(() => {
    if (!failed) { failed = true; throw new Error('identity unavailable') }
    return { ...direct, distributionChannel: 'package-manager', cliInstall: false }
  })
  const { desktopCapabilities, loadDesktopCapabilities } = await import('./desktop-capabilities.svelte')
  await expect(loadDesktopCapabilities()).rejects.toThrow('identity unavailable')
  expect(desktopCapabilities.value).toBe(null)
  expect(desktopCapabilities.loading).toBe(false)
  expect(desktopCapabilities.error).toBe('identity unavailable')
  await loadDesktopCapabilities()
  expect(desktopCapabilities.error).toBe(null)
  expect(desktopCapabilities.value?.distributionChannel).toBe('package-manager')
  expect(desktopCapabilities.value?.cliInstall).toBe(false)
})

it('missing boolean policies are rejected before any capability is granted', async () => {
  mockIPC(() => ({ distributionChannel: 'direct' }))
  const { desktopCapabilities, loadDesktopCapabilities } = await import('./desktop-capabilities.svelte')
  await expect(loadDesktopCapabilities()).rejects.toThrow('Invalid desktop capabilities')
  expect(desktopCapabilities.value).toBe(null)
  expect(desktopCapabilities.error).toBe('Invalid desktop capabilities')
})
