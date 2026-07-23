// Instant-repaint cache: raw directory filenames, namespaced by (kind, vault
// root). buildIndex()/buildDayIndex() reconstruct indices from these on load.
// kinds: 'weekly-review', 'diary', 'dailynote:<year>'.

const PREFIX = 'weekly-review:cache:'

function keyFor(vaultRoot: string, kind: string): string {
  return `${PREFIX}${kind}:${vaultRoot}`
}

export function loadCache(vaultRoot: string, kind: string): string[] | null {
  try {
    const raw = localStorage.getItem(keyFor(vaultRoot, kind))
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === 'string')) return null
    return parsed as string[]
  } catch {
    return null
  }
}

export function saveCache(vaultRoot: string, kind: string, entries: string[]): void {
  try {
    localStorage.setItem(keyFor(vaultRoot, kind), JSON.stringify(entries))
  } catch {
    /* best-effort */
  }
}
