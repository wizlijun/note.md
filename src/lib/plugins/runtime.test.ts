// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import { dispatchPluginCommand, setPluginDispatcher, pluginRuntime } from './runtime.svelte'

it('forwards each explicit command source and keeps two-argument callers compatible', async () => {
  const dispatch = vi.fn(async () => {})
  expect(pluginRuntime.ready).toBe(false)
  setPluginDispatcher(dispatch)
  expect(pluginRuntime.ready).toBe(true)
  await dispatchPluginCommand('app', 'open')
  await dispatchPluginCommand('app', 'open', 'tab-context')
  await dispatchPluginCommand('app', 'open', 'editor-context')
  expect(dispatch.mock.calls).toEqual([
    ['app', 'open', 'menu'], ['app', 'open', 'tab-context'], ['app', 'open', 'editor-context'],
  ])
  const legacy = vi.fn(async (_pluginId: string, _command: string) => {})
  setPluginDispatcher(legacy)
  await expect(dispatchPluginCommand('app', 'open')).resolves.toBeUndefined()
})

it('does not let an older App runtime response overwrite a newer home or plugins-changed refresh', async () => {
  const { mockIPC, clearMocks } = await import('@tauri-apps/api/mocks')
  const { refreshPluginManifests } = await import('./runtime.svelte')
  let oldResolve!: (value: unknown) => void
  let newResolve!: (value: unknown) => void
  let calls = 0
  mockIPC(() => new Promise(resolve => { if (++calls === 1) oldResolve = resolve; else newResolve = resolve }))
  const oldRead = refreshPluginManifests()
  const newRead = refreshPluginManifests()
  const updated = [{ id: 'new', name: 'New', version: '2', binary: '', host_capabilities: [] }]
  newResolve(updated); await newRead
  oldResolve([]); expect(await oldRead).toEqual(updated)
  expect(pluginRuntime.manifests).toEqual(updated)
  clearMocks()
})

it('retains the last verified registry when the newest refresh fails and does not apply a stale success', async () => {
  const { mockIPC, clearMocks } = await import('@tauri-apps/api/mocks')
  const { refreshPluginManifests } = await import('./runtime.svelte')
  const verified = [{ id: 'verified', name: 'Verified', version: '1', binary: '', host_capabilities: [] }]
  pluginRuntime.manifests = verified
  let oldResolve!: (value: unknown) => void
  let newReject!: (error: unknown) => void
  let calls = 0
  mockIPC(() => new Promise((resolve, reject) => { if (++calls === 1) oldResolve = resolve; else newReject = reject }))
  const oldRead = refreshPluginManifests()
  const newRead = refreshPluginManifests()
  newReject(new Error('newest runtime read failed'))
  await expect(newRead).rejects.toThrow('newest runtime read failed')
  oldResolve([])
  await expect(oldRead).rejects.toThrow('newest runtime read failed')
  expect(pluginRuntime.manifests).toEqual(verified)
  clearMocks()
})
