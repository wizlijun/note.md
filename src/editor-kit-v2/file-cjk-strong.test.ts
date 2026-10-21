import {expect, it} from 'vitest'
import {TextSelection} from 'prosemirror-state'
import {open} from './file-test-utils'

const sentence = '用户怎么用 Tower.md，我们预测不了；人脑在哪里会出错，我们预测得了。'
const tail = '所以核心不预设任何场景，'
const raw = `**${sentence}**${tail}`

it.each(['delete punctuation', 'insert space', 'insert bold space', 'remove strong'] as const)('Rich CJK strong: %s saves exact source and restores history', async operation => {
  const c = open(raw), initial = c.state.doc
  expect(initial.firstChild!.firstChild!.marks.map(mark => mark.type.name)).toEqual(['strong'])
  expect(initial.textContent).toBe(sentence + tail)
  expect(c.snapshot().raw).toBe(raw)
  const end = 1 + sentence.length
  const tr = c.state.tr
  const expected = operation === 'delete punctuation' ? raw.replace('。', '')
    : operation === 'insert bold space' ? raw.replace('。**所', '。&#32;**&#25152;')
    : operation === 'insert space' ? raw.replace('**所以', '** 所以') : sentence + tail
  if (operation === 'delete punctuation') tr.delete(end - 1, end)
  else if (operation === 'insert bold space') tr.setSelection(TextSelection.create(c.state.doc, end)).insertText(' ')
  else if (operation === 'insert space') tr.setSelection(TextSelection.create(c.state.doc, end)).setStoredMarks([]).insertText(' ')
  else tr.removeMark(1, end, c.state.schema.marks.strong)
  const changes: string[] = []
  c.observe(value => changes.push(value.raw))
  expect(c.dispatch(tr), String(c.diagnostic)).toBe(true)
  await Promise.resolve()
  expect(changes).toEqual([expected])
  expect(c.snapshot().raw).toBe(expected)
  expect(c.snapshot().generation).toBeGreaterThan(0)
  expect(c.runHistory('undo', true)).toBe(true)
  expect(c.snapshot().raw).toBe(raw)
  expect(c.state.doc.eq(initial)).toBe(true)
  expect(c.runHistory('redo', true)).toBe(true)
  expect(c.snapshot().raw).toBe(expected)
})
