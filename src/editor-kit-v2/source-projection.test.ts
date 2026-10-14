import { expect, it } from 'vitest'
import { displaySource, sourceFromDisplay } from './source-projection'

it('keeps untouched mixed EOL and BOM between separate edit hunks', () => {
  const raw = '\uFEFF# A\r\n\r\nalpha\nuntouched\rbeta\r\n'
  expect(sourceFromDisplay(raw, displaySource(raw))).toBe(raw)
  expect(sourceFromDisplay(raw, displaySource(raw).replace('alpha', 'Alpha').replace('beta', 'Beta'))).toBe(raw.replace('alpha', 'Alpha').replace('beta', 'Beta'))
  expect(sourceFromDisplay(raw, displaySource(raw) + 'x')).toBe(raw + 'x')
})
it('uses the existing source EOL for only inserted line breaks', () => {
  const raw = 'A\r\nkeep\nB\r'
  expect(sourceFromDisplay(raw, 'A\nnew\nkeep\nB\n')).toBe('A\r\nnew\r\nkeep\nB\r')
})
