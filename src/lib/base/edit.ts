import { stringify } from 'yaml'
import type { SortDirection } from './model'

export type Raw = Record<string, unknown>

/** Deep clone plain YAML data (strings/numbers/bools/arrays/objects). */
function clone(v: unknown): Raw {
  return v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : {}
}

function asObj(v: unknown): Raw {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : {}
}

/** Clone `raw`, ensure `views[viewIndex]` exists as an object, return both. */
function ensureView(raw: Raw, viewIndex: number): { raw: Raw; view: Raw } {
  const out = clone(raw)
  if (!Array.isArray(out.views)) out.views = []
  const views = out.views as Raw[]
  while (views.length <= viewIndex) views.push({ type: 'table', name: 'Table' })
  const view = asObj(views[viewIndex])
  views[viewIndex] = view
  return { raw: out, view }
}

/** Return view.order, materializing it from currentColumns when missing/empty. */
function ensureOrder(view: Raw, currentColumns: string[]): string[] {
  if (Array.isArray(view.order) && view.order.length) {
    view.order = (view.order as unknown[]).filter((x): x is string => typeof x === 'string')
  } else {
    view.order = [...currentColumns]
  }
  return view.order as string[]
}

export function addColumn(raw: Raw, viewIndex: number, prop: string, currentColumns: string[]): Raw {
  const { raw: out, view } = ensureView(raw, viewIndex)
  const order = ensureOrder(view, currentColumns)
  if (!order.includes(prop)) order.push(prop)
  return out
}

export function removeColumn(raw: Raw, viewIndex: number, prop: string, currentColumns: string[]): Raw {
  const { raw: out, view } = ensureView(raw, viewIndex)
  const order = ensureOrder(view, currentColumns)
  view.order = order.filter((c) => c !== prop)
  return out
}

export function moveColumn(
  raw: Raw, viewIndex: number, prop: string, toIndex: number, currentColumns: string[],
): Raw {
  const { raw: out, view } = ensureView(raw, viewIndex)
  const order = ensureOrder(view, currentColumns)
  const from = order.indexOf(prop)
  if (from === -1) return out
  order.splice(from, 1)
  const clamped = Math.max(0, Math.min(order.length, toIndex))
  order.splice(clamped, 0, prop)
  view.order = order
  return out
}

/** Set/clear a global displayName. Empty name removes it (and an empty prop entry). */
export function renameColumn(raw: Raw, prop: string, name: string): Raw {
  const out = clone(raw)
  const props = asObj(out.properties)
  const entry = asObj(props[prop])
  if (name.trim()) {
    entry.displayName = name
    props[prop] = entry
  } else {
    delete entry.displayName
    if (Object.keys(entry).length === 0) delete props[prop]
    else props[prop] = entry
  }
  // Keep the file clean: drop an empty `properties:` map rather than writing `{}`.
  if (Object.keys(props).length === 0) delete out.properties
  else out.properties = props
  return out
}

export function setGroupBy(raw: Raw, viewIndex: number, prop: string | null, direction: SortDirection): Raw {
  const { raw: out, view } = ensureView(raw, viewIndex)
  if (prop) view.groupBy = { property: prop, direction }
  else delete view.groupBy
  return out
}

export function setSort(raw: Raw, viewIndex: number, prop: string | null, direction: SortDirection): Raw {
  const { raw: out, view } = ensureView(raw, viewIndex)
  if (prop) view.sort = [{ property: prop, direction }]
  else delete view.sort
  return out
}

export function toYaml(raw: Raw): string {
  return stringify(raw)
}
