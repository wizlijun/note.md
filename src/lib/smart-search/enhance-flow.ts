import type { Messages } from '../i18n/en'
import type { ChatAnswerConfig, ChatRequestConfig, JevRequestConfig, KeyStatus, Missing, RepairSuggestion } from './api'
import { endpointHost, type SmartLookupSettings } from './settings'

// Pure state for the lookup window's status line and repair flow. No I/O
// here: the window calls the host and feeds the results in. The evidence
// rounds have their own state (`evidence-flow.ts`).

/** One host-side rule for the consent host (F12): defined in settings.ts, re-exported for the window. */
export { endpointHost }

export type DegradedStatus = 'notConfigured' | 'noConsent' | 'timeout' | 'keyInvalid' | 'unreachable' | 'invalid' | 'cancelled'

export type HeaderState =
  | { kind: 'none' }
  | { kind: 'degraded'; status: DegradedStatus; host: string | null; statusClass: string | null; missing: Missing | null }
  /** Skipped because the index was busy, missing or another vault's: nothing could be checked, so nothing was sent (Task 5 ruling). */
  | { kind: 'indexUnavailable' }

export type HeaderMessage = { key: keyof Messages; params: Record<string, string | number> }

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
 * The status-line copy key and params. Params never carry more than the
 * endpoint host and the status class: no remote text reaches the line.
 * `none` returns null.
 */
export function headerMessage(state: HeaderState): HeaderMessage | null {
  switch (state.kind) {
    case 'none':
      return null
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
        // The host says what is missing: a key, or an endpoint that would send it in clear text.
        case 'notConfigured':
          if (state.missing === 'key') return { key: 'smartSearch.enhance.notConfiguredKey', params: {} }
          if (state.missing === 'insecure') return { key: 'smartSearch.enhance.notConfiguredInsecure', params: {} }
          return { key, params: {} }
        default:
          return { key, params: {} }
      }
    }
  }
}

/**
 * The notice for a repair (「换个说法」) that produced no wording, or null
 * (skipped, or wordings to search with). Timeout and invalid have their own
 * copy: the judge's says the local order was kept, which is not what failed.
 * Like the header, params carry only the endpoint host and status class.
 */
export function repairMessage(result: RepairSuggestion): HeaderMessage | null {
  if (result.status === 'skipped' || (result.status === 'ok' && result.groups.length)) return null
  // An ok answer without any wording is an invalid return, like any other unusable one.
  const status: DegradedStatus = result.status === 'ok' ? 'invalid' : result.status
  if (status === 'timeout') return { key: 'smartSearch.enhance.repairTimeout', params: {} }
  if (status === 'invalid') return { key: 'smartSearch.enhance.repairInvalid', params: { host: result.endpointHost ?? '' } }
  return headerMessage({ kind: 'degraded', status, host: result.endpointHost, statusClass: result.statusClass, missing: result.missing })
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

/** Built field by field (the host rejects unknown fields); for the evidence answer request. */
export function chatAnswerConfig(settings: SmartLookupSettings): ChatAnswerConfig {
  const chat = settings.enhance.chat
  return { url: chat.url, model: chat.model, consentHost: chat.consentHost }
}

/**
 * Zero local hits, enhancement on, the repair model's url and model both
 * non-empty, its key stored, and the user allowed its host (`chat.consentHost`,
 * the same consent as the answer). The rephrase sends the question to that
 * host, so it never runs without that host's consent (rephrase-consent ruling).
 */
export function shouldAutoRepair(hits: number, settings: SmartLookupSettings, keys: KeyStatus): boolean {
  const { enabled, chat } = settings.enhance
  const host = endpointHost(chat.url, 'chat')
  return hits === 0 && enabled && chat.url.trim() !== '' && chat.model.trim() !== '' && keys.chat
    && host !== null && host === chat.consentHost
}

export type AttemptKind = 'original' | 'rephrased' | 'scan'
/** One automatic try on zero or unjudged hits; `null` = not run. */
export interface LookupAttempt { kind: AttemptKind; hits: number | null; tookMs: number | null }
