import { beforeEach, describe, expect, it, vi } from 'vitest'

const hostRequest = vi.fn()

vi.mock('./bridge', () => ({
  bridge: () => ({ request: hostRequest }),
}))

import {
  loadMaxConcurrency,
  loadUsageDisplay,
  normalizeMaxConcurrency,
  normalizeUsageDisplay,
  saveMaxConcurrency,
  saveUsageDisplay,
} from './settings'

describe('agent concurrency settings', () => {
  beforeEach(() => hostRequest.mockReset())

  it('defaults invalid or missing values to three and clamps to 1–5', () => {
    expect(normalizeMaxConcurrency(undefined)).toBe(3)
    expect(normalizeMaxConcurrency('nope')).toBe(3)
    for (const value of [null, '', ' ', false, [], {}, -1, 1.5]) expect(normalizeMaxConcurrency(value)).toBe(3)
    expect(normalizeMaxConcurrency('1')).toBe(1)
    expect(normalizeMaxConcurrency(0)).toBe(1)
    expect(normalizeMaxConcurrency('3')).toBe(3)
    expect(normalizeMaxConcurrency(9)).toBe(5)
  })

  it('loads only this plugin scope through the host settings bridge', async () => {
    hostRequest.mockResolvedValue({ settings: { maxConcurrency: '4' } })
    await expect(loadMaxConcurrency()).resolves.toBe(4)
    expect(hostRequest).toHaveBeenCalledWith('host.settings.get')
  })

  it('persists three when the key is absent so older hosts use the same default', async () => {
    hostRequest.mockResolvedValueOnce({ settings: { usageDisplay: 'result' } })
      .mockResolvedValueOnce({ ok: true })
    await expect(loadMaxConcurrency()).resolves.toBe(3)
    expect(hostRequest.mock.calls).toEqual([
      ['host.settings.get'],
      ['host.settings.set', { key: 'maxConcurrency', value: '3' }],
    ])
  })

  it.each(['1', 1, '4', null, '', false, 0, 'nope'])('never overwrites an explicitly stored value: %j', async value => {
    hostRequest.mockResolvedValue({ settings: { maxConcurrency: value } })
    await expect(loadMaxConcurrency()).resolves.toBe(normalizeMaxConcurrency(value))
    expect(hostRequest).toHaveBeenCalledTimes(1)
    expect(hostRequest).toHaveBeenCalledWith('host.settings.get')
  })

  it('reports failure when the default cannot be persisted', async () => {
    hostRequest.mockResolvedValueOnce({ settings: {} })
      .mockRejectedValueOnce(new Error('store unavailable'))
    await expect(loadMaxConcurrency()).rejects.toThrow('store unavailable')
  })

  it('persists the normalized value under the local maxConcurrency key', async () => {
    hostRequest.mockResolvedValue({ ok: true })
    await expect(saveMaxConcurrency(9)).resolves.toBe(5)
    expect(hostRequest).toHaveBeenCalledWith('host.settings.set', {
      key: 'maxConcurrency',
      value: '5',
    })
  })

  it('defaults usage display to tip and accepts result', () => {
    expect(normalizeUsageDisplay(undefined)).toBe('tip')
    expect(normalizeUsageDisplay('toast')).toBe('tip')
    expect(normalizeUsageDisplay('result')).toBe('result')
  })

  it('loads and saves usage display in this plugin scope', async () => {
    hostRequest.mockResolvedValueOnce({ settings: { usageDisplay: 'result' } })
    await expect(loadUsageDisplay()).resolves.toBe('result')
    hostRequest.mockResolvedValueOnce({ ok: true })
    await expect(saveUsageDisplay('result')).resolves.toBe('result')
    expect(hostRequest).toHaveBeenLastCalledWith('host.settings.set', {
      key: 'usageDisplay',
      value: 'result',
    })
  })
})
