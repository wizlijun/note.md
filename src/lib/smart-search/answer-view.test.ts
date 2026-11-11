import { describe, expect, it } from 'vitest'
import type { SearchHit } from '../search/api'
import { en } from '../i18n/en'
import { zh } from '../i18n/zh'
import type { AnswerResult, EvidenceItem, EvidenceStepResult, Tier } from './api'
import {
  allJudgedUnfit,
  citedSources,
  confirmedSources,
  fallbackLine,
  footerLine,
  isNoAnswer,
  lookupPhase,
  otherResults,
  statusChip,
  triedSteps,
  type LookupPhase,
  type ViewMessage,
} from './answer-view'
import { applyRound, emptyEvidence, type AnswerGate, type EvidenceView } from './evidence-flow'
import type { HeaderState } from './enhance-flow'

const item = (id: string, tier: Tier = 'fit', extra: Partial<EvidenceItem> = {}): EvidenceItem => ({
  evidenceId: id, path: `${id}.md`, absPath: `/vault/${id}.md`, line: 1, lineEnd: 2, title: id, breadcrumb: '', text: id,
  foundRound: 0, tier, localResultId: null, ...extra,
})

const local = (name: string, line = 1, lineEnd = line): SearchHit & { resultId: string } => ({
  path: `${name}.md`, absPath: `/vault/${name}.md`, line, lineEnd, text: name, breadcrumb: name, level: 'line', score: 1,
  docDate: null, sourceRef: `${name}.md#L${line}`, agentBy: null, humanVerified: false, origin: 'human', conceptType: null,
  pinned: false, resultId: `r-${name}`,
})

function finished(items: EvidenceItem[], extra: Partial<EvidenceStepResult> = {}): EvidenceView {
  const step: EvidenceStepResult = {
    status: 'ok', stop: 'maxHops', skipReason: null, missing: null, endpointHost: null, statusClass: null, hop: 0, terms: [],
    evidence: items, localTiers: [], done: true, requestCount: 1, poolSize: 0, candidates: 0, sentBlocks: 0,
    skippedConfidential: 0, skippedStale: 0, skippedLong: 0, skippedOversize: 0, estimatedTokens: 0, tokensUsed: 0, usage: null,
    elapsedMs: 0, nextHop: 1,
    run: { endpointHost: null, requests: 0, elapsedMs: 0, sentBlocks: 0, tokens: 0, skippedConfidential: 0, skippedStale: 0, skippedLong: 0, skippedOversize: 0 },
    ...extra,
  }
  return applyRound(emptyEvidence(), step)
}

function stepOf(items: EvidenceItem[]): EvidenceStepResult {
  return {
    status: 'ok', stop: null, skipReason: null, missing: null, endpointHost: null, statusClass: null, hop: 0, terms: [],
    evidence: items, localTiers: [], done: false, requestCount: 1, poolSize: 0, candidates: 0, sentBlocks: 0,
    skippedConfidential: 0, skippedStale: 0, skippedLong: 0, skippedOversize: 0, estimatedTokens: 0, tokensUsed: 0, usage: null,
    elapsedMs: 0, nextHop: 1,
    run: { endpointHost: null, requests: 0, elapsedMs: 0, sentBlocks: 0, tokens: 0, skippedConfidential: 0, skippedStale: 0, skippedLong: 0, skippedOversize: 0 },
  }
}

function answer(text: string | null, sources: AnswerResult['sources'], extra: Partial<AnswerResult> = {}): AnswerResult {
  return {
    status: 'ok', skipReason: null, missing: null, endpointHost: 'chat.example', statusClass: null, text, sources,
    omittedSources: 0, requestCount: 1, elapsedMs: 1, usage: null, ...extra,
  }
}

const text = (message: ViewMessage | null) => message && Object.entries(message.params)
  .reduce((value, [name, param]) => value.replace(`{${name}}`, String(param)), zh[message.key])

describe('citedSources', () => {
  const shown = [item('e1'), item('e2'), item('e3')]
  const sources = [{ id: 1, evidenceId: 'e1' }, { id: 2, evidenceId: 'e2' }, { id: 3, evidenceId: 'e3' }]

  it('lists the cited sources in citation-number order, numbered as cited', () => {
    const cited = citedSources(answer('王磊决定的[1][3]。原因是签名[2]。又见 [3]。', sources), shown)
    expect(cited.map((source) => [source.id, source.item.evidenceId])).toEqual([[1, 'e1'], [2, 'e2'], [3, 'e3']])
  })
  it('leaves out sources the answer sent but did not cite, and labels in code', () => {
    const cited = citedSources(answer('Only [3] here, not `[1]`.', sources), shown)
    expect(cited.map((source) => [source.id, source.item.evidenceId])).toEqual([[3, 'e3']])
  })
  it('lists a passage once, and only one still on screen', () => {
    const twice = [{ id: 1, evidenceId: 'e1' }, { id: 2, evidenceId: 'e1' }, { id: 3, evidenceId: 'gone' }]
    expect(citedSources(answer('[2] [1] [3]', twice), shown).map((source) => [source.id, source.item.evidenceId])).toEqual([[1, 'e1']])
  })
  it('is empty without an answer text', () => {
    expect(citedSources(null, shown)).toEqual([])
    expect(citedSources(answer(null, sources, { status: 'invalidCitations' }), shown)).toEqual([])
  })
  it('without an answer, the confirmed sources are the fit evidence, numbered in order', () => {
    const view = finished([item('a', 'unsure'), item('b'), item('c', 'unfit'), item('d')])
    expect(confirmedSources(view).map((source) => [source.id, source.item.evidenceId])).toEqual([[1, 'b'], [2, 'd']])
  })
})

