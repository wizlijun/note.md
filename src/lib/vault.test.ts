import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(),
}))

vi.mock('./toast.svelte', () => ({
  pushToast: vi.fn(),
}))

import { invoke } from '@tauri-apps/api/core'
import { vaultStore, syncNow, refreshStatus, _resetForTests } from './vault.svelte'

describe('vault store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetForTests()
  })

  it('refreshStatus updates store from invoke result', async () => {
    ;(invoke as any).mockResolvedValueOnce({
      state: 'idle', last_sync: 123, error_message: null, has_conflicts: false, configured: true,
    })
    await refreshStatus()
    expect(vaultStore.configured).toBe(true)
    expect(vaultStore.state).toBe('idle')
    expect(vaultStore.lastSync).toBe(123)
  })

  it('syncNow dedups within 30s window', async () => {
    // Setup: store is configured, last sync was just now (within 30s).
    vaultStore.configured = true
    vaultStore.state = 'idle'
    vaultStore.lastSync = Date.now()

    ;(invoke as any).mockResolvedValue({
      state: 'idle', last_sync: Date.now(), error_message: null, has_conflicts: false, configured: true,
    })

    await syncNow()
    const syncCalls = (invoke as any).mock.calls.filter((c: any[]) => c[0] === 'vault_sync_now').length
    expect(syncCalls).toBe(0) // skipped due to cooldown
  })

  it('syncNow allows trigger when configured but no prior sync', async () => {
    vaultStore.configured = true
    vaultStore.state = 'idle'
    vaultStore.lastSync = null

    ;(invoke as any).mockImplementation((cmd: string) => {
      if (cmd === 'plugin:keychain|get') return Promise.resolve({ value: 'pat-token' })
      if (cmd === 'vault_sync_now') return Promise.resolve({
        state: 'idle', last_sync: Date.now(), error_message: null, has_conflicts: false, configured: true,
      })
      return Promise.resolve(null)
    })

    await syncNow()
    const syncCalls = (invoke as any).mock.calls.filter((c: any[]) => c[0] === 'vault_sync_now').length
    expect(syncCalls).toBe(1)
  })

  it('syncNow allows re-trigger after 30s', async () => {
    vaultStore.configured = true
    vaultStore.state = 'idle'
    vaultStore.lastSync = Date.now() - 31_000

    ;(invoke as any).mockImplementation((cmd: string) => {
      if (cmd === 'plugin:keychain|get') return Promise.resolve({ value: 'pat-token' })
      if (cmd === 'vault_sync_now') return Promise.resolve({
        state: 'idle', last_sync: Date.now(), error_message: null, has_conflicts: false, configured: true,
      })
      return Promise.resolve(null)
    })

    await syncNow()
    const syncCalls = (invoke as any).mock.calls.filter((c: any[]) => c[0] === 'vault_sync_now').length
    expect(syncCalls).toBe(1)
  })

  it('syncNow skips when not configured', async () => {
    vaultStore.configured = false
    await syncNow()
    const syncCalls = (invoke as any).mock.calls.filter((c: any[]) => c[0] === 'vault_sync_now').length
    expect(syncCalls).toBe(0)
  })

  it('syncNow propagates error to errorMsg', async () => {
    vaultStore.configured = true
    vaultStore.state = 'idle'
    vaultStore.lastSync = null

    ;(invoke as any).mockImplementation((cmd: string) => {
      if (cmd === 'plugin:keychain|get') return Promise.resolve({ value: 'pat-token' })
      if (cmd === 'vault_sync_now') return Promise.reject('Vault: 鉴权失败')
      return Promise.resolve(null)
    })
    await syncNow().catch(() => {})
    expect(vaultStore.errorMsg).toContain('鉴权失败')
    expect(vaultStore.state).toBe('error')
  })
})
