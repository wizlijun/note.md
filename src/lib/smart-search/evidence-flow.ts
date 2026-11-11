import type { AnswerResult, EvidenceItem, EvidenceStepResult, EvidenceStop, EvidenceTerm } from './api'
import type { HeaderState } from './enhance-flow'
import { endpointHost, type SmartLookupSettings } from './settings'

// Pure state for the lookup window's evidence section (spec H.8). No I/O.

export interface EvidenceRound { hop: number; terms: EvidenceTerm[]; items: EvidenceItem[] }
export interface EvidenceView {
  rounds: EvidenceRound[]
  /** The latest scored round's list: rounds apply as they arrive (answer-first plan, behaviour 9). */
  shown: EvidenceItem[]
  done: boolean
  stop: EvidenceStop | null
  /**
   * The run ended on a failed round after at least one scored round (final
   * review I5): the failed round is dropped whole, and the evidence the
   * scored rounds confirmed stands, so the answer is written from it.
   */
  interrupted: boolean
}

export function emptyEvidence(): EvidenceView {
  return { rounds: [], shown: [], done: false, stop: null, interrupted: false }
}

/** A round that failed (timeout, unreachable, key, invalid return, not set up): not a skip, not a stop the user asked for. */
function failed(status: EvidenceStepResult['status']): boolean {
  return status !== 'ok' && status !== 'skipped' && status !== 'cancelled'
}

/**
 * A call that scored no new round keeps the rounds and the shown list, ends
 * the run and records its stop: a failed round (`status !== 'ok'`), or a stop
 * other than `maxHops`, for which the host reports the last scored evidence
 * again (`maxHops` comes with the round that reached it, pre-flight P14). A
 * failed round after a scored one marks the run `interrupted`. A scored round
 * replaces the list.
 */
export function applyRound(view: EvidenceView, result: EvidenceStepResult): EvidenceView {
  const scored = result.status === 'ok' && (result.stop === null || result.stop === 'maxHops')
  if (!scored) {
    return { ...view, done: true, stop: result.stop ?? view.stop, interrupted: view.rounds.length > 0 && failed(result.status) }
  }
  const round: EvidenceRound = { hop: result.hop, terms: result.terms, items: result.evidence }
  const rounds = [...view.rounds.filter((r) => r.hop !== result.hop), round].sort((a, b) => a.hop - b.hop)
  return { rounds, shown: result.evidence, done: result.done, stop: result.stop, interrupted: false }
}

/** The host refused a step outright (an error, not a status): like a failed round, it ends the run. */
export function interruptRun(view: EvidenceView): EvidenceView {
  return { ...view, done: true, interrupted: view.rounds.length > 0 }
}

/**
 * The run finished on its own: the host said done with a stop. A failed or
 * cancelled round ends the run without a stop (it keeps the previous one, and
 * the first round has none), and an index change makes the evidence stale, so
 * neither counts: no answer is written from it and it is not "no answer".
 */
export function evidenceFinished(view: EvidenceView): boolean {
  return view.done && view.stop !== null && view.stop !== 'indexChanged'
}

/** The shown evidence Jev judged `fit`, in its order: what the answer is written from. */
export function fitEvidence(view: EvidenceView): EvidenceItem[] {
  return view.shown.filter((item) => item.tier === 'fit')
}

/**
 * There is confirmed evidence to write the answer from: the rounds finished,
 * or a later round failed after earlier ones confirmed something (I5).
 */
export function answerable(view: EvidenceView): boolean {
  return fitEvidence(view).length > 0 && (evidenceFinished(view) || view.interrupted)
}

/** 「已确认 N 处」: the `fit` items of the latest completed round (ledger ruling: no host change). */
export function confirmedCount(view: EvidenceView): number | null {
  const latest = view.rounds.at(-1)
  return latest ? latest.items.filter((item) => item.tier === 'fit').length : null
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

/** What a run sent, as the host counts it: the footer's host and passage count, and the order of results. */
export interface EvidenceTotals {
  /** The Jev host passages went to; null while nothing was sent. */
  host: string | null
  /** Distinct passages sent over the run. */
  sent: number
  /** The run's time so far; a newer result for the run has at least this. */
  elapsedMs: number
  /** Distinct passages of confidential notes the host left out unchecked (final review I4). */
  skippedConfidential: number
}

export function emptyTotals(): EvidenceTotals {
  return { host: null, sent: 0, elapsedMs: 0, skippedConfidential: 0 }
}

/**
 * The run's totals from a step result: the host keeps them over the whole
 * run (distinct passages, every call that reached a round, cancelled ones
 * included), so the latest result for the run is the answer, also one whose
 * evidence the window drops after a stop.
 */
export function totalsOf(result: EvidenceStepResult): EvidenceTotals {
  return {
    host: result.run.endpointHost,
    sent: result.run.sentBlocks,
    elapsedMs: result.run.elapsedMs,
    skippedConfidential: result.run.skippedConfidential,
  }
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
 * only the source labels the host checks become citations, so labels inside
 * code and Markdown links stay text. Each number of a label that names a sent
 * source is one numbered chip (`text` is the number), and the label's
 * brackets and separators go; a number that names no sent source stays text
 * as `[n]`, and a label with no such number stays as written.
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
  let at = 0
  for (const { start, end, inner } of sourceLabels(text)) {
    pushText(text.slice(at, start))
    const numbers = [...inner.matchAll(/\d+/g)].map((match) => Number(match[0]))
    if (!numbers.some((id) => byId.has(id))) {
      pushText(text.slice(start, end))
    } else {
      for (const id of numbers) {
        const evidenceId = byId.get(id)
        if (evidenceId === undefined) pushText(`[${id}]`)
        else parts.push({ kind: 'cite', text: String(id), id, evidenceId })
      }
    }
    at = end
  }
  pushText(text.slice(at))
  return parts
}

/** Whether the window writes the answer by itself (ruling A): the answer model is set up and its host allowed. */
export type AnswerGate =
  | { kind: 'start' }
  | { kind: 'notConfigured' }
  | { kind: 'noConsent'; host: string }

/**
 * Ruling A: the answer starts on its own only when the answer model's url and
 * model are set and the user allowed its host. The host checks again (and
 * checks the key) before sending anything.
 */
export function answerGate(settings: SmartLookupSettings): AnswerGate {
  const chat = settings.enhance.chat
  const host = endpointHost(chat.url, 'chat')
  if (!settings.enhance.enabled || !chat.url.trim() || !chat.model.trim() || host === null) return { kind: 'notConfigured' }
  return host === chat.consentHost ? { kind: 'start' } : { kind: 'noConsent', host }
}
