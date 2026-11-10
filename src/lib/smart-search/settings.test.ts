import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SMART_LOOKUP_SETTINGS, endpointHost, normalizeSmartLookupSettings, sendsKeyInClearText, settingsTabFromEvent,
} from './settings'

describe('smart lookup settings', () => {
  it('uses the low-cost defaults', () => {
    expect(normalizeSmartLookupSettings(undefined)).toEqual(DEFAULT_SMART_LOOKUP_SETTINGS)
    expect(DEFAULT_SMART_LOOKUP_SETTINGS.results.autoDeepOnZero).toBe(false)
  })

  it('keeps valid fields while independently resetting damaged fields', () => {
    const normalized = normalizeSmartLookupSettings({
      results: { limit: 20, groupBy: 'date', autoDeepOnZero: true, deepTimeoutMs: 500 },
    })
    expect(normalized.results).toEqual({
      limit: 20, groupBy: 'date', autoDeepOnZero: true, deepTimeoutMs: 4_000,
    })
  })

  it('accepts every inclusive numeric boundary', () => {
    expect(normalizeSmartLookupSettings({ results: { deepTimeoutMs: 1_000 } }).results.deepTimeoutMs).toBe(1_000)
    expect(normalizeSmartLookupSettings({ results: { deepTimeoutMs: 5_000 } }).results.deepTimeoutMs).toBe(5_000)
  })

  it('has no planner settings and drops legacy planner values', () => {
    const normalized = normalizeSmartLookupSettings({
      planner: { enabled: true, provider: 'notemd.codex-agent', timeoutMs: 30_000 },
    })
    expect('planner' in normalized).toBe(false)
    expect('planner' in DEFAULT_SMART_LOOKUP_SETTINGS).toBe(false)
  })

  it('ignores stored summary and handoff groups', () => {
    const normalized = normalizeSmartLookupSettings({
      summary: { enabled: false },
      handoff: { defaultProvider: 'x' },
    })
    expect('summary' in normalized).toBe(false)
    expect('handoff' in normalized).toBe(false)
  })

  it('enhancement defaults on with nothing configured and no consent', () => {
    const s = normalizeSmartLookupSettings(undefined)
    expect(s.enhance).toEqual({ enabled: true, jev: { preset: 'custom', url: '', model: '', authMode: 'bearer', consentHost: '' }, chat: { url: '', model: '', consentHost: '' } })
    expect(s.launch.firstRunSeen).toBe(false)
  })

  it('damaged enhance fields fall back one by one', () => {
    const s = normalizeSmartLookupSettings({ enhance: { enabled: false, jev: { preset: 'x', url: 'https://a.example/v1', authMode: 'oauth', consentHost: 7 } } })
    expect(s.enhance.enabled).toBe(false)
    expect(s.enhance.jev).toEqual({ preset: 'custom', url: 'https://a.example/v1', model: '', authMode: 'bearer', consentHost: '' })
  })

  it('bounds text fields by length and rejects control characters', () => {
    const ok = normalizeSmartLookupSettings({
      enhance: {
        jev: { preset: 'openrouter', url: 'u'.repeat(2_048), model: 'm'.repeat(256), authMode: 'none', consentHost: 'h'.repeat(255) },
        chat: { url: 'https://chat.example/v1', model: 'gpt' },
      },
      launch: { firstRunSeen: true },
    })
    expect(ok.enhance.jev).toEqual({ preset: 'openrouter', url: 'u'.repeat(2_048), model: 'm'.repeat(256), authMode: 'none', consentHost: 'h'.repeat(255) })
    expect(ok.enhance.chat).toEqual({ url: 'https://chat.example/v1', model: 'gpt', consentHost: '' })
    expect(ok.launch.firstRunSeen).toBe(true)

    const bad = normalizeSmartLookupSettings({
      enhance: {
        enabled: 'yes',
        jev: { url: 'u'.repeat(2_049), model: 'm'.repeat(257), consentHost: 'h'.repeat(256) },
        chat: { url: 'https://chat.example/\n', model: 'a\u0000b' },
      },
      launch: { firstRunSeen: 1 },
    })
    expect(bad.enhance).toEqual(DEFAULT_SMART_LOOKUP_SETTINGS.enhance)
    expect(bad.launch.firstRunSeen).toBe(false)
  })

  it('endpointHost follows the host rule: URL.host lower-cased, explicit ports only', () => {
    expect(endpointHost('https://API.typesafe.ai/v1', 'jev')).toBe('api.typesafe.ai')
    expect(endpointHost('http://localhost:8000/v1', 'jev')).toBe('localhost:8000')
    expect(endpointHost('https://openrouter.ai:443/api/alpha/decisions', 'jev')).toBe('openrouter.ai')
    expect(endpointHost('http://[::1]:9000/v1')).toBe('[::1]:9000')
    expect(endpointHost(' https://chat.example/v1 ', 'chat')).toBe('chat.example')
    expect(endpointHost('not a url', 'jev')).toBeNull()
    expect(endpointHost('ftp://a.example/v1')).toBeNull()
    expect(endpointHost('')).toBeNull()
  })

  it('flags a bearer key over plain http to a non-loopback host', () => {
    expect(sendsKeyInClearText('http://jev.example/v1', 'bearer')).toBe(true)
    expect(sendsKeyInClearText('http://192.168.1.5:8000/v1', 'bearer')).toBe(true)
    expect(sendsKeyInClearText('http://192.168.1.5:8000/v1', 'none')).toBe(false)
    expect(sendsKeyInClearText('https://jev.example/v1', 'bearer')).toBe(false)
    for (const loopback of ['http://localhost:8000/v1', 'http://LOCALHOST/v1', 'http://127.0.0.1:8000/v1', 'http://127.9.8.7/v1', 'http://[::1]:8000/v1']) {
      expect(sendsKeyInClearText(loopback, 'bearer'), loopback).toBe(false)
    }
    expect(sendsKeyInClearText('not a url', 'bearer')).toBe(false)
  })

  it('accepts only known tabs from the open-settings event', () => {
    expect(settingsTabFromEvent({ tab: 'enhance' })).toBe('enhance')
    expect(settingsTabFromEvent({ tab: 'search' })).toBe('search')
    expect(settingsTabFromEvent({ tab: 'core' })).toBeNull()
    expect(settingsTabFromEvent('enhance')).toBeNull()
    expect(settingsTabFromEvent(null)).toBeNull()
  })
})

describe('chat consent host', () => {
  it('is kept when valid and defaults to empty', () => {
    expect(normalizeSmartLookupSettings({ enhance: { chat: { consentHost: 'a.example' } } }).enhance.chat.consentHost).toBe('a.example')
    expect(normalizeSmartLookupSettings({}).enhance.chat.consentHost).toBe('')
  })
})
