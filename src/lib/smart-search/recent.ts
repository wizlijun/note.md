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
  } catch {
    // Nothing to clear when storage is unavailable.
  }
}
