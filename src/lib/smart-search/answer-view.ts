import type { Messages } from '../i18n/en'
import type { SearchHit } from '../search/api'
import type { AnswerResult, EvidenceItem, TermGroup, Tier } from './api'
import type { AttemptKind, HeaderState, LookupAttempt } from './enhance-flow'
import { answerable, answerParts, evidenceFinished, fitEvidence, type AnswerGate, type EvidenceView } from './evidence-flow'
import { hitKey } from './hit-key'

// Pure state for the answer-first lookup window (plan 2026-11-11): what the
// answer area, the status chip, the fallback line and the footer show. No I/O.

export type ViewMessage = { key: keyof Messages; params: Record<string, string | number> }

/**
 * `working`: evidence rounds or the answer are running. `answer`: a cited
 * answer. `sources`: confirmed sources without an answer (the answer was not
 * allowed, failed or was stopped). Both also follow a later round that
 * failed after earlier ones confirmed evidence (`answerable`). `noAnswer`: nothing in the notes answers
 * the question. `local`: local results only.
 */
export type LookupPhase = 'local' | 'working' | 'answer' | 'sources' | 'noAnswer'

/** A source of the answer: its number as the answer cites it, and the passage. */
export interface NumberedSource { id: number; item: EvidenceItem }

/**
 * The sources the answer cites, in citation-number order, numbered as cited.
 * Only labels the window shows as citations count, each source once, and only
 * passages still on screen.
 */
export function citedSources(answer: AnswerResult | null, shown: EvidenceItem[]): NumberedSource[] {
  if (answer?.status !== 'ok' || answer.text === null) return []
  const byEvidence = new Map(shown.map((item) => [item.evidenceId, item]))
  const ids = new Set<number>()
  for (const part of answerParts(answer.text, answer.sources)) if (part.kind === 'cite') ids.add(part.id)
  const seen = new Set<string>()
  const sources: NumberedSource[] = []
  for (const id of [...ids].sort((a, b) => a - b)) {
    const evidenceId = answer.sources.find((source) => source.id === id)?.evidenceId
    const item = evidenceId === undefined ? undefined : byEvidence.get(evidenceId)
    if (!item || seen.has(item.evidenceId)) continue
    seen.add(item.evidenceId)
    sources.push({ id, item })
  }
  return sources
}

/** Without an answer: the confirmed (`fit`) evidence, numbered in its order. */
export function confirmedSources(view: EvidenceView): NumberedSource[] {
  return fitEvidence(view).map((item, index) => ({ id: index + 1, item }))
}

/**
 * Everything behind 「其他结果」, each block (path and line range) once and
 * never one already listed as a source: the evidence first, `fit` before the
 * rest, then the local results. `unfit` rows are left out unless asked for
 * (the no-answer view lists them, next to rows that were never judged).
 */
export function otherResults<T extends SearchHit>(input: {
  shown: EvidenceItem[]
  sources: EvidenceItem[]
  local: T[]
  localTier: (hit: T) => Tier | undefined
  includeUnfit: boolean
}): { evidence: EvidenceItem[]; local: T[] } {
  const taken = new Set(input.sources.map(hitKey))
  const keep = (key: string, tier: Tier | undefined) => {
    if (taken.has(key) || (!input.includeUnfit && tier === 'unfit')) return false
    taken.add(key)
    return true
  }
  const ranked = [...input.shown.filter((item) => item.tier === 'fit'), ...input.shown.filter((item) => item.tier !== 'fit')]
  const evidence = ranked.filter((item) => keep(hitKey(item), item.tier))
  const local = input.local.filter((hit) => keep(hitKey(hit), input.localTier(hit)))
  return { evidence, local }
}

/**
 * Whether every row was judged `unfit`: only then may the no-answer view call
 * them 「都不相关」 (final review I4). A row without a tier was never judged
 * (a confidential, over-long, stale or section-level hit, or one beyond the
 * candidates), and `unsure` is not unrelated either. An empty list is not.
 */
export function allJudgedUnfit<T>(rows: T[], tier: (row: T) => Tier | undefined): boolean {
  return rows.length > 0 && rows.every((row) => tier(row) === 'unfit')
}

