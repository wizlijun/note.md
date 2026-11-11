export type LookupGroupBy = 'auto' | 'source' | 'date'
export type JevPreset = 'official' | 'openrouter' | 'custom'
export type JevAuthMode = 'bearer' | 'none'

export interface SmartLookupSettings {
  results: {
    limit: 20 | 50 | 100
    groupBy: LookupGroupBy
    autoDeepOnZero: boolean
    /**
     * The answer-first default (`autoDeepOnZero: true`) was applied to the
     * stored settings once (final review I6). Before this marker every save
     * wrote the old default `false` explicitly, so a stored `false` without
     * it is not a choice and becomes `true`; with it, the stored value stands.
     */
    autoDeepMigrated: boolean
    deepTimeoutMs: number
  }
  enhance: {
    enabled: boolean
    jev: { preset: JevPreset; url: string; model: string; authMode: JevAuthMode; consentHost: string }
    chat: { url: string; model: string; consentHost: string }
  }
  launch: { firstRunSeen: boolean }
}

/** Preset services fill only the URL; the model stays whatever the user typed (ledger: models empty in presets). */
export const JEV_PRESET_URLS: Record<Exclude<JevPreset, 'custom'>, string> = {
  official: 'https://api.typesafe.ai/v1',
  openrouter: 'https://openrouter.ai/api/alpha/decisions',
}

export const URL_MAX_LENGTH = 2_048
export const MODEL_MAX_LENGTH = 256
export const CONSENT_HOST_MAX_LENGTH = 255

export const DEFAULT_SMART_LOOKUP_SETTINGS: SmartLookupSettings = {
  results: {
    limit: 50,
    groupBy: 'auto',
    autoDeepOnZero: true,
    autoDeepMigrated: true,
    deepTimeoutMs: 4_000,
  },
  enhance: {
    enabled: true,
    jev: { preset: 'custom', url: '', model: '', authMode: 'bearer', consentHost: '' },
    chat: { url: '', model: '', consentHost: '' },
  },
  launch: { firstRunSeen: false },
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function boundedInteger(value: unknown, min: number, max: number, fallback: number): number {
  return Number.isInteger(value) && Number(value) >= min && Number(value) <= max
    ? Number(value)
    : fallback
}

// C0 and C1 control characters, DEL included.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/

function text(value: unknown, maxLength: number, fallback: string): string {
  return typeof value === 'string' && value.length <= maxLength && !CONTROL_CHARACTERS.test(value)
    ? value
    : fallback
}

function choice<T extends string | number>(value: unknown, values: readonly T[], fallback: T): T {
  return values.includes(value as T) ? value as T : fallback
}

/** Legacy `planner`, `summary` and `handoff` keys are ignored. Invalid fields fall back independently; one damaged value never resets the group. */
export function normalizeSmartLookupSettings(value: unknown): SmartLookupSettings {
  const root = object(value)
  const results = object(root.results)
  const enhance = object(root.enhance)
  const jev = object(enhance.jev)
  const chat = object(enhance.chat)
  const launch = object(root.launch)
  const defaults = DEFAULT_SMART_LOOKUP_SETTINGS

  return {
    results: {
      limit: choice(results.limit, [20, 50, 100] as const, defaults.results.limit),
      groupBy: choice(results.groupBy, ['auto', 'source', 'date'] as const, defaults.results.groupBy),
      // One-time migration (I6): settings saved before the marker turn the scan on.
      autoDeepOnZero: results.autoDeepMigrated === true
        ? bool(results.autoDeepOnZero, defaults.results.autoDeepOnZero)
        : defaults.results.autoDeepOnZero,
      autoDeepMigrated: true,
      deepTimeoutMs: boundedInteger(results.deepTimeoutMs, 1_000, 5_000, defaults.results.deepTimeoutMs),
    },
    enhance: {
      enabled: bool(enhance.enabled, defaults.enhance.enabled),
      jev: {
        preset: choice(jev.preset, ['official', 'openrouter', 'custom'] as const, defaults.enhance.jev.preset),
        url: text(jev.url, URL_MAX_LENGTH, defaults.enhance.jev.url),
        model: text(jev.model, MODEL_MAX_LENGTH, defaults.enhance.jev.model),
        authMode: choice(jev.authMode, ['bearer', 'none'] as const, defaults.enhance.jev.authMode),
        consentHost: text(jev.consentHost, CONSENT_HOST_MAX_LENGTH, defaults.enhance.jev.consentHost),
      },
      chat: {
        url: text(chat.url, URL_MAX_LENGTH, defaults.enhance.chat.url),
        model: text(chat.model, MODEL_MAX_LENGTH, defaults.enhance.chat.model),
        consentHost: text(chat.consentHost, CONSENT_HOST_MAX_LENGTH, defaults.enhance.chat.consentHost),
      },
    },
    launch: {
      firstRunSeen: bool(launch.firstRunSeen, defaults.launch.firstRunSeen),
    },
  }
}

function parseHttpUrl(url: string): URL | null {
  let parsed: URL
  try { parsed = new URL(url.trim()) } catch { return null }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  return parsed.host ? parsed : null
}

/**
 * The host the consent is bound to — the same rule as the host's
 * `endpoint_host` (smart_model.rs): lower-cased, an explicit non-default port
 * kept (`host:port`), IPv6 in brackets. Uses `URL.host`, not `hostname`, so the
 * port survives. `null` when the URL does not parse as http(s) with a host.
 *
 * `kind` mirrors the host's two call sites: `'jev'` resolves the endpoint path
 * first (`jev_endpoint`), `'chat'` does not; the host never depends on the
 * path, so both give the same answer.
 */
export function endpointHost(url: string, _kind: 'jev' | 'chat' = 'jev'): string | null {
  return parseHttpUrl(url)?.host.toLowerCase() ?? null
}

/**
 * A bearer key over plain `http` to a host that is not loopback (`localhost`,
 * `127.0.0.0/8`, `::1`) — the host's `sends_key_in_clear_text`, which refuses
 * such a configuration.
 */
export function sendsKeyInClearText(url: string, authMode: JevAuthMode): boolean {
  if (authMode !== 'bearer') return false
  const parsed = parseHttpUrl(url)
  if (!parsed || parsed.protocol !== 'http:') return false
  const host = parsed.hostname.toLowerCase()
  const loopback = host === 'localhost' || host === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(host)
  return !loopback
}

/**
 * Event the lookup window emits to `main` to open Settings on a tab
 * (`emitTo('main', OPEN_SETTINGS_TAB_EVENT, { tab: 'enhance' })`); `App.svelte`
 * listens for it.
 */
export const OPEN_SETTINGS_TAB_EVENT = 'settings://open-tab'
const OPENABLE_SETTINGS_TABS = ['enhance', 'search'] as const
export type OpenableSettingsTab = typeof OPENABLE_SETTINGS_TABS[number]

/** The tab an `OPEN_SETTINGS_TAB_EVENT` payload names, or `null` for anything else. */
export function settingsTabFromEvent(payload: unknown): OpenableSettingsTab | null {
  const tab = object(payload).tab
  return OPENABLE_SETTINGS_TABS.includes(tab as OpenableSettingsTab) ? tab as OpenableSettingsTab : null
}
