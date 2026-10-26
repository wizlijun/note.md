export type PauseTimeResult =
  | { ok: true; iso: string }
  | { ok: false; reason: 'invalid' | 'past' | 'ambiguous' | 'nonexistent' }

export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

function formatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  })
}

function partsAt(time: number, format: Intl.DateTimeFormat): number[] {
  const parts = Object.fromEntries(format.formatToParts(new Date(time)).map(({ type, value }) => [type, value]))
  return ['year', 'month', 'day', 'hour', 'minute', 'second'].map((key) => Number(parts[key]))
}

function wallTime(parts: number[]): number {
  const date = new Date(0)
  date.setUTCFullYear(parts[0], parts[1] - 1, parts[2])
  date.setUTCHours(parts[3], parts[4], parts[5] ?? 0, 0)
  return date.getTime()
}

function localValue(parts: number[]): string {
  const [year, month, day, hour, minute] = parts.map((part) => String(part).padStart(2, '0'))
  return `${year.padStart(4, '0')}-${month}-${day}T${hour}:${minute}`
}

export function localDateTimeValue(iso: string, timeZone = localTimeZone()): string {
  const time = Date.parse(iso)
  return Number.isFinite(time) ? localValue(partsAt(time, formatter(timeZone))) : ''
}

/** Resolve a wall-clock minute without silently choosing a DST occurrence or normalizing a gap. */
export function resolvePauseTime(value: string, now = new Date(), timeZone = localTimeZone()): PauseTimeResult {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value)
  if (!match) return { ok: false, reason: 'invalid' }
  const parts = match.slice(1).map(Number)
  const wall = wallTime(parts)
  const calendar = new Date(wall)
  if (parts[0] < 1 || calendar.getUTCFullYear() !== parts[0] || calendar.getUTCMonth() + 1 !== parts[1]
    || calendar.getUTCDate() !== parts[2] || calendar.getUTCHours() !== parts[3] || calendar.getUTCMinutes() !== parts[4]) {
    return { ok: false, reason: 'invalid' }
  }
  const format = formatter(timeZone)
  const offsets = new Set<number>()
  // Collect offsets on both sides of a timezone transition, including half-hour changes and skipped dates.
  for (let hours = -48; hours <= 48; hours += 6) {
    const sample = wall + hours * 3_600_000
    offsets.add(wallTime(partsAt(sample, format)) - sample)
  }
  const candidates = [...offsets].map((offset) => wall - offset)
    .filter((time) => localValue(partsAt(time, format)) === value)
  if (!candidates.length) return { ok: false, reason: 'nonexistent' }
  if (candidates.length > 1) return { ok: false, reason: 'ambiguous' }
  if (candidates[0] <= now.getTime()) return { ok: false, reason: 'past' }
  return { ok: true, iso: new Date(candidates[0]).toISOString().replace(/\.\d{3}Z$/, 'Z') }
}

export function tomorrowAtNine(now = new Date(), timeZone = localTimeZone()): PauseTimeResult {
  const parts = partsAt(now.getTime(), formatter(timeZone))
  const tomorrow = new Date(wallTime([parts[0], parts[1], parts[2] + 1, 9, 0]))
  return resolvePauseTime(tomorrow.toISOString().slice(0, 16), now, timeZone)
}
