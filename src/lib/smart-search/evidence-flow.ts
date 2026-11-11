import type { Messages } from '../i18n/en'
import type { SearchHit } from '../search/api'
import type { AnswerResult, EvidenceItem, EvidenceStepResult, EvidenceStop, EvidenceTerm } from './api'
import type { HeaderState } from './enhance-flow'
import { endpointHost, type SmartLookupSettings } from './settings'

// Pure state for the lookup window's evidence section (spec H.8). No I/O.

export interface EvidenceRound { hop: number; terms: EvidenceTerm[]; items: EvidenceItem[] }
export interface EvidenceView {
  rounds: EvidenceRound[]
  shown: EvidenceItem[]
  /** The list the latest round produced while the user was interacting; `null` when nothing waits for Apply. */
  pending: EvidenceItem[] | null
  done: boolean
  stop: EvidenceStop | null
}

export function emptyEvidence(): EvidenceView {
  return { rounds: [], shown: [], pending: null, done: false, stop: null }
}

/**
 * A call that scored no new round keeps the rounds, the shown list and any
 * list waiting for Apply, ends the run and records its stop: a failed round
 * (`status !== 'ok'`), or a stop other than `maxHops`, for which the host
 * reports the last scored evidence again (`maxHops` comes with the round that
 * reached it, pre-flight P14). A scored round replaces the list, or, once the
 * user has interacted, waits as `pending` while new items are appended in
 * place; a round whose order is already the one shown leaves nothing to apply.
 */
export function applyRound(view: EvidenceView, result: EvidenceStepResult, interacted: boolean): EvidenceView {
  const scored = result.status === 'ok' && (result.stop === null || result.stop === 'maxHops')
  if (!scored) return { ...view, done: true, stop: result.stop ?? view.stop }
  const round: EvidenceRound = { hop: result.hop, terms: result.terms, items: result.evidence }
  const rounds = [...view.rounds.filter((r) => r.hop !== result.hop), round].sort((a, b) => a.hop - b.hop)
  const base = { rounds, done: result.done, stop: result.stop }
  if (!interacted) return { ...base, shown: result.evidence, pending: null }
  const have = new Set(view.shown.map((i) => i.evidenceId))
  const shown = [...view.shown, ...result.evidence.filter((i) => !have.has(i.evidenceId))]
  return { ...base, shown, pending: sameOrder(shown, result.evidence) ? null : result.evidence }
}

function sameOrder(a: EvidenceItem[], b: EvidenceItem[]): boolean {
  return a.length === b.length && a.every((item, index) => item.evidenceId === b[index].evidenceId)
}

export function applyPending(view: EvidenceView): EvidenceView {
  return view.pending ? { ...view, shown: view.pending, pending: null } : view
}

/** Back to the snapshot of an earlier round; no request. Unknown hops change nothing. */
export function restoreRound(view: EvidenceView, hop: number): EvidenceView {
  const round = view.rounds.find((r) => r.hop === hop)
  return round ? { ...view, shown: round.items, pending: null } : view
}

export function roundLabel(foundRound: number): keyof Messages {
  if (foundRound <= 0) return 'smartSearch.evidence.round.local'
  return foundRound === 1 ? 'smartSearch.evidence.round.one' : 'smartSearch.evidence.round.two'
}

/**
 * The status line for a step, as for the one-round judge: ok and skipped
 * show nothing (a busy index says so), every other status is degraded. Only
 * the endpoint host and the status class reach it, never remote text.
 */
export function headerFromStep(result: EvidenceStepResult): HeaderState {
  switch (result.status) {
    case 'ok':
      return { kind: 'none' }
    case 'skipped':
      return result.skipReason === 'indexUnavailable' ? { kind: 'indexUnavailable' } : { kind: 'none' }
    default:
      return { kind: 'degraded', status: result.status, host: result.endpointHost, statusClass: result.statusClass, missing: result.missing }
  }
}

/**
 * 「查找证据」 after the host declined to start on its own: the route skips
 * (a pinned page, few terms) or the run's automatic slot is used (H.8: the
 * user may still start it).
 */
export function startOffered(result: EvidenceStepResult): boolean {
  return result.status === 'skipped'
    && (result.skipReason === 'pinned' || result.skipReason === 'fewTerms' || result.skipReason === 'autoBudgetUsed')
}

/**
 * The line that says how a finished run ended, or null: the token budget, an
 * index change, evidence too large for the context, or a run that found no
 * evidence. The host keeps the top `topK` of every scored block whatever its
 * score, so "no evidence" means every shown item is `unfit` (and, vacuously,
 * an empty list). A failed round is not "no evidence": the status line says
 * what failed.
 */
export function evidenceNotice(view: EvidenceView): keyof Messages | null {
  if (view.stop === 'budget') return 'smartSearch.evidence.budget'
  if (view.stop === 'indexChanged') return 'smartSearch.evidence.indexChanged'
  if (view.stop === 'evidenceTooLarge') return 'smartSearch.evidence.tooLarge'
  const none = view.done && view.stop !== null && view.shown.every((item) => item.tier === 'unfit')
  return none ? 'smartSearch.evidence.none' : null
}

/** What a run sent and left out, summed over its calls (the F.3 details, without the reorder lines). */
export interface EvidenceTotals {
  /** The host passages went to; null while nothing was sent. */
  host: string | null
  requests: number
  elapsedMs: number
  sent: number
  tokens: number
  confidential: number
  stale: number
  /** Blocks too long to send, alone (`skippedLong`) or in any batch (`skippedOversize`). */
  long: number
}

export function emptyTotals(): EvidenceTotals {
  return { host: null, requests: 0, elapsedMs: 0, sent: 0, tokens: 0, confidential: 0, stale: 0, long: 0 }
}

