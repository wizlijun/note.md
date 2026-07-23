// ISO-8601 week math (Monday-start weeks). Pure functions — unit-tested.

/** ISO week number (1..53) for a local date. */
export function isoWeek(d: Date): number {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const day = (t.getUTCDay() + 6) % 7 // Mon=0..Sun=6
  t.setUTCDate(t.getUTCDate() - day + 3) // to Thursday of this week
  const firstTh = new Date(Date.UTC(t.getUTCFullYear(), 0, 4))
  const fday = (firstTh.getUTCDay() + 6) % 7
  firstTh.setUTCDate(firstTh.getUTCDate() - fday + 3)
  return 1 + Math.round((t.getTime() - firstTh.getTime()) / (7 * 864e5))
}

/** ISO week-numbering year (differs from calendar year on the 1–3 boundary days). */
export function isoWeekYear(d: Date): number {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const day = (t.getUTCDay() + 6) % 7
  t.setUTCDate(t.getUTCDate() - day + 3)
  return t.getUTCFullYear()
}

/** Monday 00:00 (local) of the week containing `d`. */
export function mondayOf(d: Date): Date {
  const x = new Date(d)
  const day = (x.getDay() + 6) % 7
  x.setDate(x.getDate() - day)
  x.setHours(0, 0, 0, 0)
  return x
}

/** 52 or 53 — the number of ISO weeks in a week-numbering year. */
export function weeksInYear(year: number): number {
  return isoWeek(new Date(year, 11, 28))
}

export interface MonthWeek {
  weekYear: number // ISO week-numbering year
  week: number // ISO week number 1..53
  monday: Date // local Monday 00:00 of this row's week
  days: (number | null)[] // length 7, Mon..Sun; day-of-month, or null if outside `month0`
}

/** Build the week rows for a calendar month (0-based `month0`), Monday-first.
 *  Each row is one ISO week; days outside the month are null. */
export function buildMonthRows(year: number, month0: number): MonthWeek[] {
  const last = new Date(year, month0 + 1, 0).getDate()
  const byMonday = new Map<number, MonthWeek>()
  const order: MonthWeek[] = []
  for (let dnum = 1; dnum <= last; dnum++) {
    const d = new Date(year, month0, dnum)
    const mon = mondayOf(d)
    const key = mon.getTime()
    let row = byMonday.get(key)
    if (!row) {
      row = { weekYear: isoWeekYear(d), week: isoWeek(d), monday: mon, days: [null, null, null, null, null, null, null] }
      byMonday.set(key, row)
      order.push(row)
    }
    const col = (d.getDay() + 6) % 7
    row.days[col] = dnum
  }
  return order
}
