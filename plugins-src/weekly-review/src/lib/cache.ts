// Instant-repaint cache: the raw weekly-review directory filenames, keyed by
// vault root. buildIndex() reconstructs the ReviewIndex from these on load.

const PREFIX = 'weekly-review:cache:'

export function loadCache(vaultRoot: string): string[] | null {
  try {
    const raw = localStorage.getItem(PREFIX + vaultRoot)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === 'string')) return null
    return parsed as string[]
  } catch {
    return null
  }
}

export function saveCache(vaultRoot: string, entries: string[]): void {
  try {
    localStorage.setItem(PREFIX + vaultRoot, JSON.stringify(entries))
  } catch {
    /* best-effort */
  }
}
