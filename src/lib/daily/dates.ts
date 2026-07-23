// 纯日期算术。日期字符串统一 'yyyy-MM-dd'（本地时区语义由调用方保证）。
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/

export function addDays(date: string, delta: number): string {
  const m = date.match(DAY_RE)
  if (!m) throw new Error(`bad date: ${date}`)
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  d.setDate(d.getDate() + delta)
  const y = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${y}-${mm}-${dd}`
}

/** 从 anchor 起、含 anchor 的降序连续 count 天（新→旧）。 */
export function dateRange(anchor: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => addDays(anchor, -i))
}

/** 在当前(降序)列表尾部之后再取 count 个更早的日期。 */
export function extendEarlier(current: string[], count: number): string[] {
  const tail = current[current.length - 1]
  return Array.from({ length: count }, (_, i) => addDays(tail, -(i + 1)))
}

/** 在当前(降序)列表头部之前再取 count 个更新的日期(近→远靠近 head)。 */
export function extendLater(current: string[], count: number): string[] {
  const head = current[0]
  return Array.from({ length: count }, (_, i) => addDays(head, count - i))
}
