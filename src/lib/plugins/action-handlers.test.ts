import { describe, it, expect, vi, beforeEach } from 'vitest'
import { applyActions, __setHandlersForTests } from './action-handlers'
import { toasts, clearToasts } from '../toast.svelte'
import type { PluginManifest } from './types'

const m: PluginManifest = {
  id: 'share', name: 'Share', version: '1.0.0', binary: 'bin',
  host_capabilities: ['toast', 'clipboard.write', 'dialog', 'settings.write:share.records'],
}

describe('applyActions', () => {
  beforeEach(() => clearToasts())

  it('toast action pushes to toast queue', async () => {
    await applyActions([{ type: 'toast', level: 'success', message: 'hello' }], m)
    expect(toasts.list.length).toBe(1)
    expect(toasts.list[0].message).toBe('hello')
  })

  it('clipboard.write calls clipboard handler', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    __setHandlersForTests({ writeText })
    await applyActions([{ type: 'clipboard.write', text: 'https://x' }], m)
    expect(writeText).toHaveBeenCalledWith('https://x')
    __setHandlersForTests(null)
  })

  it('clipboard failure surfaces a toast but does not throw', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    __setHandlersForTests({ writeText })
    await applyActions([{ type: 'clipboard.write', text: 'x' }], m)
    expect(toasts.list.some(t => t.level === 'error' && t.message.includes('clipboard'))).toBe(true)
    __setHandlersForTests(null)
  })

  it('dialog.message calls message handler', async () => {
    const showMessage = vi.fn().mockResolvedValue(undefined)
    __setHandlersForTests({ showMessage })
    await applyActions([{ type: 'dialog.message', title: 'T', message: 'M', level: 'info' }], m)
    expect(showMessage).toHaveBeenCalledWith('M', { title: 'T', kind: 'info' })
    __setHandlersForTests(null)
  })

  it('dialog.confirm re-invokes plugin command on confirm', async () => {
    const askDialog = vi.fn().mockResolvedValue(true)
    const reinvoke = vi.fn().mockResolvedValue(undefined)
    __setHandlersForTests({ askDialog, reinvokePlugin: reinvoke })
    await applyActions([{ type: 'dialog.confirm', title: 'T', message: 'M', if_confirm_invoke: 'do-it' }], m)
    expect(askDialog).toHaveBeenCalledWith('M', { title: 'T' })
    expect(reinvoke).toHaveBeenCalledWith(m.id, 'do-it')
    __setHandlersForTests(null)
  })

  it('dialog.confirm cancel does not re-invoke', async () => {
    const askDialog = vi.fn().mockResolvedValue(false)
    const reinvoke = vi.fn()
    __setHandlersForTests({ askDialog, reinvokePlugin: reinvoke })
    await applyActions([{ type: 'dialog.confirm', title: 'T', message: 'M', if_confirm_invoke: 'do-it' }], m)
    expect(reinvoke).not.toHaveBeenCalled()
    __setHandlersForTests(null)
  })

  it('settings.merge calls settings writer', async () => {
    const writeSettings = vi.fn().mockResolvedValue(undefined)
    __setHandlersForTests({ writeSettings })
    await applyActions([{ type: 'settings.merge', patch: { 'share.records': { a: 1 } } }], m)
    expect(writeSettings).toHaveBeenCalledWith({ 'share.records': { a: 1 } })
    __setHandlersForTests(null)
  })

  it('actions are applied in order, failures do not break the chain', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('x'))
    __setHandlersForTests({ writeText })
    await applyActions([
      { type: 'clipboard.write', text: 'a' },
      { type: 'toast', level: 'success', message: 'after-failure' },
    ], m)
    expect(toasts.list.some(t => t.message === 'after-failure')).toBe(true)
    __setHandlersForTests(null)
  })
})
