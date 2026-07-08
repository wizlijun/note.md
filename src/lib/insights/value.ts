import { dayKey } from './model'

export interface ValueInputs {
  read_ms: number
  edit_ms: number
  edit_sessions: number
  mark_ops: number
  aud_read_ms: number
  unique_readers: number
}

export interface ValueWeights {
  read: number; edit: number; sessions: number; marks: number; audRead: number; readers: number
}

/** Reasonable defaults; edits + unique readers weigh above raw reading. Tunable later. */
export const DEFAULT_WEIGHTS: ValueWeights = {
  read: 1, edit: 1.5, sessions: 0.5, marks: 0.3, audRead: 1, readers: 2,
}

const log1p = (x: number) => Math.log1p(Math.max(0, x))
const min = (ms: number) => ms / 60_000

/** Transparent, log-damped composite so no single dimension dominates. */
export function valueScore(i: ValueInputs, w: ValueWeights): number {
  return (
    w.read * log1p(min(i.read_ms)) +
    w.edit * log1p(min(i.edit_ms)) +
    w.sessions * i.edit_sessions +
    w.marks * i.mark_ops +
    w.audRead * log1p(min(i.aud_read_ms)) +
    w.readers * log1p(i.unique_readers)
  )
}

export type Preset = 'today' | 'yesterday' | '7d' | '30d' | 'month'

function addDays(day: string, delta: number): string {
  const ms = Date.parse(day + 'T00:00:00Z') + delta * 86_400_000
  return new Date(ms).toISOString().slice(0, 10)
}

/** Resolve a preset to an inclusive [from, to] day-key range in the device's tz. */
export function presetRange(preset: Preset, now: number, tzOffsetMinutes: number): { from: string; to: string } {
  const today = dayKey(now, tzOffsetMinutes)
  switch (preset) {
    case 'today': return { from: today, to: today }
    case 'yesterday': { const y = addDays(today, -1); return { from: y, to: y } }
    case '7d': return { from: addDays(today, -6), to: today }
    case '30d': return { from: addDays(today, -29), to: today }
    case 'month': return { from: today.slice(0, 8) + '01', to: today }
  }
}
