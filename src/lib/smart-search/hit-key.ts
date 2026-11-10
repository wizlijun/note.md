import type { SearchHit } from '../search/api'

/** Stable list identity for one hit within a single result set. */
export function hitKey(hit: Pick<SearchHit, 'path' | 'line' | 'lineEnd'>): string {
  return `${hit.path}\0${hit.line}\0${hit.lineEnd}`
}