export function addTotals(totals: EvidenceTotals, result: EvidenceStepResult): EvidenceTotals {
  return {
    host: result.requestCount > 0 && result.endpointHost ? result.endpointHost : totals.host,
    requests: totals.requests + result.requestCount,
    elapsedMs: totals.elapsedMs + result.elapsedMs,
    sent: totals.sent + result.sentBlocks,
    tokens: totals.tokens + (result.requestCount > 0 ? result.estimatedTokens : 0),
    confidential: totals.confidential + result.skippedConfidential,
    stale: totals.stale + result.skippedStale,
    long: totals.long + result.skippedLong + result.skippedOversize,
  }
}

/**
 * The absolute path of a vault-relative evidence path, for opening it in the
 * editor. Evidence carries only the vault path; every local hit of the run
 * shows the vault root (its `absPath` ends with its `path`). Null when no
 * local hit does.
 */
export function absolutePath(path: string, hits: Pick<SearchHit, 'path' | 'absPath'>[]): string | null {
  const same = hits.find((hit) => hit.path === path)
  if (same) return same.absPath
  for (const hit of hits) {
    if (!hit.absPath.replace(/\\/g, '/').endsWith(`/${hit.path}`)) continue
    const root = hit.absPath.slice(0, hit.absPath.length - hit.path.length)
    return root + (hit.absPath.includes('\\') ? path.replace(/\//g, '\\') : path)
  }
  return null
}

/**
 * H.8: Jev configured, current host consented, local hits, and a route that is
 * not `skip`. The window knows only the hit count, so it passes `judge` for
 * hits and the host applies the real route (pinned page, few terms) and
 * answers `skipped`. Keys and the https rule are not checked here either: the
 * host gates them (`gate_jev`) and answers `notConfigured` before sending.
 */
export function shouldStartEvidence(hits: number, route: 'judge' | 'skip' | 'repair', settings: SmartLookupSettings): boolean {
  const { enabled, jev } = settings.enhance
  const host = endpointHost(jev.url)
  return enabled && hits > 0 && route !== 'skip' && jev.url.trim() !== '' && jev.model.trim() !== ''
    && host !== null && host === jev.consentHost
}

/** A piece of the answer: plain text, or a cited source number that links to its evidence item. */
export type AnswerPart =
  | { kind: 'text'; text: string }
  | { kind: 'cite'; text: string; id: number; evidenceId: string }

/** The host's code spans and source label (`invalid_citations` in src-tauri/src/smart_enhance/answer.rs). */
const CODE = /```[\s\S]*?(?:```|$)|`[^`]*`/g
const SOURCE_LABEL = /\[(\d+(?:[ ,，]+\d+)*)\]/g

/**
 * The source labels the host counts, as ranges of `text`: the host removes
 * fenced and inline code, then takes each `[n]` / `[1, 2]` of the remaining
 * prose that is not followed by `(` or `:` (a Markdown link or definition).
 * A label the removal joined across a code span is not a range of `text` and
 * is left out.
 */
function sourceLabels(text: string): { start: number; end: number; inner: string }[] {
  const pieces: { at: number; from: number; text: string }[] = []
  let from = 0
  let at = 0
  const keep = (to: number) => {
    if (to > from) { pieces.push({ at, from, text: text.slice(from, to) }); at += to - from }
  }
  for (const code of text.matchAll(CODE)) {
    keep(code.index ?? 0)
    from = (code.index ?? 0) + code[0].length
  }
  keep(text.length)
  const prose = pieces.map((piece) => piece.text).join('')
  const labels: { start: number; end: number; inner: string }[] = []
  for (const match of prose.matchAll(SOURCE_LABEL)) {
    const start = match.index ?? 0
    const end = start + match[0].length
    if (prose[end] === '(' || prose[end] === ':') continue
    const piece = pieces.find((p) => start >= p.at && end <= p.at + p.text.length)
    if (!piece) continue
    const origin = piece.from + start - piece.at
    labels.push({ start: origin, end: origin + match[0].length, inner: match[1] })
  }
  return labels
}

/**
 * The answer as plain text (spec H.4): nothing is parsed as HTML or Markdown;
 * only the source labels the host checks become links, so labels inside code
 * and Markdown links stay text. `[n]` is one link; a list keeps its brackets
 * and separators as text around one link per number. A number that names no
 * sent source stays text.
 */
export function answerParts(text: string, sources: AnswerResult['sources']): AnswerPart[] {
  const byId = new Map(sources.map((source) => [source.id, source.evidenceId]))
  const parts: AnswerPart[] = []
  const pushText = (value: string) => {
    if (!value) return
    const last = parts.at(-1)
    if (last?.kind === 'text') last.text += value
    else parts.push({ kind: 'text', text: value })
  }
  const cite = (digits: string, label: string) => {
    const id = Number(digits)
    const evidenceId = byId.get(id)
    if (evidenceId === undefined) pushText(label)
    else parts.push({ kind: 'cite', text: label, id, evidenceId })
  }
  let at = 0
  for (const { start, end, inner } of sourceLabels(text)) {
    pushText(text.slice(at, start))
    if (/^\d+$/.test(inner)) {
      cite(inner, text.slice(start, end))
    } else {
      pushText('[')
      let from = 0
      for (const number of inner.matchAll(/\d+/g)) {
        const index = number.index ?? 0
        pushText(inner.slice(from, index))
        cite(number[0], number[0])
        from = index + number[0].length
      }
      pushText(inner.slice(from) + ']')
    }
    at = end
  }
  pushText(text.slice(at))
  return parts
}
