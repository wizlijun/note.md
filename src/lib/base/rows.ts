import type { BaseRow, FileRecord, SortDirection } from './model'
import { resolveProp } from './filter'

/** Build display rows: resolve each ordered property into a cell value. */
export function buildRows(records: FileRecord[], order: string[]): BaseRow[] {
  return records.map((record) => {
    const cells: Record<string, unknown> = {}
    for (const prop of order) cells[prop] = resolveProp(prop, record)
    return { record, cells }
  })
}

function cmpValues(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  const na = Number(a), nb = Number(b)
  if (!Number.isNaN(na) && !Number.isNaN(nb) && a !== '' && b !== '') return na - nb
  return String(a ?? '').localeCompare(String(b ?? ''), undefined, { sensitivity: 'base' })
}

/** Stable sort rows by a property in the given direction. */
export function sortRows(rows: BaseRow[], property: string, direction: SortDirection): BaseRow[] {
  const sign = direction === 'DESC' ? -1 : 1
  return [...rows].sort((ra, rb) =>
    sign * cmpValues(resolveProp(property, ra.record), resolveProp(property, rb.record)))
}

export interface RowGroup { key: string; rows: BaseRow[] }

/** Group rows by a property value (rendered as a string key), ordered by key. */
export function groupRows(rows: BaseRow[], property: string, direction: SortDirection): RowGroup[] {
  const map = new Map<string, BaseRow[]>()
  for (const row of rows) {
    const key = displayCell(resolveProp(property, row.record))
    const arr = map.get(key) ?? []
    arr.push(row)
    map.set(key, arr)
  }
  const sign = direction === 'DESC' ? -1 : 1
  return [...map.entries()]
    .map(([key, rs]) => ({ key, rows: rs }))
    .sort((a, b) => sign * a.key.localeCompare(b.key, undefined, { sensitivity: 'base' }))
}

/** Render any cell value as display text. */
export function displayCell(v: unknown): string {
  if (v == null) return ''
  if (Array.isArray(v)) return v.map((x) => displayCell(x)).join(', ')
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}
