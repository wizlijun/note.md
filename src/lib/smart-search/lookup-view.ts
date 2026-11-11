// Pure view helpers for the Smart Lookup window (`src/SmartLookupApp.svelte`).
// Kept out of the component so the choices they encode stay unit-tested.
import type { SearchHit } from '../search/api'
import { groupHits, type HitGroup } from '../search/grouping'

export interface ResultSection<T extends SearchHit = SearchHit> {
  key: string
  label: string
  hits: T[]
}

/** Month sections (`YYYY-MM`), newest first; hits without a date come last. */
export function dateSections<T extends SearchHit>(hits: T[], unknownLabel: string): ResultSection<T>[] {
  const months = new Map<string, T[]>()
  const undated: T[] = []
  for (const hit of hits) {
    const month = /^\d{4}-\d{2}/.exec(hit.docDate ?? '')?.[0]
    if (!month) { undated.push(hit); continue }
    const bucket = months.get(month)
    if (bucket) bucket.push(hit)
    else months.set(month, [hit])
  }
  const sections: ResultSection<T>[] = [...months.entries()]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([month, members]) => ({ key: `date:${month}`, label: month, hits: members }))
  if (undated.length) sections.push({ key: 'date:unknown', label: unknownLabel, hits: undated })
  return sections
}

/** The shared origin grouping (`groupHits`), flattened to one list per group. */
export function sourceSections(
  hits: SearchHit[],
  label: (group: HitGroup) => string,
): ResultSection[] {
  return groupHits(hits).map((group) => ({
    key: group.kind === 'derivedType' ? `derived:${group.conceptType}` : group.kind,
    label: label(group),
    hits: group.files.flatMap((file) => file.hits),
  }))
}

export function hitReference(hit: Pick<SearchHit, 'path' | 'line'>): string {
  return `${hit.path}:${hit.line}`
}

/** A short, display-safe error: no local paths, tokens or keys. */
export function redactError(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error))
    .replace(/\b(?:sk|key)-[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(api[_-]?key|token|password)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .replace(/(^|[\s("'`])\/(?:[^/\s"'`]+\/)+[^/\s"'`,;:)]+/g, '$1[local path]')
    .replace(/\b[A-Za-z]:\\[^\s"'`,;]+/g, '[local path]')
    .replace(/\s+/g, ' ')
    .trim()
  return Array.from(message).slice(0, 180).join('')
}

/**
 * The heading path shown after a source's title, levels joined by ` › `. The
 * index joins levels with ` > `; a leading level that only repeats the title
 * is dropped (「决策日志 › 决策日志 › 6.1110…」 reads 「决策日志 › 6.1110…」).
 */
export function crumbAfterTitle(title: string, breadcrumb: string): string {
  const levels = breadcrumb.split(/\s*[>›]\s*/).map((level) => level.trim()).filter(Boolean)
  if (levels.length && levels[0] === title.trim()) levels.shift()
  return levels.join(' › ')
}
