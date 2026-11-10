import type { Messages } from '../i18n/en'
import type { EvidenceItem, EvidenceStepResult, EvidenceStop, EvidenceTerm } from './api'
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
 * A round that did not finish (`status !== 'ok'`) keeps the previous list and
 * ends the run. A round that did replaces the list, or, once the user has
 * interacted, waits as `pending` while new items are appended in place.
 */
export function applyRound(view: EvidenceView, result: EvidenceStepResult, interacted: boolean): EvidenceView {
  if (result.status !== 'ok') return { ...view, pending: null, done: true }
  const round: EvidenceRound = { hop: result.hop, terms: result.terms, items: result.evidence }
  const rounds = [...view.rounds.filter((r) => r.hop !== result.hop), round].sort((a, b) => a.hop - b.hop)
  const base = { rounds, done: result.done, stop: result.stop }
  if (!interacted) return { ...base, shown: result.evidence, pending: null }
  const have = new Set(view.shown.map((i) => i.evidenceId))
  const appended = result.evidence.filter((i) => !have.has(i.evidenceId))
  return { ...base, shown: [...view.shown, ...appended], pending: result.evidence }
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

/** H.8: Jev configured, current host consented, local hits, and a route that is not `skip`. */
export function shouldStartEvidence(hits: number, route: 'judge' | 'skip' | 'repair', settings: SmartLookupSettings): boolean {
  const { enabled, jev } = settings.enhance
  const host = endpointHost(jev.url)
  return enabled && hits > 0 && route !== 'skip' && jev.url.trim() !== '' && jev.model.trim() !== ''
    && host !== null && host === jev.consentHost
}
