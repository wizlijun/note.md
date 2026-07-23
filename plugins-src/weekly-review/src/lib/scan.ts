// Parse vault/weekly-review filenames into a year→week→path index.

export const WEEKLY_DIR = 'weekly-review'

const NAME_RE = /^(\d{4})-W(\d{1,2})-weekly-review\.md$/

/** Parse `YYYY-Www-weekly-review.md` → { year, week } (or null). Week may be unpadded. */
export function parseReviewName(name: string): { year: number; week: number } | null {
  const m = NAME_RE.exec(name)
  if (!m) return null
  const year = Number(m[1])
  const week = Number(m[2])
  if (week < 1 || week > 53) return null
  return { year, week }
}

export interface ReviewIndex {
  /** year → (ISO week number → vault-relative path of the review file) */
  byYear: Map<number, Map<number, string>>
  /** sorted ascending; only years that have at least one review file */
  years: number[]
}

/** Build the index from a `host.vault.list` entries array. */
export function buildIndex(entries: { name: string; is_dir: boolean }[]): ReviewIndex {
  const byYear = new Map<number, Map<number, string>>()
  for (const e of entries) {
    if (e.is_dir) continue
    const parsed = parseReviewName(e.name)
    if (!parsed) continue
    let weeks = byYear.get(parsed.year)
    if (!weeks) {
      weeks = new Map()
      byYear.set(parsed.year, weeks)
    }
    weeks.set(parsed.week, `${WEEKLY_DIR}/${e.name}`)
  }
  const years = [...byYear.keys()].sort((a, b) => a - b)
  return { byYear, years }
}
