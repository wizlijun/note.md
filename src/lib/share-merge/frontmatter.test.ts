import { expect, it } from 'vitest'
import { tokenize } from './tokenize'

it('groups frontmatter by top-level key and retains continuation trivia', () => {
  const text = '\uFEFF---\r\n# before\r\n\r\n"title": A\r\n  next: B\r\n- list\r\n# attached\r\n\r\n\'tags\': [a]\r\n...\r\n正文。'
  expect(tokenize(text)).toEqual([
    { text: '\uFEFF---\r\n', start: 0, end: 6 },
    { text: '# before\r\n\r\n', start: 6, end: 18 },
    { text: '"title": A\r\n  next: B\r\n- list\r\n# attached\r\n\r\n', start: 18, end: 63, fmKey: 'title' },
    { text: "'tags': [a]\r\n", start: 63, end: 76, fmKey: 'tags' },
    { text: '...\r\n', start: 76, end: 81 },
    { text: '正文。', start: 81, end: 84 },
  ])
})

it('degrades malformed leading frontmatter to an atomic token', () => {
  const frontmatter = '---\nnot a key\ntitle: A\n---\n'
  expect(tokenize(frontmatter + '正文。尾').map(token => token.text)).toEqual([frontmatter, '正文。', '尾'])
})

it('requires opening EOL and a matching exact closing delimiter', () => {
  expect(tokenize('---')).toEqual([{ text: '---', start: 0, end: 3 }])
  expect(tokenize('---\na: 甲。乙\n--- trailing\n').some(token => token.fmKey !== undefined)).toBe(false)
  expect(tokenize('---\n---').map(token => token.text)).toEqual(['---\n', '---'])
})
