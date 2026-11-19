export interface HomeAppsData {
  version: 1
  pins: (string | null)[]
  usage: Record<string, { days: Record<string, number>; lastUsed: number }>
  snapshot: { day: string; ids: string[] }
}

const SLOT_COUNT = 8
const DAY_MS = 86_400_000

export function emptyHomeAppsData(): HomeAppsData {
  return { version: 1, pins: Array(SLOT_COUNT).fill(null), usage: {}, snapshot: { day: '', ids: [] } }
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function dayNumber(day: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return NaN
  const time = Date.parse(`${day}T00:00:00Z`)
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === day ? time / DAY_MS : NaN
}

function localDay(now: number): string {
  if (!Number.isFinite(now)) throw new RangeError('Invalid usage time')
  const date = new Date(now)
  if (!Number.isFinite(date.getTime())) throw new RangeError('Invalid usage time')
  return `${date.getFullYear().toString().padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** Recover valid fields without shifting pins or writing over unreadable files. */
export function normalizeHomeAppsData(value: unknown): HomeAppsData {
  const result = emptyHomeAppsData()
  const raw = object(value)
  if (!raw || raw.version !== 1) return result
  const seen = new Set<string>()
  const pins = raw.pins
  if (Array.isArray(pins)) {
    result.pins = result.pins.map((_, slot) => {
      const id = pins[slot]
      if (!isId(id) || seen.has(id)) return null
      seen.add(id)
      return id
    })
  }
  result.usage = Object.fromEntries(Object.entries(object(raw.usage) ?? {}).flatMap(([id, value]) => {
    const usage = object(value)
    if (!isId(id) || !usage || typeof usage.lastUsed !== 'number' || !Number.isFinite(usage.lastUsed) || usage.lastUsed < 0) return []
    const days = Object.entries(object(usage.days) ?? {})
      .filter(([day, count]) => Number.isFinite(dayNumber(day)) && typeof count === 'number' && Number.isSafeInteger(count) && count > 0)
      .sort(([a], [b]) => b.localeCompare(a)).slice(0, 30)
    if (!days.length) return []
    return [[id, { days: Object.fromEntries(days) as Record<string, number>, lastUsed: usage.lastUsed }]]
  }))
  const snapshot = object(raw.snapshot)
  if (snapshot && typeof snapshot.day === 'string' && Number.isFinite(dayNumber(snapshot.day))) {
    result.snapshot = { day: snapshot.day, ids: Array.isArray(snapshot.ids) ? [...new Set(snapshot.ids.filter(isId))] : [] }
  }
  return result
}

function checkId(id: string): void {
  if (!isId(id)) throw new Error('App identity is required')
}

function checkSlot(slot: number): void {
  if (!Number.isInteger(slot) || slot < 0 || slot >= SLOT_COUNT) throw new RangeError('Shortcut slot must be between 0 and 7')
}

export function pinApp(data: HomeAppsData, id: string, slot: number): HomeAppsData {
  checkId(id)
  checkSlot(slot)
  if (data.pins[slot] === id) return data
  if (data.pins.includes(id)) throw new Error('App is already pinned; use movePin')
  if (data.pins[slot] !== null) throw new Error('Shortcut slot is already pinned')
  const pins = [...data.pins]
  pins[slot] = id
  return { ...data, pins }
}

export function unpinApp(data: HomeAppsData, id: string): HomeAppsData {
  checkId(id)
  if (!data.pins.includes(id)) return data
  return { ...data, pins: data.pins.map((pin) => pin === id ? null : pin) }
}

/** Auto moves require the UI's actual source slot after eligibility filtering. */
export function movePin(data: HomeAppsData, id: string, slot: number, sourceSlot?: number): HomeAppsData {
  checkId(id)
  checkSlot(slot)
  let source = data.pins.indexOf(id)
  if (source === -1) {
    if (sourceSlot === undefined) throw new Error('Auto app move requires its visible source slot')
    checkSlot(sourceSlot)
    if (data.pins[sourceSlot] !== null || !data.snapshot.ids.includes(id)) throw new Error('Invalid auto app source')
    source = sourceSlot
  }
  if (source === slot && data.pins[slot] === id) return data
  const pins = [...data.pins]
  pins[source] = pins[slot]
  pins[slot] = id
  return { ...data, pins }
}

/** Call only after successfully reading the complete installed list. */
export function reconcileInstalled(data: HomeAppsData, installedIds: readonly string[]): HomeAppsData {
  const installed = new Set(installedIds)
  return {
    ...data,
    pins: data.pins.map((id) => id !== null && installed.has(id) ? id : null),
    usage: Object.fromEntries(Object.entries(data.usage).filter(([id]) => installed.has(id))),
    snapshot: { ...data.snapshot, ids: data.snapshot.ids.filter((id) => installed.has(id)) },
  }
}

function recentUsage(data: HomeAppsData, today: string): HomeAppsData['usage'] {
  const current = dayNumber(today)
  return Object.fromEntries(Object.entries(data.usage).flatMap(([id, usage]) => {
    const days = Object.entries(usage.days).filter(([day]) => {
      const age = current - dayNumber(day)
      return age >= 0 && age < 30
    })
    return days.length ? [[id, { ...usage, days: Object.fromEntries(days) }]] : []
  }))
}

export function recordUsage(data: HomeAppsData, id: string, now: number): HomeAppsData {
  checkId(id)
  const today = localDay(now)
  const previous = Object.hasOwn(data.usage, id) ? data.usage[id] : undefined
  if (previous && now - previous.lastUsed < 30_000) return data
  const usage = recentUsage(data, today)
  const days = Object.hasOwn(usage, id) ? usage[id].days : {}
  return {
    ...data,
    usage: { ...usage, [id]: { days: { ...days, [today]: (days[today] ?? 0) + 1 }, lastUsed: now } },
  }
}

export function refreshRanking(data: HomeAppsData, eligibleIds: readonly string[], now: number): HomeAppsData {
  const today = localDay(now)
  if (data.snapshot.day === today) return data
  const current = dayNumber(today)
  const usage = recentUsage(data, today)
  const previousOrder = new Map(data.snapshot.ids.map((id, index) => [id, index]))
  const score = (id: string) => Object.entries(usage[id]?.days ?? {}).reduce((sum, [day, count]) => sum + count * (current - dayNumber(day) < 7 ? 2 : 1), 0)
  const ids = [...new Set(eligibleIds)].filter((id) => score(id) > 0)
  ids.sort((a, b) => score(b) - score(a)
    || (previousOrder.get(a) ?? Infinity) - (previousOrder.get(b) ?? Infinity)
    || usage[b].lastUsed - usage[a].lastUsed
    || (a < b ? -1 : a > b ? 1 : 0))
  return { ...data, usage, snapshot: { day: today, ids } }
}

/** Always returns all eight logical slots; renderers may trim trailing empties. */
export function shortcutSlots(data: HomeAppsData, eligibleIds: readonly string[]): (string | null)[] {
  const eligible = new Set(eligibleIds)
  const used = new Set(data.pins.filter(isId))
  const recommendations = data.snapshot.ids.filter((id) => {
    if (!eligible.has(id) || used.has(id)) return false
    used.add(id)
    return true
  })
  let index = 0
  return data.pins.map((id) => id ?? recommendations[index++] ?? null)
}
