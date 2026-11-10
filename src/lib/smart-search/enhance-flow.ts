import type { Messages } from '../i18n/en'
import type { SearchHit } from '../search/api'
import type { ChatRequestConfig, JevRequestConfig, JudgeResult, KeyStatus, Missing, Tier } from './api'
import type { ResultSection } from './lookup-view'
import { endpointHost, type SmartLookupSettings } from './settings'

// Pure state for the lookup window's enhancement (judge / repair) flow. No
// I/O here: the window calls the host and feeds the results in.

/** One host-side rule for the consent host (F12): defined in settings.ts, re-exported for the window. */
export { endpointHost }

export type DegradedStatus = 'notConfigured' | 'noConsent' | 'timeout' | 'keyInvalid' | 'unreachable' | 'invalid' | 'cancelled'

export type HeaderState =
  | { kind: 'none' }
  | { kind: 'judging'; count: number; startedAt: number }
  | { kind: 'judged'; result: JudgeResult }
  /** 排序有更新 · 应用; restoring the local order also lands here. */
  | { kind: 'pending'; result: JudgeResult }
  | { kind: 'topTenUnfit'; result: JudgeResult }
  | { kind: 'degraded'; status: DegradedStatus; host: string | null; statusClass: string | null; missing: Missing | null }
  /** Skipped because the index was busy, missing or another vault's: nothing could be checked, so nothing was sent (Task 5 ruling). */
  | { kind: 'indexUnavailable' }

export type HeaderMessage = { key: keyof Messages; params: Record<string, string | number> }

/**
 * ok: top-ten-unfit wins; otherwise a user who has already interacted gets
 * `pending` (the order waits for Apply) and one who has not gets `judged`.
 * An ok result that moved nothing has nothing to apply, so it is `judged`
 * either way. skipped → none, except a busy index. Every other status → degraded.
 */
export function headerFromJudge(result: JudgeResult, interacted: boolean): HeaderState {
  switch (result.status) {
    case 'ok':
      if (result.topTenUnfit) return { kind: 'topTenUnfit', result }
      return interacted && result.rerankedCount > 0 ? { kind: 'pending', result } : { kind: 'judged', result }
    case 'skipped':
      return result.skipReason === 'indexUnavailable' ? { kind: 'indexUnavailable' } : { kind: 'none' }
    default:
      return {
        kind: 'degraded',
        status: result.status,
        host: result.endpointHost,
        statusClass: result.statusClass,
        missing: result.missing,
      }
  }
}

/** Which judge call a result belongs to: the host run plus the window's request sequence number. */
export interface JudgeTicket { lookupRunId: string; seq: number }

/**
 * `headerFromJudge` for a result that has just arrived, or `null` when it
 * belongs to a superseded request (a newer lookup, a newer judge call on the
 * same run, or nothing in flight any more) and must be ignored.
 */
export function headerOnArrival(
  current: JudgeTicket | null,
  arrived: JudgeTicket,
  result: JudgeResult,
  interacted: boolean,
): HeaderState | null {
  if (!current || current.lookupRunId !== arrived.lookupRunId || current.seq !== arrived.seq) return null
  return headerFromJudge(result, interacted)
}

const DEGRADED_KEY: Record<DegradedStatus, keyof Messages> = {
  notConfigured: 'smartSearch.enhance.notConfigured',
  noConsent: 'smartSearch.enhance.noConsent',
  timeout: 'smartSearch.enhance.timeout',
  keyInvalid: 'smartSearch.enhance.keyInvalid',
  unreachable: 'smartSearch.enhance.unreachable',
  invalid: 'smartSearch.enhance.invalid',
  cancelled: 'smartSearch.enhance.cancelled',
}

/**
 * The list-header copy key and params. Params never carry more than the
 * endpoint host and the status class: no remote text reaches the header.
 * `none` and `judging` return null (judging needs a clock: `judgingMessage`).
 */
export function headerMessage(state: HeaderState): HeaderMessage | null {
  switch (state.kind) {
    case 'none':
    case 'judging':
      return null
    case 'judged':
      return state.result.rerankedCount > 0
        ? { key: 'smartSearch.enhance.judged', params: { n: state.result.rerankedCount } }
        : { key: 'smartSearch.enhance.judgedUnchanged', params: { n: state.result.judgedCount } }
    case 'pending':
      return { key: 'smartSearch.enhance.pending', params: {} }
    case 'topTenUnfit':
      return { key: 'smartSearch.enhance.topTenUnfit', params: {} }
    case 'indexUnavailable':
      return { key: 'smartSearch.enhance.indexUnavailable', params: {} }
    case 'degraded': {
      const key = DEGRADED_KEY[state.status]
      const host = state.host ?? ''
      switch (state.status) {
        case 'noConsent':
        case 'invalid':
          return { key, params: { host } }
        // Same fallback as the settings page's connection test.
        case 'keyInvalid':
          return { key, params: { host, code: state.statusClass ?? '4xx' } }
        case 'unreachable':
          return { key, params: { host, code: state.statusClass ? ` · ${state.statusClass}` : '' } }
        default:
          return { key, params: {} }
      }
    }
  }
}