describe('otherResults', () => {
  const tiers = new Map<string, Tier>([['r-x', 'unfit'], ['r-y', 'fit']])
  const localTier = (hit: { resultId?: string }) => (hit.resultId ? tiers.get(hit.resultId) : undefined)

  it('puts uncited fit evidence first, then the rest, then local results', () => {
    const shown = [item('u', 'unsure'), item('cited'), item('f')]
    const other = otherResults({ shown, sources: [shown[1]], local: [local('l1')], localTier, includeUnfit: false })
    expect(other.evidence.map((i) => i.evidenceId)).toEqual(['f', 'u'])
    expect(other.local.map((hit) => hit.path)).toEqual(['l1.md'])
  })
  it('lists a block once: a local row already shown as a source or as evidence is dropped (same path and line range)', () => {
    const source = item('s', 'fit', { path: 'a.md', line: 4, lineEnd: 6 })
    const evidence = item('e', 'fit', { path: 'b.md', line: 1, lineEnd: 1 })
    const other = otherResults({
      shown: [source, evidence],
      sources: [source],
      local: [local('a', 4, 6), local('a', 4, 7), local('b', 1), local('c', 2)],
      localTier,
      includeUnfit: false,
    })
    expect(other.evidence.map((i) => i.evidenceId)).toEqual(['e'])
    expect(other.local.map((hit) => [hit.path, hit.line, hit.lineEnd])).toEqual([['a.md', 4, 7], ['c.md', 2, 2]])
  })
  it('never lists unfit rows, unless the no-answer view asks for them', () => {
    const shown = [item('bad', 'unfit')]
    const hits = [local('x'), local('y'), local('z')]
    const hidden = otherResults({ shown, sources: [], local: hits, localTier, includeUnfit: false })
    expect(hidden.evidence).toEqual([])
    expect(hidden.local.map((hit) => hit.path)).toEqual(['y.md', 'z.md'])
    const all = otherResults({ shown, sources: [], local: hits, localTier, includeUnfit: true })
    expect(all.evidence.map((i) => i.evidenceId)).toEqual(['bad'])
    expect(all.local).toHaveLength(3)
  })
})

describe('allJudgedUnfit', () => {
  const tiers = new Map<string, Tier>([['r-x', 'unfit'], ['r-y', 'unfit']])
  const tierOf = (row: EvidenceItem | (SearchHit & { resultId: string })) =>
    ('evidenceId' in row ? row.tier : tiers.get(row.resultId))
  it('is true only when every row was judged unfit', () => {
    expect(allJudgedUnfit([item('a', 'unfit'), local('x'), local('y')], tierOf)).toBe(true)
  })
  it('a mixed list is not "all unrelated": an untiered (never judged) or unsure row keeps it plain', () => {
    // `z` has no tier: confidential, over-long, stale, section-level or beyond the candidates.
    expect(allJudgedUnfit([item('a', 'unfit'), local('x'), local('z')], tierOf)).toBe(false)
    expect(allJudgedUnfit([item('a', 'unfit'), item('b', 'unsure'), local('x')], tierOf)).toBe(false)
    expect(allJudgedUnfit([local('z')], tierOf)).toBe(false)
    expect(allJudgedUnfit([], tierOf)).toBe(false)
  })
})

