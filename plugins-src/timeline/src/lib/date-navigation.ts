export function shiftTimelineDate(value: string, days: number): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const date = new Date(`${value}T00:00:00Z`)
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) return null
  date.setUTCDate(date.getUTCDate() + days)
  if (date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) return null
  return date.toISOString().slice(0, 10)
}

/** Keep flat directories flat; move an existing year archive across years. */
export function timelineDateTarget(uri: string, date: string): string | null {
  if (shiftTimelineDate(date, 0) !== date) return null
  const parts = uri.replace(/\\/g, '/').split('/')
  const current = parts.at(-1)?.match(/^(\d{4})-\d{2}-\d{2}(\.timeline\.md)$/i)
  if (!current) return null
  const filename = `${date}${current[2]}`
  return parts.at(-2) === current[1] ? `../${date.slice(0, 4)}/${filename}` : filename
}
