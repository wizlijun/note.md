import { bridge } from './bridge'

export const DEFAULT_MAX_CONCURRENCY = 3
export const CONCURRENCY_OPTIONS = [1, 2, 3, 4, 5] as const
export const USAGE_DISPLAY_OPTIONS = ['tip', 'result'] as const
export type UsageDisplay = (typeof USAGE_DISPLAY_OPTIONS)[number]

export function normalizeMaxConcurrency(value: unknown): number {
  const parsed = typeof value === 'number' ? value
    : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) return DEFAULT_MAX_CONCURRENCY
  return Math.max(1, Math.min(5, parsed))
}

export async function loadMaxConcurrency(): Promise<number> {
  const result = await bridge().request('host.settings.get')
  // Persist only an absent key so older hosts also use the new default.
  if (!Object.prototype.hasOwnProperty.call(result?.settings ?? {}, 'maxConcurrency')) {
    return saveMaxConcurrency(DEFAULT_MAX_CONCURRENCY)
  }
  return normalizeMaxConcurrency(result.settings.maxConcurrency)
}

export async function saveMaxConcurrency(value: unknown): Promise<number> {
  const normalized = normalizeMaxConcurrency(value)
  await bridge().request('host.settings.set', {
    key: 'maxConcurrency',
    value: String(normalized),
  })
  return normalized
}

export function normalizeUsageDisplay(value: unknown): UsageDisplay {
  return value === 'result' ? 'result' : 'tip'
}

export async function loadUsageDisplay(): Promise<UsageDisplay> {
  const result = await bridge().request('host.settings.get')
  return normalizeUsageDisplay(result?.settings?.usageDisplay)
}

export async function saveUsageDisplay(value: unknown): Promise<UsageDisplay> {
  const normalized = normalizeUsageDisplay(value)
  await bridge().request('host.settings.set', { key: 'usageDisplay', value: normalized })
  return normalized
}
