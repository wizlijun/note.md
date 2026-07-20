import { sumCounters, type AttentionSession, type DayCounters, type DeviceAnalytics, type DocDays } from './model'

/** Merge every device's analytics into one docKey → day → summed counters map. */
export function mergeDeviceAnalytics(devices: DeviceAnalytics[]): DocDays {
  const out: DocDays = {}
  for (const dev of devices) {
    for (const [docKey, days] of Object.entries(dev.docs)) {
      const target = (out[docKey] ??= {})
      for (const [day, counters] of Object.entries(days)) {
        target[day] = target[day] ? sumCounters(target[day], counters) : counters
      }
    }
  }
  return out
}

/**
 * Sum each doc's counters over the inclusive [fromDay, toDay] range (day keys
 * are 'YYYY-MM-DD', which sort lexicographically in calendar order). Docs with
 * no in-range activity are omitted.
 */
export function aggregateRange(
  merged: DocDays,
  fromDay: string,
  toDay: string,
): Record<string, DayCounters> {
  const out: Record<string, DayCounters> = {}
  for (const [docKey, days] of Object.entries(merged)) {
    let acc: DayCounters | null = null
    for (const [day, counters] of Object.entries(days)) {
      if (day < fromDay || day > toDay) continue
      acc = acc ? sumCounters(acc, counters) : counters
    }
    if (acc) out[docKey] = acc
  }
  return out
}

/**
 * Collect every device's attention intervals for each doc within the inclusive
 * [fromDay, toDay] range into one docKey → sessions array, sorted by start.
 * Intervals are filed under their start day (see store), so range filtering by
 * day key is correct. Docs with no in-range intervals are omitted.
 */
export function collectSessionsRange(
  devices: DeviceAnalytics[],
  fromDay: string,
  toDay: string,
): Record<string, AttentionSession[]> {
  const out: Record<string, AttentionSession[]> = {}
  for (const dev of devices) {
    for (const [docKey, days] of Object.entries(dev.sessions ?? {})) {
      for (const [day, list] of Object.entries(days)) {
        if (day < fromDay || day > toDay) continue
        ;(out[docKey] ??= []).push(...list)
      }
    }
  }
  for (const list of Object.values(out)) list.sort((a, b) => a.start - b.start)
  return out
}
