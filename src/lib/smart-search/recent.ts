// Recent Smart Lookup questions: a per-device convenience kept in
// localStorage. Every access is guarded; failure means an empty list.

const KEY = 'notemd.smartLookup.recent'
const MAX_ENTRIES = 20
const MAX_LENGTH = 500

function clean(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const question = value.trim().slice(0, MAX_LENGTH)
  return question === '' ? null : question
}

function normalize(values: unknown[]): string[] {
  const seen = new Set<string>()
  const list: string[] = []
  for (const value of values) {
    const question = clean(value)
    if (question === null || seen.has(question)) continue
    seen.add(question)
    list.push(question)
    if (list.length === MAX_ENTRIES) break
  }
  return list
}

/** Newest first; `[]` when nothing is stored, the value is damaged or storage is unavailable. */
export function loadRecent(): string[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw === null) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? normalize(parsed) : []
  } catch {
    return []
  }
}

/** Puts the trimmed question first (deduplicated, at most 20 kept) and returns the new list; `[]` on failure. */
export function rememberRecent(question: string): string[] {
  try {
    const list = normalize([question, ...loadRecent()])
    localStorage.setItem(KEY, JSON.stringify(list))
    return list
  } catch {
    return []
  }
}

export function clearRecent(): void {
  try {
    localStorage.removeItem(KEY)
    localStorage.removeItem(COUNTS_KEY)
  } catch {
    // Nothing to clear when storage is unavailable.
  }
}

// Result counts shown next to recent questions, in their own key so the
// question list keeps its format. Only counts for listed questions are kept.

const COUNTS_KEY = 'notemd.smartLookup.recentCounts'

/** Count per recent question; entries for questions no longer listed, or damaged values, are dropped. */
export function loadRecentCounts(): Record<string, number> {
  try {
    const raw = localStorage.getItem(COUNTS_KEY)
    if (raw === null) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const listed = new Set(loadRecent())
    const counts: Record<string, number> = {}
    for (const [question, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (listed.has(question) && Number.isInteger(value) && Number(value) >= 0) counts[question] = Number(value)
    }
    return counts
  } catch {
    return {}
  }
}

/** Records how many results the last lookup of a listed question found; returns the counts, `{}` on failure. */
export function rememberRecentCount(question: string, count: number): Record<string, number> {
  try {
    const key = clean(question)
    const counts = loadRecentCounts()
    if (key === null || !loadRecent().includes(key) || !Number.isInteger(count) || count < 0) return counts
    counts[key] = count
    localStorage.setItem(COUNTS_KEY, JSON.stringify(counts))
    return counts
  } catch {
    return {}
  }
}
