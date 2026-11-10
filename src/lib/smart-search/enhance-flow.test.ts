import { describe, expect, it } from 'vitest'
import type { SearchHit } from '../search/api'
import { en } from '../i18n/en'
import type { JudgeResult, RepairSuggestion } from './api'
import type { ResultSection } from './lookup-view'
import { DEFAULT_SMART_LOOKUP_SETTINGS, type SmartLookupSettings } from './settings'
import {
  applyOrder,
  chatRequestConfig,
  endpointHost,
  headerFromJudge,
  headerMessage,
  headerOnArrival,
  judgingCount,
  judgingMessage,
  jevRequestConfig,
  movedFrom,
  noMatchAttempts,
  repairMessage,
  sectionBreaks,
  shouldAutoRepair,
  tiersById,
  type DegradedStatus,
  type HeaderState,
} from './enhance-flow'

type Hit = SearchHit & { resultId?: string }

function result(overrides: Partial<JudgeResult> = {}): JudgeResult {
  return {
    status: 'ok', skipReason: null, missing: null, endpointHost: null, statusClass: null,
    verdicts: [], order: ['r2', 'r1'], judgedCount: 2, rerankedCount: 2, topTenUnfit: false,
    requestCount: 1, reused: false, elapsedMs: 800, poolSize: 2, sentBlocks: 2, estimatedTokens: 120,
    skippedRollups: 0, skippedConfidential: 0, skippedStale: 0, skippedLong: 0, usage: null,
    ...overrides,
  }
}

function hit(resultId: string | undefined, overrides: Partial<Hit> = {}): Hit {
  return {
    path: `${resultId ?? 'x'}.md`, absPath: `/vault/${resultId ?? 'x'}.md`, line: 1, lineEnd: 1, text: '', breadcrumb: '',
    level: 'line', score: 1, docDate: null, sourceRef: '', agentBy: null, humanVerified: false,
    origin: 'human', conceptType: null, pinned: false, resultId, ...overrides,
  }
}

function section(key: string, resultIds: string[]): ResultSection<Hit> {
  return { key, label: key, hits: resultIds.map((id) => hit(id)) }
}

function ids(sections: ResultSection<Hit>[]): (string | undefined)[][] {
  return sections.map((s) => s.hits.map((h) => h.resultId))
}

function defaults(): SmartLookupSettings {
  return structuredClone(DEFAULT_SMART_LOOKUP_SETTINGS)
}

function withChat(): SmartLookupSettings {
  const settings = defaults()
  settings.enhance.chat = { url: 'https://api.example.com/v1', model: 'small-chat', consentHost: '' }
  return settings
}

const DEGRADED: DegradedStatus[] = ['notConfigured', 'noConsent', 'timeout', 'keyInvalid', 'unreachable', 'invalid', 'cancelled']

describe('headerFromJudge', () => {
  it('maps every host status to one header state', () => {
    expect(headerFromJudge(result({ status: 'ok' }), false).kind).toBe('judged')
    expect(headerFromJudge(result({ status: 'ok', topTenUnfit: true }), false).kind).toBe('topTenUnfit')
    expect(headerFromJudge(result({ status: 'skipped', skipReason: 'pinned' }), false).kind).toBe('none')
    for (const status of DEGRADED) {
      expect(headerFromJudge(result({ status, endpointHost: 'api.typesafe.ai', statusClass: '4xx' }), false))
        .toEqual({ kind: 'degraded', status, host: 'api.typesafe.ai', statusClass: '4xx', missing: null })
    }
  })

  it('interaction_turns_an_arriving_order_into_pending', () => {
    expect(headerFromJudge(result({ status: 'ok' }), true).kind).toBe('pending')
    const r = result({ status: 'ok' })
    expect(headerFromJudge(r, true)).toEqual({ kind: 'pending', result: r })
    expect(headerFromJudge(r, false)).toEqual({ kind: 'judged', result: r })
  })

  it('an unchanged order has nothing to apply, even after interaction', () => {
    expect(headerFromJudge(result({ status: 'ok', rerankedCount: 0 }), true).kind).toBe('judged')
  })

  it('top ten unfit wins over interaction', () => {
    expect(headerFromJudge(result({ status: 'ok', topTenUnfit: true }), true).kind).toBe('topTenUnfit')
  })

  it('every skip reason is silent except a busy index', () => {
    for (const skipReason of ['zeroHits', 'pinned', 'fewTerms', 'repaired', 'noCandidates', 'autoBudgetUsed'] as const) {
      expect(headerFromJudge(result({ status: 'skipped', skipReason }), false)).toEqual({ kind: 'none' })
    }
    expect(headerFromJudge(result({ status: 'skipped', skipReason: 'indexUnavailable' }), false))
      .toEqual({ kind: 'indexUnavailable' })
  })

  it('carries what is missing for an unconfigured endpoint', () => {
    expect(headerFromJudge(result({ status: 'notConfigured', missing: 'model' }), false))
      .toEqual({ kind: 'degraded', status: 'notConfigured', host: null, statusClass: null, missing: 'model' })
  })

  it('a cancel before the request went out is still a cancelled header', () => {
    expect(headerFromJudge(result({ status: 'cancelled', requestCount: 0, order: [] }), false))
      .toEqual({ kind: 'degraded', status: 'cancelled', host: null, statusClass: null, missing: null })
  })
})

