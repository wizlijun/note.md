import { expect, it } from 'vitest'
import { alignEol } from './eol'

it('aligns LF and a missing BOM to base', () => {
  expect(alignEol('\uFEFFa\r\n', 'b\n')).toEqual({ theirs: '\uFEFFb\r\n', aligned: true })
})

it('leaves all other EOL and BOM combinations intact', () => {
  for (const [base, theirs] of [['a\n', 'b\r\n'], ['a\r\n', 'b\rc\n'], ['a\n', '\uFEFFb\n'], ['\uFEFFa\r\n', '\uFEFFb\r\n'], ['a', 'b']]) {
    expect(alignEol(base, theirs)).toEqual({ theirs, aligned: false })
  }
})
