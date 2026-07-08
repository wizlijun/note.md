import { describe, it, expect, vi, beforeEach } from 'vitest'
import { maybeInstallTracker, shutdownTracker } from './tracker.svelte'
import { sotvaultStore } from '../sotvault.svelte'

// Regression tests for the install-timing bug: the tracker must install based on
// vault-root STATE (idempotently), not on app-boot ordering. `install` is
// injected so we exercise the gating/idempotency without touching Tauri.

beforeEach(async () => {
  await shutdownTracker()
  sotvaultStore.vaultRoot = null
})

describe('maybeInstallTracker', () => {
  it('does not install when no vault is configured', async () => {
    const install = vi.fn(async () => vi.fn())
    await maybeInstallTracker(install)
    expect(install).not.toHaveBeenCalled()
  })

  it('installs once a vault is configured (independent of boot ordering)', async () => {
    const install = vi.fn(async () => vi.fn())
    sotvaultStore.vaultRoot = '/vault'
    await maybeInstallTracker(install)
    expect(install).toHaveBeenCalledTimes(1)
  })

  it('is idempotent — does not reinstall for the same vault', async () => {
    const install = vi.fn(async () => vi.fn())
    sotvaultStore.vaultRoot = '/vault'
    await maybeInstallTracker(install)
    await maybeInstallTracker(install)
    expect(install).toHaveBeenCalledTimes(1)
  })

  it('reinstalls (disposing the old) when the vault root changes', async () => {
    const disposeA = vi.fn()
    const install = vi.fn(async () => disposeA)
    sotvaultStore.vaultRoot = '/vault-a'
    await maybeInstallTracker(install)

    const disposeB = vi.fn()
    install.mockResolvedValueOnce(disposeB)
    sotvaultStore.vaultRoot = '/vault-b'
    await maybeInstallTracker(install)

    expect(install).toHaveBeenCalledTimes(2)
    expect(disposeA).toHaveBeenCalledTimes(1) // old torn down
  })

  it('shutdownTracker disposes the live tracker', async () => {
    const dispose = vi.fn()
    const install = vi.fn(async () => dispose)
    sotvaultStore.vaultRoot = '/vault'
    await maybeInstallTracker(install)
    await shutdownTracker()
    expect(dispose).toHaveBeenCalledTimes(1)
    // After shutdown, a later call installs afresh.
    await maybeInstallTracker(install)
    expect(install).toHaveBeenCalledTimes(2)
  })
})