/**
 * At least one round sent passages and came back scored. A run can end
 * `done` before that (the evidence is too large, the budget, no terms, no
 * candidates on round 0): then nothing was judged.
 */
export function judgedAnything(view: EvidenceView): boolean {
  return view.rounds.length > 0
}

/**
 * Plan behaviour 6: the rounds finished, at least one of them judged
 * passages, and no shown evidence is `fit`; or no try found anything. A run
 * that judged nothing says nothing about the local results.
 */
export function isNoAnswer(view: EvidenceView, zeroHitsTried: boolean, hits: number): boolean {
  if (evidenceFinished(view) && judgedAnything(view)) return fitEvidence(view).length === 0
  return hits === 0 && zeroHitsTried
}

export function lookupPhase(input: {
  working: boolean
  evidence: EvidenceView
  answer: AnswerResult | null
  cited: number
  hits: number
  zeroHitsTried: boolean
}): LookupPhase {
  if (input.working) return 'working'
  if (input.answer?.status === 'ok' && input.cited > 0) return 'answer'
  if (isNoAnswer(input.evidence, input.zeroHitsTried, input.hits)) return 'noAnswer'
  if (answerable(input.evidence)) return 'sources'
  return 'local'
}

/** The query bar's right side. `null` while a local search runs. */
export function statusChip(phase: LookupPhase, input: { seconds: number; sources: number; busy: boolean }): ViewMessage | null {
  switch (phase) {
    case 'working': return { key: 'smartSearch.status.working', params: { s: input.seconds } }
    case 'answer':
    case 'sources': return { key: 'smartSearch.status.grounded', params: { n: input.sources } }
    case 'noAnswer': return { key: 'smartSearch.status.noEvidence', params: {} }
    case 'local': return input.busy ? null : { key: 'smartSearch.status.localOnly', params: {} }
  }
}

/**
 * The passive footer line: the hosts contacted for this lookup (each once)
 * and the run's distinct passages sent. Nothing when no host was contacted.
 * `compact` is the narrow window's shorter form.
 */
export function footerLine(
  input: { working: boolean; hosts: Array<string | null>; sent: number },
  separator: string,
): { wide: ViewMessage; compact: ViewMessage } | null {
  const hosts = [...new Set(input.hosts.filter((host): host is string => Boolean(host)))]
  if (!hosts.length) return null
  if (input.working) {
    const line: ViewMessage = { key: 'smartSearch.footer.sending', params: { hosts: hosts.join(separator) } }
    return { wide: line, compact: line }
  }
  return {
    wide: { key: 'smartSearch.footer.sent', params: { hosts: hosts.join(separator), n: input.sent } },
    compact: { key: 'smartSearch.footer.sentCompact', params: { count: hosts.length, n: input.sent } },
  }
}

/** `reason`: the reason class's own message, filled into the line's `{reason}`. */
export type FallbackLine = ViewMessage & { settings: boolean; reason: keyof Messages | null }

const REASON = {
  timeout: 'smartSearch.fallback.reason.timeout',
  unreachable: 'smartSearch.fallback.reason.unreachable',
  keyInvalid: 'smartSearch.fallback.reason.keyInvalid',
  invalid: 'smartSearch.fallback.reason.invalid',
} as const satisfies Record<string, keyof Messages>

/**
 * The one line above the local results (or the confirmed sources) when the
 * answer could not be grounded or written, or above an answer written before
 * the evidence check finished. It carries only the host name and
 * the reason class, never remote text; `settings` adds the 「设置」 link.
 */
