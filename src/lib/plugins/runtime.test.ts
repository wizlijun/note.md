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