describe('headerOnArrival', () => {
  it('a_late_judgement_for_a_superseded_lookup_is_ignored', () => {
    const late = result({ status: 'ok' })
    expect(headerOnArrival({ lookupRunId: 'run-2', seq: 2 }, { lookupRunId: 'run-1', seq: 1 }, late, false)).toBeNull()
    // Same run, but a newer request (e.g. Try again) was started after this one.
    expect(headerOnArrival({ lookupRunId: 'run-1', seq: 3 }, { lookupRunId: 'run-1', seq: 2 }, late, false)).toBeNull()
    // Nothing is in flight any more (the window was hidden, or the input changed).
    expect(headerOnArrival(null, { lookupRunId: 'run-1', seq: 1 }, late, false)).toBeNull()
  })

  it('the current request maps like headerFromJudge', () => {
    const r = result({ status: 'ok' })
    const ticket = { lookupRunId: 'run-1', seq: 1 }
    expect(headerOnArrival(ticket, { ...ticket }, r, false)).toEqual({ kind: 'judged', result: r })
    expect(headerOnArrival(ticket, { ...ticket }, r, true)).toEqual({ kind: 'pending', result: r })
  })
})

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
    const notConfigured = (missing: JudgeResult['missing']) =>
      headerMessage({ kind: 'degraded', status: 'notConfigured', host: null, statusClass: null, missing })
    expect(notConfigured('key')).toEqual({ key: 'smartSearch.enhance.notConfiguredKey', params: {} })
    expect(notConfigured('insecure')).toEqual({ key: 'smartSearch.enhance.notConfiguredInsecure', params: {} })
    for (const missing of ['url', 'model', null] as const) {
      expect(notConfigured(missing)).toEqual({ key: 'smartSearch.enhance.notConfigured', params: {} })
    }
    expect(en['smartSearch.enhance.notConfiguredKey']).toBe('No key saved')
  })

  it('judged says how many moved, or that the order stayed', () => {
    expect(headerMessage({ kind: 'judged', result: result({ rerankedCount: 3, judgedCount: 5 }) }))
      .toEqual({ key: 'smartSearch.enhance.judged', params: { n: 3 } })
    expect(headerMessage({ kind: 'judged', result: result({ rerankedCount: 0, judgedCount: 5 }) }))
      .toEqual({ key: 'smartSearch.enhance.judgedUnchanged', params: { n: 5 } })
  })

  it('pending, top ten unfit and a busy index have their own keys; none and judging have none', () => {
    expect(headerMessage({ kind: 'pending', result: result() })).toEqual({ key: 'smartSearch.enhance.pending', params: {} })
    expect(headerMessage({ kind: 'topTenUnfit', result: result() })).toEqual({ key: 'smartSearch.enhance.topTenUnfit', params: {} })
    expect(headerMessage({ kind: 'indexUnavailable' })).toEqual({ key: 'smartSearch.enhance.indexUnavailable', params: {} })
    expect(headerMessage({ kind: 'none' })).toBeNull()
    expect(headerMessage({ kind: 'judging', count: 10, startedAt: 0 })).toBeNull()
  })

  it('every key it returns exists with exactly the params it is given', () => {
    const states: HeaderState[] = [
      { kind: 'judged', result: result() },
      { kind: 'judged', result: result({ rerankedCount: 0 }) },
      { kind: 'pending', result: result() },
      { kind: 'topTenUnfit', result: result() },
      { kind: 'indexUnavailable' },
      ...DEGRADED.map((status): HeaderState => ({ kind: 'degraded', status, host: 'h', statusClass: '5xx', missing: null })),
    ]
    for (const state of states) {
      const m = headerMessage(state)!
      const placeholders = (en[m.key].match(/\{(\w+)\}/g) ?? []).map((p) => p.slice(1, -1)).sort()
      expect(Object.keys(m.params).sort(), m.key).toEqual(placeholders)
    }
  })

  it('the criterion chip describes what is sent', () => {
    expect(en['smartSearch.enhance.criterion']).toBe("Criterion: directly matches what you're looking for")
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

describe('judging', () => {
  it('counts line-level, unpinned hits in the first 50, at most 10', () => {
    const hits = [
      hit('p', { pinned: true }), hit('f', { level: 'file' }), hit('s', { level: 'section' }),
      ...Array.from({ length: 3 }, (_, i) => hit(`l${i}`)),
    ]
    expect(judgingCount(hits)).toBe(3)
    expect(judgingCount(Array.from({ length: 30 }, (_, i) => hit(`l${i}`)))).toBe(10)
    expect(judgingCount([...Array.from({ length: 50 }, (_, i) => hit(`f${i}`, { level: 'file' })), hit('late')])).toBe(0)
  })

  it('the judging count is labelled as an estimate (the window does not know the host\'s pool and K)', () => {
    expect(en['smartSearch.enhance.judging']).toBe('Judging about {n} · {s}s')
  })

  it('the judging message shows whole elapsed seconds', () => {
    expect(judgingMessage({ kind: 'judging', count: 7, startedAt: 1_000 }, 3_400))
      .toEqual({ key: 'smartSearch.enhance.judging', params: { n: 7, s: 2 } })
    expect(judgingMessage({ kind: 'judging', count: 7, startedAt: 1_000 }, 500))
      .toEqual({ key: 'smartSearch.enhance.judging', params: { n: 7, s: 0 } })
  })
})

describe('ordering', () => {
  it('applyOrder reorders inside sections only', () => {
    const sections = [section('a', ['r1', 'r2']), section('b', ['r3', 'r4'])]
    expect(ids(applyOrder(sections, ['r2', 'r1', 'r4', 'r3']))).toEqual([['r2', 'r1'], ['r4', 'r3']])
    expect(sectionBreaks(sections)).toEqual([2])
  })

  it('applyOrder never moves a hit across sections and leaves the input untouched', () => {
    const sections = [section('a', ['r1', 'r2']), section('b', ['r3', 'r4'])]
    expect(ids(applyOrder(sections, ['r4', 'r3', 'r2', 'r1']))).toEqual([['r2', 'r1'], ['r4', 'r3']])
    expect(ids(sections)).toEqual([['r1', 'r2'], ['r3', 'r4']])
  })

  it('hits the order does not name keep their slots', () => {
    const sections: ResultSection<Hit>[] = [{ key: 'a', label: 'a', hits: [hit('r1'), hit(undefined), hit('r2'), hit('r3')] }]
    // r2 and the id-less hit are not named: they stay in slots 1 and 2; r3, r1 fill slots 0 and 3.
    expect(ids(applyOrder(sections, ['r3', 'r1']))).toEqual([['r3', undefined, 'r2', 'r1']])
  })

  it('an empty order is the local order', () => {
    const sections = [section('a', ['r1', 'r2'])]
    expect(ids(applyOrder(sections, []))).toEqual([['r1', 'r2']])
  })

  it('section breaks skip empty sections so they stay strictly inside the list', () => {
    expect(sectionBreaks([section('a', ['r1']), section('b', []), section('c', ['r2', 'r3']), section('d', ['r4'])])).toEqual([1, 3])
    expect(sectionBreaks([section('a', []), section('b', ['r1', 'r2'])])).toEqual([])
    expect(sectionBreaks([section('a', ['r1']), section('b', [])])).toEqual([])
    expect(sectionBreaks([])).toEqual([])
  })

  it('movedFrom reports only judged hits that moved', () => {
    const moved = movedFrom(['r1', 'r2', 'r3', 'r4'], ['r1', 'r4', 'r3', 'r2'], new Set(['r2', 'r4']))
    expect([...moved]).toEqual([['r4', { from: 4, direction: 'up' }], ['r2', { from: 2, direction: 'down' }]])
  })

  it('movedFrom ignores judged hits that kept their place or are unknown locally', () => {
    expect([...movedFrom(['r1', 'r2', 'r3'], ['r1', 'r3', 'r2'], new Set(['r1', 'r9']))]).toEqual([])
  })

  it('tiersById maps verdicts and is empty without a result', () => {
    const tiers = tiersById(result({ verdicts: [{ resultId: 'r1', tier: 'fit' }, { resultId: 'r2', tier: 'unfit' }] }))
    expect([...tiers]).toEqual([['r1', 'fit'], ['r2', 'unfit']])
    expect(tiersById(null).size).toBe(0)
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

describe('repair and no-match', () => {
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

  it('no-match attempts list the three tries in order, marking the ones not run', () => {
    expect(noMatchAttempts({ hits: 0, tookMs: 12 }, null, { kind: 'scan', hits: 0, tookMs: 3400 })).toEqual([
      { kind: 'original', hits: 0, tookMs: 12 }, { kind: 'rephrased', hits: null, tookMs: null }, { kind: 'scan', hits: 0, tookMs: 3400 },
    ])
  })

  it('no-match attempts keep their slot kinds', () => {
    expect(noMatchAttempts({ hits: 0, tookMs: 5 }, { kind: 'rephrased', hits: 0, tookMs: 900 }, null)).toEqual([
      { kind: 'original', hits: 0, tookMs: 5 }, { kind: 'rephrased', hits: 0, tookMs: 900 }, { kind: 'scan', hits: null, tookMs: null },
    ])
  })
})