describe('the no-answer decision and the phase', () => {
  it('no answer when the rounds finished and nothing shown is fit', () => {
    expect(isNoAnswer(finished([item('a', 'unfit'), item('b', 'unsure')]), false, 3)).toBe(true)
    expect(isNoAnswer(finished([item('a', 'unfit'), item('b')]), false, 3)).toBe(false)
  })
  it.each([
    ['evidenceTooLarge', 'skipped'],
    ['budget', 'ok'],
    ['noTerms', 'skipped'],
    ['candidatesEmpty', 'ok'],
  ] as const)('a run that ended on round 0 with %s judged nothing: local results and one line, not "no answer"', (stop, status) => {
    const view = finished([], { status, stop, requestCount: 0 })
    expect(view.rounds).toEqual([])
    expect(isNoAnswer(view, false, 3)).toBe(false)
    const phase = lookupPhase({ working: false, evidence: view, answer: null, cited: 0, hits: 3, zeroHitsTried: false })
    expect(phase).toBe('local')
    expect(text(statusChip(phase, { seconds: 0, sources: 0, busy: false }))).toBe('只有本地结果')
    const line = fallbackLine({
      phase, header: { kind: 'none' }, evidence: view, disabled: false, evidenceError: false, jevHost: 'localhost:8080',
      answerGate: null, answer: null, answerStopped: false,
    })
    expect(text(line)).toBe('这次没有可以核对的段落，下面是本地结果。')
    expect(line?.settings).toBe(false)
  })
  it('the same stops after a scored round are judged: nothing fit means no answer', () => {
    const scored = finished([item('a', 'unfit')], { done: false, stop: null })
    const view = applyRound(scored, { ...stepOf([]), stop: 'budget', done: true, status: 'ok', hop: 1 })
    expect(view.rounds).toHaveLength(1)
    expect(isNoAnswer(view, false, 3)).toBe(true)
  })
  it('a failed, stopped or unfinished run is not "no answer"', () => {
    expect(isNoAnswer(finished([], { status: 'timeout', stop: null }), false, 3)).toBe(false)
    expect(isNoAnswer(finished([], { status: 'cancelled', stop: null }), false, 3)).toBe(false)
    expect(isNoAnswer(finished([], { stop: 'indexChanged', status: 'skipped' }), false, 3)).toBe(false)
    expect(isNoAnswer(emptyEvidence(), false, 3)).toBe(false)
  })
  it('zero hits are "no answer" once every automatic try ran', () => {
    expect(isNoAnswer(emptyEvidence(), true, 0)).toBe(true)
    expect(isNoAnswer(emptyEvidence(), false, 0)).toBe(false)
  })
  it('picks the phase', () => {
    const base = { working: false, evidence: emptyEvidence(), answer: null, cited: 0, hits: 3, zeroHitsTried: false }
    const fit = finished([item('a')])
    expect(lookupPhase(base)).toBe('local')
    expect(lookupPhase({ ...base, working: true, evidence: fit })).toBe('working')
    expect(lookupPhase({ ...base, evidence: fit })).toBe('sources')
    expect(lookupPhase({ ...base, evidence: fit, answer: answer('[1]', [{ id: 1, evidenceId: 'a' }]), cited: 1 })).toBe('answer')
    // An answer with nothing to cite on screen falls back to the confirmed sources.
    expect(lookupPhase({ ...base, evidence: fit, answer: answer('x', []), cited: 0 })).toBe('sources')
    expect(lookupPhase({ ...base, evidence: finished([item('a', 'unfit')]) })).toBe('noAnswer')
    expect(lookupPhase({ ...base, hits: 0, zeroHitsTried: true })).toBe('noAnswer')
  })
})

describe('statusChip', () => {
  const chip = (phase: LookupPhase, busy = false) => text(statusChip(phase, { seconds: 6, sources: 3, busy }))
  it('says where the answer stands, in the board copy', () => {
    expect(chip('working')).toBe('正在找依据 · 6 秒')
    expect(chip('answer')).toBe('有依据 · 3 处')
    expect(chip('sources')).toBe('有依据 · 3 处')
    expect(chip('noAnswer')).toBe('没有依据')
    expect(chip('local')).toBe('只有本地结果')
    expect(chip('local', true)).toBeNull()
  })
})

describe('footerLine', () => {
  it('names each host once and the run\'s passages; nothing when no host was contacted', () => {
    const line = footerLine({ working: false, hosts: ['localhost:8080', null, 'api.example.com', 'localhost:8080'], sent: 74 }, '、')!
    expect(text(line.wide)).toBe('本次发送到 localhost:8080、api.example.com · 共 74 段 · 保密笔记未发送')
    expect(text(line.compact)).toBe('本次发送到 2 个主机 · 74 段 · 保密笔记未发送')
    expect(footerLine({ working: false, hosts: [null, null], sent: 0 }, '、')).toBeNull()
  })
  it('says where it is sending while working', () => {
    const line = footerLine({ working: true, hosts: ['localhost:8080'], sent: 10 }, '、')!
    expect(text(line.wide)).toBe('正在发送到 localhost:8080 · 保密笔记不发送')
    expect(line.compact).toEqual(line.wide)
  })
})

