import { describe, it, expect } from 'vitest'
import { parse } from 'yaml'
import {
  addColumn, removeColumn, moveColumn, renameColumn,
  setGroupBy, setSort, toYaml,
} from './edit'

// A raw config carrying fields we DON'T support, to prove round-trip preservation.
const RAW = {
  formulas: { ppu: '(price / age).toFixed(2)' },
  summaries: { customAvg: 'values.mean()' },
  properties: { 'note.status': { displayName: 'Status' } },
  views: [
    { type: 'table', name: 'T', order: ['file.name', 'note.status'] },
    { type: 'cards', name: 'C' },
  ],
}
const clone = () => JSON.parse(JSON.stringify(RAW))

describe('addColumn', () => {
  it('appends to an existing order', () => {
    const out = addColumn(clone(), 0, 'note.rating', ['file.name', 'note.status'])
    expect((out.views as any)[0].order).toEqual(['file.name', 'note.status', 'note.rating'])
  })
  it('materializes order from currentColumns when order is absent', () => {
    const raw = { views: [{ type: 'table', name: 'T' }] }
    const out = addColumn(raw, 0, 'note.x', ['file.name', 'note.a'])
    expect((out.views as any)[0].order).toEqual(['file.name', 'note.a', 'note.x'])
  })
  it('does not duplicate an existing column', () => {
    const out = addColumn(clone(), 0, 'note.status', ['file.name', 'note.status'])
    expect((out.views as any)[0].order).toEqual(['file.name', 'note.status'])
  })
})

describe('removeColumn', () => {
  it('removes the column from order', () => {
    const out = removeColumn(clone(), 0, 'note.status', ['file.name', 'note.status'])
    expect((out.views as any)[0].order).toEqual(['file.name'])
  })
})

describe('moveColumn', () => {
  it('moves a column to a new index', () => {
    const out = moveColumn(clone(), 0, 'file.name', 1, ['file.name', 'note.status'])
    expect((out.views as any)[0].order).toEqual(['note.status', 'file.name'])
  })
  it('is a no-op for an unknown column', () => {
    const out = moveColumn(clone(), 0, 'note.zzz', 0, ['file.name', 'note.status'])
    expect((out.views as any)[0].order).toEqual(['file.name', 'note.status'])
  })
})

describe('renameColumn', () => {
  it('sets displayName globally', () => {
    const out = renameColumn(clone(), 'note.rating', 'Score')
    expect((out.properties as any)['note.rating']).toEqual({ displayName: 'Score' })
  })
  it('empty name removes the displayName (and empty entry, dropping empty properties map)', () => {
    const out = renameColumn(clone(), 'note.status', '')
    // note.status was the only property, so the whole map is dropped (no stray `properties: {}`)
    expect(out.properties).toBeUndefined()
  })
  it('keeps other properties when clearing one displayName', () => {
    const raw = { properties: { 'note.a': { displayName: 'A' }, 'note.b': { displayName: 'B' } } }
    const out = renameColumn(raw, 'note.a', '')
    expect(out.properties).toEqual({ 'note.b': { displayName: 'B' } })
  })
})

describe('setGroupBy / setSort', () => {
  it('sets and clears groupBy', () => {
    let out = setGroupBy(clone(), 0, 'note.status', 'ASC')
    expect((out.views as any)[0].groupBy).toEqual({ property: 'note.status', direction: 'ASC' })
    out = setGroupBy(out, 0, null, 'ASC')
    expect((out.views as any)[0].groupBy).toBeUndefined()
  })
  it('sets and clears sort (list form)', () => {
    let out = setSort(clone(), 0, 'note.rating', 'DESC')
    expect((out.views as any)[0].sort).toEqual([{ property: 'note.rating', direction: 'DESC' }])
    out = setSort(out, 0, null, 'DESC')
    expect((out.views as any)[0].sort).toBeUndefined()
  })
})

describe('round-trip preservation', () => {
  it('keeps unsupported fields (formulas/summaries/cards view) through edit + toYaml', () => {
    const out = addColumn(clone(), 0, 'note.rating', ['file.name', 'note.status'])
    const reparsed = parse(toYaml(out)) as any
    expect(reparsed.formulas).toEqual({ ppu: '(price / age).toFixed(2)' })
    expect(reparsed.summaries).toEqual({ customAvg: 'values.mean()' })
    expect(reparsed.views[1]).toEqual({ type: 'cards', name: 'C' })
  })
  it('does not mutate the input object', () => {
    const raw = clone()
    addColumn(raw, 0, 'note.rating', ['file.name', 'note.status'])
    expect(raw.views[0].order).toEqual(['file.name', 'note.status'])
  })
})
