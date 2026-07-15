import { parse } from 'yaml'
import type { BaseConfig, BaseView, BaseSort } from './model'

const EMPTY_VIEW: BaseView = { type: 'table', name: 'Table' }

function toSort(v: unknown): BaseSort | undefined {
  if (!v || typeof v !== 'object') return undefined
  const o = v as Record<string, unknown>
  if (typeof o.property !== 'string') return undefined
  const dir = o.direction === 'DESC' ? 'DESC' : 'ASC'
  return { property: o.property, direction: dir }
}

function toView(v: unknown): BaseView {
  if (!v || typeof v !== 'object') return { ...EMPTY_VIEW }
  const o = v as Record<string, unknown>
  return {
    type: typeof o.type === 'string' ? o.type : 'table',
    name: typeof o.name === 'string' ? o.name : 'Table',
    order: Array.isArray(o.order) ? o.order.filter((x): x is string => typeof x === 'string') : undefined,
    groupBy: toSort(o.groupBy),
    sort: Array.isArray(o.sort)
      ? o.sort.map(toSort).filter((s): s is BaseSort => !!s)
      : undefined,
    filters: (o.filters as BaseView['filters']) ?? undefined,
    limit: typeof o.limit === 'number' ? o.limit : undefined,
  }
}

/** Parse .base YAML text into a BaseConfig. Never throws. */
export function parseBase(text: string): BaseConfig {
  let raw: unknown
  try {
    raw = parse(text)
  } catch (e) {
    return { properties: {}, views: [{ ...EMPTY_VIEW }], error: String(e) }
  }
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const viewsRaw = Array.isArray(o.views) ? o.views : []
  const views = viewsRaw.length ? viewsRaw.map(toView) : [{ ...EMPTY_VIEW }]
  const props = (o.properties && typeof o.properties === 'object' ? o.properties : {}) as BaseConfig['properties']
  return {
    filters: (o.filters as BaseConfig['filters']) ?? undefined,
    properties: props,
    views,
    raw,
  }
}