describe('fallbackLine', () => {
  const base = {
    phase: 'local' as LookupPhase, header: { kind: 'none' } as HeaderState, evidence: emptyEvidence(), disabled: false,
    evidenceError: false, jevHost: 'localhost:8080', answerGate: null as AnswerGate | null, answer: null as AnswerResult | null,
    answerStopped: false,
  }
  const degraded = (status: Extract<HeaderState, { kind: 'degraded' }>['status'], host: string | null = 'localhost:8080'): HeaderState =>
    ({ kind: 'degraded', status, host, statusClass: '5xx', missing: null })
  const line = (extra: Partial<typeof base>) => {
    const result = fallbackLine({ ...base, ...extra })
    return result && {
      text: text(result.reason ? { ...result, params: { ...result.params, reason: zh[result.reason] } } : result),
      settings: result.settings,
    }
  }

  it('one line above the local results, with 「设置」 only when there is something to set', () => {
    expect(line({ disabled: true })).toEqual({ text: '查找增强还没设置好，只显示本地结果。', settings: true })
    expect(line({ header: degraded('notConfigured', null) })).toEqual({ text: '查找增强还没设置好，只显示本地结果。', settings: true })
    expect(line({ header: degraded('noConsent') })).toEqual({ text: '没有允许发送到 localhost:8080，只显示本地结果。', settings: true })
    expect(line({ header: degraded('timeout') })).toEqual({
      text: '没能确认依据：localhost:8080 超时。下面是本机按相关度排的结果，再按一次回车会重试。', settings: false,
    })
    expect(line({ header: degraded('keyInvalid', null) })?.text).toBe('没能确认依据：localhost:8080 拒绝了密钥。下面是本机按相关度排的结果，再按一次回车会重试。')
    expect(line({ header: degraded('unreachable') })?.text).toContain('localhost:8080 连不上')
    expect(line({ header: degraded('invalid') })?.text).toContain('localhost:8080 返回无效')
    expect(line({ header: degraded('cancelled') })?.settings).toBe(false)
    expect(line({})).toBeNull()
  })
  it('never carries more than the host and the reason class', () => {
    for (const status of ['notConfigured', 'noConsent', 'timeout', 'keyInvalid', 'unreachable', 'invalid', 'cancelled'] as const) {
      const result = fallbackLine({ ...base, header: degraded(status) })!
      expect(Object.keys(result.params).every((name) => name === 'host'), status).toBe(true)
      const filled = [...Object.keys(result.params), ...(result.reason ? ['reason'] : [])].sort()
      const placeholders = (en[result.key].match(/\{(\w+)\}/g) ?? []).map((p) => p.slice(1, -1)).sort()
      expect(filled, status).toEqual(placeholders)
      if (result.reason) expect(en[result.reason]).not.toMatch(/\{/)
    }
  })
  it('above the confirmed sources when no answer was written', () => {
    const sources = { ...base, phase: 'sources' as LookupPhase }
    expect(line({ ...sources, answerGate: { kind: 'noConsent', host: 'api.example.com' } }))
      .toEqual({ text: '没有允许发送到 api.example.com，没有写回答。', settings: true })
    expect(line({ ...sources, answerGate: { kind: 'notConfigured' } })?.settings).toBe(true)
    expect(line({ ...sources, answer: answer(null, [], { status: 'invalidCitations' }) }))
      .toEqual({ text: '没能写出有依据的回答，下面是确认过的依据。', settings: false })
    expect(line({ ...sources, answer: answer(null, [], { status: 'noConsent' }) })?.settings).toBe(true)
    expect(line({ ...sources, answerStopped: true })?.text).toBe('已停止写回答，下面是确认过的依据。')
  })
  it('nothing while working, with an answer, or when nothing answers', () => {
    for (const phase of ['working', 'answer', 'noAnswer'] as const) expect(line({ phase, header: degraded('timeout') })).toBeNull()
  })
})

describe('triedSteps', () => {
  const attempt = (kind: 'original' | 'rephrased' | 'scan', hits: number | null) => ({ kind, hits, tookMs: 5 })
  it('lists only the tries that ran, in order, with their counts', () => {
    const steps = triedSteps({
      original: attempt('original', 0), rephrased: attempt('rephrased', 0), scan: attempt('scan', 0),
      order: ['original', 'rephrased', 'scan'],
    }, [{ terms: ['采购合同'], phrases: [] }, { terms: ['返点'], phrases: [] }], null, '、')
    expect(steps.map((step) => [text(step.label), text(step.result)])).toEqual([
      ['本机检索原问题', '0 条'],
      ['换两组说法重搜（采购合同、返点）', '0 条'],
      ['逐行扫描全部文件', '0 条'],
    ])
  })
  it('says the judged try\'s hits were all unrelated; a try that did not run is not listed', () => {
    const steps = triedSteps({ original: attempt('original', 6), rephrased: null, scan: null, order: ['original'] }, [], 'original', '、')
    expect(steps.map((step) => [text(step.label), text(step.result)])).toEqual([['本机检索原问题', '6 条 · 都不相关']])
  })
})
