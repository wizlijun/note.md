export type LookupGroupBy = 'auto' | 'source' | 'date'

export interface SmartLookupSettings {
  results: {
    limit: 20 | 50 | 100
    groupBy: LookupGroupBy
    autoDeepOnZero: boolean
    deepTimeoutMs: number
  }
}

export const DEFAULT_SMART_LOOKUP_SETTINGS: SmartLookupSettings = {
  results: {
    limit: 50,
    groupBy: 'auto',
    autoDeepOnZero: false,
    deepTimeoutMs: 4_000,
  },
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

function choice<T extends string | number>(value: unknown, values: readonly T[], fallback: T): T {
  return values.includes(value as T) ? value as T : fallback
}

/** Legacy `planner`, `summary` and `handoff` keys are ignored. Invalid fields fall back independently; one damaged value never resets the group. */
export function normalizeSmartLookupSettings(value: unknown): SmartLookupSettings {
  const root = object(value)
  const results = object(root.results)
  const defaults = DEFAULT_SMART_LOOKUP_SETTINGS

  return {
    results: {
      limit: choice(results.limit, [20, 50, 100] as const, defaults.results.limit),
      groupBy: choice(results.groupBy, ['auto', 'source', 'date'] as const, defaults.results.groupBy),
      autoDeepOnZero: bool(results.autoDeepOnZero, defaults.results.autoDeepOnZero),
      deepTimeoutMs: boundedInteger(results.deepTimeoutMs, 1_000, 5_000, defaults.results.deepTimeoutMs),
    },
  }
}
