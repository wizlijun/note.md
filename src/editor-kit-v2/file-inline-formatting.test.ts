import {expect, it} from 'vitest'
import {TextSelection} from 'prosemirror-state'
import {open} from './file-test-utils'

const formats = [
  ['**', 'strong'], ['__', 'strong'], ['*', 'em'], ['_', 'em'],
  ['~~', 'strike_through'], ['==', 'highlight'], ['^^', 'highlight'],
] as const
const operations = ['insert inside space', 'insert outside space', 'delete punctuation', 'replace with space', 'delete first word', 'delete last word', 'remove formatting']

it.each(formats.flatMap(([marker, mark]) => operations.map(operation => ({marker, mark, operation}))))(
  '$marker Rich $operation preserves text, source and history', async ({marker, mark, operation}) => {
    const body = operation.includes('word') ? '甲 乙' : '重点。', tail = '后文'
    const raw = `${marker}${body}${marker}${tail}`, c = open(raw), initial = c.state.doc
    expect(initial.firstChild!.firstChild!.marks.map(mark => mark.type.name)).toEqual([mark])
    const tr = c.state.tr, end = 1 + body.length
    let text = body + tail
    if (operation === 'remove formatting') tr.removeMark(1, end)
    else if (operation === 'delete first word') { tr.delete(1, 2); text = body.slice(1) + tail }
    else if (operation === 'delete last word' || operation === 'delete punctuation') { tr.delete(end - 1, end); text = body.slice(0, -1) + tail }
    else if (operation === 'replace with space') { tr.insertText(' ', end - 1, end); text = body.slice(0, -1) + ' ' + tail }
    else {
      tr.setSelection(TextSelection.create(c.state.doc, end))
      if (operation === 'insert outside space') tr.setStoredMarks([])
      tr.insertText(' '); text = body + ' ' + tail
    }
    const changes: string[] = []
    c.observe(value => changes.push(value.raw))
    expect(c.dispatch(tr), String(c.diagnostic)).toBe(true)
    await Promise.resolve()
    const after = c.snapshot().raw
    expect(c.state.doc.textContent).toBe(text)
    expect(c.state.doc.eq(tr.doc)).toBe(true)
    expect(changes).toEqual([after])
    expect(c.snapshot().generation).toBeGreaterThan(0)
    if (operation === 'remove formatting') expect(after).toBe(body + tail)
    expect(c.runHistory('undo', true)).toBe(true)
    expect(c.snapshot().raw).toBe(raw)
    expect(c.state.doc.eq(initial)).toBe(true)
    expect(c.runHistory('redo', true)).toBe(true)
    expect(c.snapshot().raw).toBe(after)
  },
)
