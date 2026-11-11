import { describe, expect, it } from 'vitest'
import { en } from '../i18n/en'
import type { Missing, RepairSuggestion } from './api'
import { DEFAULT_SMART_LOOKUP_SETTINGS, type SmartLookupSettings } from './settings'
import {
  chatRequestConfig,
  endpointHost,
  headerMessage,
  jevRequestConfig,
  repairMessage,
  shouldAutoRepair,
  type DegradedStatus,
  type HeaderState,
} from './enhance-flow'

function defaults(): SmartLookupSettings {
  return structuredClone(DEFAULT_SMART_LOOKUP_SETTINGS)
}

function withChat(): SmartLookupSettings {
  const settings = defaults()
  settings.enhance.chat = { url: 'https://api.example.com/v1', model: 'small-chat', consentHost: 'api.example.com' }
  return settings
}

const DEGRADED: DegradedStatus[] = ['notConfigured', 'noConsent', 'timeout', 'keyInvalid', 'unreachable', 'invalid', 'cancelled']

describe('headerMessage', () => {
  it('header messages never carry more than host and status class', () => {
    const m = headerMessage({ kind: 'degraded', status: 'unreachable', host: 'x.example', statusClass: '5xx', missing: null })!
    expect(m).toEqual({ key: 'smartSearch.enhance.unreachable', params: { host: 'x.example', code: ' · 5xx' } })
  })

  it('maps each degraded status to its own key and only host / status class params', () => {
    const degraded = (status: DegradedStatus, statusClass: string | null = null) =>
      headerMessage({ kind: 'degraded', status, host: 'api.typesafe.ai', statusClass, missing: null })
    expect(degraded('notConfigured')).toEqual({ key: 'smartSearch.enhance.notConfigured', params: {} })
    expect(degraded('noConsent')).toEqual({ key: 'smartSearch.enhance.noConsent', params: { host: 'api.typesafe.ai' } })
    expect(degraded('timeout')).toEqual({ key: 'smartSearch.enhance.timeout', params: {} })
    expect(degraded('keyInvalid', '4xx')).toEqual({ key: 'smartSearch.enhance.keyInvalid', params: { host: 'api.typesafe.ai', code: '4xx' } })
    expect(degraded('unreachable')).toEqual({ key: 'smartSearch.enhance.unreachable', params: { host: 'api.typesafe.ai', code: '' } })
    expect(degraded('invalid', '2xx')).toEqual({ key: 'smartSearch.enhance.invalid', params: { host: 'api.typesafe.ai' } })
    expect(degraded('cancelled')).toEqual({ key: 'smartSearch.enhance.cancelled', params: {} })
  })

  it('not configured names a missing key or an insecure endpoint', () => {
    const notConfigured = (missing: Missing | null) =>
      headerMessage({ kind: 'degraded', status: 'notConfigured', host: null, statusClass: null, missing })
    expect(notConfigured('key')).toEqual({ key: 'smartSearch.enhance.notConfiguredKey', params: {} })
    expect(notConfigured('insecure')).toEqual({ key: 'smartSearch.enhance.notConfiguredInsecure', params: {} })
    for (const missing of ['url', 'model', null] as const) {
      expect(notConfigured(missing)).toEqual({ key: 'smartSearch.enhance.notConfigured', params: {} })
    }
    expect(en['smartSearch.enhance.notConfiguredKey']).toBe('No key saved')
  })

  it('a busy index has its own key; none has none', () => {
    expect(headerMessage({ kind: 'indexUnavailable' })).toEqual({ key: 'smartSearch.enhance.indexUnavailable', params: {} })
    expect(headerMessage({ kind: 'none' })).toBeNull()
  })

  it('every key it returns exists with exactly the params it is given', () => {
    const states: HeaderState[] = [
      { kind: 'indexUnavailable' },
      ...DEGRADED.map((status): HeaderState => ({ kind: 'degraded', status, host: 'h', statusClass: '5xx', missing: null })),
    ]
    for (const state of states) {
      const m = headerMessage(state)!
      const placeholders = (en[m.key].match(/\{(\w+)\}/g) ?? []).map((p) => p.slice(1, -1)).sort()
      expect(Object.keys(m.params).sort(), m.key).toEqual(placeholders)
    }
  })
})

