import { expect, it } from 'vitest'
import { acceptsOwnerFloor, ownerAnnotationFloor } from './owner-policy'
it('freezes multiset minimum and permits copies, undo and old touched recovery', () => {
  const O = '{==甲==}{>>旧注<<}', floor = ownerAnnotationFloor(O + O, O)
  expect(floor.get(O)).toBe(1)
  expect(acceptsOwnerFloor(floor, '')).toBe(false)
  expect(acceptsOwnerFloor(floor, O + O)).toBe(true)
  expect(acceptsOwnerFloor(floor, O)).toBe(true)
  const missing = ownerAnnotationFloor(O, '')
  expect(acceptsOwnerFloor(missing, O)).toBe(true); expect(acceptsOwnerFloor(missing, '')).toBe(true)
})

import { Plugin } from 'prosemirror-state'
import { closeHistory } from 'prosemirror-history'
import { open } from '../editor-kit-v2/file-test-utils'
const O = '{==甲==}{>>旧注<<}'
const policy = (base: string, initial: string) => { const floor = ownerAnnotationFloor(base, initial); return { acceptRawChange: (_before: string, candidate: string) => acceptsOwnerFloor(floor, candidate) } }
it('real controller restore/source/history all preserve the frozen floor', () => {
  const f = open(O, [], undefined, policy(O + O, O))
  expect(f.restoreContent('').ok).toBe(false)
  expect(f.replaceSource({ expectedGeneration: f.snapshot().generation, value: '' }).ok).toBe(false)
  expect(f.restoreContent(O + O).ok).toBe(true)
  expect(f.runHistory('undo', true)).toBe(true); expect(f.snapshot().raw).toBe(O)
  expect(f.runHistory('redo', true)).toBe(true); expect(f.snapshot().raw).toBe(O + O)
  expect(f.restoreContent(O).ok).toBe(true)
})
it('old touched owners may be restored then undone to the old missing state', () => {
  const f = open('', [], undefined, policy(O, ''))
  expect(f.restoreContent(O).ok).toBe(true)
  expect(f.runHistory('undo', true)).toBe(true); expect(f.snapshot().raw).toBe('')
})
it('mixed root/append validates final count once, native undo may traverse an intermediate deletion', async () => {
  let append = true
  const tail = new Plugin({ appendTransaction(transactions, _old, state) {
    if (!append || transactions.some(tr => tr.getMeta('tail')) || !transactions.some(tr => tr.docChanged)) return null
    return state.tr.addMark(1, 2, state.schema.marks.annotation.create({ note: '旧注' })).setMeta('tail', true)
  } })
  const observed: unknown[] = [], f = open(O, [tail], undefined, policy(O, O))
  f.observe(value => observed.push(value))
  const tr = f.state.tr.removeMark(1, 2, f.state.schema.marks.annotation).insertText('!', 2)
  expect(f.dispatch(closeHistory(tr))).toBe(true)
  await Promise.resolve(); expect(observed).toHaveLength(1)
  append = false
  expect(f.runHistory('undo', true)).toBe(true); expect(f.snapshot().raw).toBe(O)
})
it('append invalidating the floor rejects the whole chain with no observer or generation', async () => {
  const tail = new Plugin({ appendTransaction(transactions, _old, state) {
    if (transactions.some(tr => tr.getMeta('tail')) || !transactions.some(tr => tr.docChanged)) return null
    return state.tr.removeMark(1, 2, state.schema.marks.annotation).setMeta('tail', true)
  } })
  const observed: unknown[] = [], f = open(O, [tail], undefined, policy(O, O)), before = f.snapshot()
  f.observe(value => observed.push(value))
  expect(f.dispatch(f.state.tr.insertText('!', 2))).toBe(false)
  await Promise.resolve(); expect(observed).toEqual([]); expect(f.snapshot()).toEqual(before)
})