/** 判断中 · {n} 条以内 · {s} 秒, with whole seconds since `startedAt`. */
export function judgingMessage(state: { kind: 'judging'; count: number; startedAt: number }, now: number): HeaderMessage {
  const s = Math.max(0, Math.floor((now - state.startedAt) / 1000))
  return { key: 'smartSearch.enhance.judging', params: { n: state.count, s } }
}

/** The judging header's count: line-level, unpinned hits among the first 50, at most 10. */
export function judgingCount(hits: Pick<SearchHit, 'level' | 'pinned'>[]): number {
  return Math.min(10, hits.slice(0, 50).filter((hit) => hit.level === 'line' && !hit.pinned).length)
}

/**
 * Reorders hits inside each section by their position in `order`; section
 * membership never changes. A hit the order does not name (or without a
 * `resultId`) keeps its slot; the named ones fill the remaining slots in order.
 */
export function applyOrder<T extends SearchHit & { resultId?: string }>(sections: ResultSection<T>[], order: string[]): ResultSection<T>[] {
  const rank = new Map(order.map((id, index) => [id, index]))
  const rankOf = (hit: T) => (hit.resultId === undefined ? undefined : rank.get(hit.resultId))
  return sections.map((section) => {
    const ranked = section.hits.filter((hit) => rankOf(hit) !== undefined).sort((a, b) => rankOf(a)! - rankOf(b)!)
    let next = 0
    const hits = section.hits.map((hit) => (rankOf(hit) === undefined ? hit : ranked[next++]))
    return { ...section, hits }
  })
}

/**
 * Where each section after the first starts in the flattened order. Empty
 * sections are skipped so the breaks stay strictly increasing inside
 * `1..len`, as the host requires.
 */
export function sectionBreaks(sections: ResultSection[]): number[] {
  const breaks: number[] = []
  let offset = 0
  for (const section of sections) {
    if (section.hits.length === 0) continue
    if (offset > 0) breaks.push(offset)
    offset += section.hits.length
  }
  return breaks
}

/** 1-based former position and direction, only for judged hits whose position changed; in `newOrder` order. */
export function movedFrom(
  localOrder: string[],
  newOrder: string[],
  judged: Set<string>,
): Map<string, { from: number; direction: 'up' | 'down' }> {
  const local = new Map(localOrder.map((id, index) => [id, index]))
  const moved = new Map<string, { from: number; direction: 'up' | 'down' }>()
  newOrder.forEach((id, index) => {
    const from = local.get(id)
    if (!judged.has(id) || from === undefined || from === index) return
    moved.set(id, { from: from + 1, direction: index < from ? 'up' : 'down' })
  })
  return moved
}

export function tiersById(result: JudgeResult | null): Map<string, Tier> {
  return new Map((result?.verdicts ?? []).map((verdict) => [verdict.resultId, verdict.tier]))
}

/** Built field by field: the host rejects unknown fields, and `preset` must never be sent (F13). */
export function jevRequestConfig(settings: SmartLookupSettings): JevRequestConfig {
  const jev = settings.enhance.jev
  return { url: jev.url, model: jev.model, authMode: jev.authMode, consentHost: jev.consentHost }
}

export function chatRequestConfig(settings: SmartLookupSettings): ChatRequestConfig {
  const chat = settings.enhance.chat
  return { url: chat.url, model: chat.model }
}

/** Zero local hits, enhancement on, the repair model's url and model both non-empty, and its key stored. */
export function shouldAutoRepair(hits: number, settings: SmartLookupSettings, keys: KeyStatus): boolean {
  const { enabled, chat } = settings.enhance
  return hits === 0 && enabled && chat.url.trim() !== '' && chat.model.trim() !== '' && keys.chat
}

export type AttemptKind = 'original' | 'rephrased' | 'scan'
/** `null` = not run. */
export interface LookupAttempt { kind: AttemptKind; hits: number | null; tookMs: number | null }

/** The three tries in fixed order; a try that did not run has null hits and time. */
export function noMatchAttempts(
  original: { hits: number; tookMs: number },
  rephrased: LookupAttempt | null,
  scan: LookupAttempt | null,
): LookupAttempt[] {
  const slot = (kind: AttemptKind, attempt: LookupAttempt | null): LookupAttempt =>
    ({ kind, hits: attempt?.hits ?? null, tookMs: attempt?.tookMs ?? null })
  return [
    { kind: 'original', hits: original.hits, tookMs: original.tookMs },
    slot('rephrased', rephrased),
    slot('scan', scan),
  ]
}