describe('repairMessage', () => {
  function repair(overrides: Partial<RepairSuggestion> = {}): RepairSuggestion {
    return {
      status: 'ok', skipReason: null, missing: null, endpointHost: 'chat.example', statusClass: null,
      groups: [{ terms: ['发布'], phrases: [] }], requestCount: 1, elapsedMs: 600, usage: null, ...overrides,
    }
  }

  it('says what failed about rephrasing, not about judging', () => {
    expect(repairMessage(repair({ status: 'timeout', groups: [] })))
      .toEqual({ key: 'smartSearch.enhance.repairTimeout', params: {} })
    expect(repairMessage(repair({ status: 'invalid', groups: [] })))
      .toEqual({ key: 'smartSearch.enhance.repairInvalid', params: { host: 'chat.example' } })
    // An ok answer without any wording is an invalid return.
    expect(repairMessage(repair({ groups: [] })))
      .toEqual({ key: 'smartSearch.enhance.repairInvalid', params: { host: 'chat.example' } })
    expect(en['smartSearch.enhance.repairTimeout']).toBe('Rephrasing timed out; results unchanged')
    expect(en['smartSearch.enhance.repairTimeout']).not.toContain('Judging')
  })

  it('shares the copy that is not about judging, and is silent when there is nothing to say', () => {
    expect(repairMessage(repair({ status: 'notConfigured', missing: 'key', groups: [], endpointHost: null })))
      .toEqual({ key: 'smartSearch.enhance.notConfiguredKey', params: {} })
    expect(repairMessage(repair({ status: 'keyInvalid', statusClass: '4xx', groups: [] })))
      .toEqual({ key: 'smartSearch.enhance.keyInvalid', params: { host: 'chat.example', code: '4xx' } })
    expect(repairMessage(repair({ status: 'unreachable', groups: [] })))
      .toEqual({ key: 'smartSearch.enhance.unreachable', params: { host: 'chat.example', code: '' } })
    expect(repairMessage(repair())).toBeNull()
    expect(repairMessage(repair({ status: 'skipped', skipReason: 'autoBudgetUsed', groups: [] }))).toBeNull()
  })
})

describe('request configs', () => {
  it('jevRequestConfig sends exactly url, model, authMode and consentHost — never the preset', () => {
    const settings = defaults()
    settings.enhance.jev = { preset: 'official', url: 'https://api.typesafe.ai/v1', model: 'jev-1', authMode: 'none', consentHost: 'api.typesafe.ai' }
    const config = jevRequestConfig(settings)
    expect(Object.keys(config).sort()).toEqual(['authMode', 'consentHost', 'model', 'url'])
    expect(config).toEqual({ url: 'https://api.typesafe.ai/v1', model: 'jev-1', authMode: 'none', consentHost: 'api.typesafe.ai' })
    expect(config).not.toBe(settings.enhance.jev)
  })

  it('jevRequestConfig drops anything extra a stored object might carry', () => {
    const settings = defaults()
    ;(settings.enhance.jev as Record<string, unknown>).apiKey = 'sk-should-not-travel'
    expect(Object.keys(jevRequestConfig(settings)).sort()).toEqual(['authMode', 'consentHost', 'model', 'url'])
  })

  it('chatRequestConfig sends exactly url and model', () => {
    const config = chatRequestConfig(withChat())
    expect(Object.keys(config).sort()).toEqual(['model', 'url'])
    expect(config).toEqual({ url: 'https://api.example.com/v1', model: 'small-chat' })
  })

  it('endpointHost matches the host rule', () => {
    expect(endpointHost('https://API.typesafe.ai/v1', 'jev')).toBe('api.typesafe.ai')
    expect(endpointHost('http://localhost:8000/v1', 'jev')).toBe('localhost:8000')
    expect(endpointHost('https://openrouter.ai:443/api/alpha/decisions', 'jev')).toBe('openrouter.ai')
    expect(endpointHost('not a url', 'jev')).toBeNull()
    expect(endpointHost('https://api.example.com/v1', 'chat')).toBe('api.example.com')
  })
})

describe('repair', () => {
  it('auto repair needs zero hits, a configured model and a stored key', () => {
    expect(shouldAutoRepair(0, withChat(), { jev: false, chat: true })).toBe(true)
    expect(shouldAutoRepair(1, withChat(), { jev: false, chat: true })).toBe(false)
    expect(shouldAutoRepair(0, withChat(), { jev: false, chat: false })).toBe(false)
    expect(shouldAutoRepair(0, defaults(), { jev: false, chat: true })).toBe(false)
  })

  it('auto repair also needs enhancement on and both model fields', () => {
    const off = withChat()
    off.enhance.enabled = false
    expect(shouldAutoRepair(0, off, { jev: true, chat: true })).toBe(false)
    const noModel = withChat()
    noModel.enhance.chat.model = '  '
    expect(shouldAutoRepair(0, noModel, { jev: true, chat: true })).toBe(false)
    const noUrl = withChat()
    noUrl.enhance.chat.url = ''
    expect(shouldAutoRepair(0, noUrl, { jev: true, chat: true })).toBe(false)
  })

  it('auto repair needs consent for the answer host: it sends the question there', () => {
    const none = withChat()
    none.enhance.chat.consentHost = ''
    expect(shouldAutoRepair(0, none, { jev: true, chat: true })).toBe(false)
    const other = withChat()
    other.enhance.chat.consentHost = 'other.example.com'
    expect(shouldAutoRepair(0, other, { jev: true, chat: true })).toBe(false)
    const unparsable = withChat()
    unparsable.enhance.chat = { url: 'not a url', model: 'm', consentHost: '' }
    expect(shouldAutoRepair(0, unparsable, { jev: true, chat: true })).toBe(false)
  })
})