export function fallbackLine(input: {
  phase: LookupPhase
  header: HeaderState
  evidence: EvidenceView
  /** Enhancement switched off in Settings. */
  disabled: boolean
  /** The host refused the step itself (an error, not a status): nothing to name but the failure. */
  evidenceError: boolean
  /** The Jev host from the settings, for a failure that did not name one. */
  jevHost: string | null
  /** Why the window did not ask for an answer (ruling A); `null` when it did. */
  answerGate: AnswerGate | null
  answer: AnswerResult | null
  answerStopped: boolean
}): FallbackLine | null {
  const line = (key: keyof Messages, params: Record<string, string | number> = {}, settings = false, reason: keyof Messages | null = null): FallbackLine =>
    ({ key, params, settings, reason })
  if (input.phase === 'sources') {
    if (input.answerStopped) return line('smartSearch.fallback.answerStopped')
    const gate = input.answerGate
    if (gate?.kind === 'noConsent') return line('smartSearch.fallback.answerNoConsent', { host: gate.host }, true)
    if (gate?.kind === 'notConfigured' || input.answer?.status === 'notConfigured') return line('smartSearch.fallback.answerNotConfigured', {}, true)
    if (input.answer?.status === 'noConsent') return line('smartSearch.fallback.answerNoConsent', { host: input.answer.endpointHost ?? '' }, true)
    return line('smartSearch.fallback.answerFailed')
  }
  // The answer stands on the evidence confirmed before a later round failed (I5): say the check did not finish.
  if (input.phase === 'answer') return input.evidence.interrupted ? line('smartSearch.fallback.checkUnfinished') : null
  if (input.phase !== 'local') return null
  if (input.disabled) return line('smartSearch.fallback.notEnabled', {}, true)
  const header = input.header
  if (header.kind === 'indexUnavailable') return line('smartSearch.enhance.indexUnavailable')
  if (header.kind === 'degraded') {
    const host = header.host ?? input.jevHost ?? ''
    switch (header.status) {
      case 'notConfigured': return line('smartSearch.fallback.notEnabled', {}, true)
      case 'noConsent': return line('smartSearch.fallback.noConsent', { host }, true)
      case 'cancelled': return line('smartSearch.fallback.stopped')
      default: return line('smartSearch.fallback.failed', { host }, false, REASON[header.status])
    }
  }
  if (input.evidenceError) return line('smartSearch.fallback.error')
  if (input.evidence.done && input.evidence.stop === 'indexChanged') return line('smartSearch.evidence.indexChanged')
  // A route the host skips (spec §5.3) gets its reason in one passive line (M4).
  if (input.evidence.done && input.evidence.skipReason === 'pinned') return line('smartSearch.fallback.skipPinned')
  if (input.evidence.done && input.evidence.skipReason === 'fewTerms') return line('smartSearch.fallback.skipFewTerms')
  if (evidenceFinished(input.evidence) && !judgedAnything(input.evidence)) return line('smartSearch.fallback.nothingToCheck')
  return null
}

/** One row of 「已经自动试过」. */
export interface TriedStep { kind: AttemptKind; label: ViewMessage; result: ViewMessage }

/**
 * The automatic tries that actually ran, in the order they ran, each with its
 * count. `judged` is the try whose results the evidence rounds checked and
 * found all unrelated (`allJudgedUnfit`): its count says so.
 */
export function triedSteps(
  attempts: { original: LookupAttempt; rephrased: LookupAttempt | null; scan: LookupAttempt | null; order: AttemptKind[] },
  groups: TermGroup[],
  judged: AttemptKind | null,
  separator: string,
): TriedStep[] {
  const steps: TriedStep[] = []
  for (const kind of attempts.order) {
    const attempt = kind === 'original' ? attempts.original : attempts[kind]
    if (!attempt || attempt.hits === null) continue
    const terms = groups.flatMap((group) => [...group.terms, ...group.phrases]).join(separator)
    const label: ViewMessage = kind === 'original'
      ? { key: 'smartSearch.answer.triedOriginal', params: {} }
      : kind === 'scan'
        ? { key: 'smartSearch.answer.triedScan', params: {} }
        : { key: groups.length > 1 ? 'smartSearch.answer.triedRephraseTwo' : 'smartSearch.answer.triedRephraseOne', params: { terms } }
    const result: ViewMessage = kind === judged && attempt.hits > 0
      ? { key: 'smartSearch.answer.triedUnrelated', params: { n: attempt.hits } }
      : { key: 'smartSearch.answer.triedCount', params: { n: attempt.hits } }
    steps.push({ kind, label, result })
  }
  return steps
}
