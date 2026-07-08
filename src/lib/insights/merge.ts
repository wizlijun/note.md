import { sumCounters, type DayCounters, type DeviceAnalytics, type DocDays } from './model'

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
