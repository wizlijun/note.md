import { expect, it } from 'vitest'
import { tokenize } from './tokenize'

const texts = (text: string) => tokenize(text).map(token => token.text)

it('preserves BOM, CRLF, inline syntax and the missing final newline', () => {
  const text = '\uFEFF---\r\ntitle: A\r\n---\r\n甲。乙 `x.y`。\r\n末行'
  expect(texts(text).join('')).toBe(text)
  expect(texts('甲。乙！\n')).toEqual(['甲。', '乙！\n'])
})

it('splits prose at sentence endings and keeps closing symbols, spaces and EOL', () => {
  expect(texts('甲。” \t乙！\r\n')).toEqual(['甲。” \t', '乙！\r\n'])
  expect(texts('A. B; C…D\n')).toEqual(['A. ', 'B; ', 'C…', 'D\n'])
  expect(texts('1. First. Second.\n> 引用。下一句\n# 标题！下句')).toEqual(['1. First. ', 'Second.\n', '> 引用。', '下一句\n', '# 标题！', '下句'])
  expect(texts('重复。重复。')).toEqual(['重复。', '重复。'])
})

it('does not split protected inline syntax', () => {
  for (const inline of ['`甲。乙!`', '``甲。`乙!``', '$甲。乙!$', '[甲。乙!](a.b "x! y")', '![甲。乙!](a(b).png)', '[[甲。乙!]]', '{==甲。乙!==}{>>评。论!<<}', '{>>评。论!<<}', '<span title="甲。乙!">']) {
    expect(texts(`前${inline}后。尾\n`)).toEqual([`前${inline}后。`, '尾\n'])
  }
  expect(texts('前\\。后。尾')).toEqual(['前\\。后。', '尾'])
})

it('protects links with apostrophes in URLs and parentheses inside titles', () => {
  for (const inline of ["[甲。](don't.example)", '[甲。](a "title ) with 。")', '[嵌套[甲。]](a(b)c)']) {
    expect(texts(`前${inline}后。尾`)).toEqual([`前${inline}后。`, '尾'])
  }
})

it('I1 protects link labels containing matched backtick spans with brackets', () => {
  for (const inline of ['[代码 `]`。](url)', '![代码 ``] ` [``。](image.png)', '[外层[代码 `]`。]标签](url)']) {
    expect(texts(`前${inline}后。尾`)).toEqual([`前${inline}后。`, '尾'])
  }
  expect(texts('前[一](a`b)后[甲。](url) `。尾')).toEqual(['前[一](a`b)后[甲。](url) `。', '尾'])
})

it('I2 checks odd and even backslash runs before closing delimiters', () => {
  for (const [open, close] of [['$', '$'], ['[[', ']]'], ['{==', '==}'], ['{>>', '<<}']]) {
    for (const count of [1, 2, 3]) {
      const firstClose = '\\'.repeat(count) + close
      const inline = count % 2 === 0 ? `${open}甲。${firstClose}` : `${open}甲。${firstClose}乙！${close}`
      expect(texts(`前${inline}后。尾`)).toEqual([`前${inline}后。`, '尾'])
    }
  }
})

it('I3 scans 64000 unmatched brackets within a generous linear-scan budget', () => {
  const text = '['.repeat(64_000) + '甲。尾'
  const start = performance.now()
  expect(texts(text)).toEqual(['['.repeat(64_000) + '甲。', '尾'])
  expect(performance.now() - start).toBeLessThan(500)
})

it('keeps fences, math and HTML as atomic blocks', () => {
  expect(texts('  ````ts\n甲。\n```\n乙！\n`````\n尾。\n')).toEqual(['  ````ts\n甲。\n```\n乙！\n`````\n', '尾。\n'])
  expect(texts('~~~\n甲。\n```\n')).toEqual(['~~~\n甲。\n```\n'])
  expect(texts('$$\n甲。\n$$\n尾。')).toEqual(['$$\n甲。\n$$\n', '尾。'])
  expect(texts('<div>\n甲。\n</div>\n\n尾。')).toEqual(['<div>\n甲。\n</div>\n', '\n', '尾。'])
  expect(texts('<!-- 注。\n释 -->\n')).toEqual(['<!-- 注。\n释 -->\n'])
})

it('keeps table rows and blank runs intact, with prose after the table', () => {
  expect(texts('| A。 | B！ |\r\n| :--- | ---: |\r\n| C。 | D！ |\r\n \r\n\t\r\n尾。句\r\n')).toEqual(['| A。 | B！ |\r\n', '| :--- | ---: |\r\n', '| C。 | D！ |\r\n', ' \r\n\t\r\n', '尾。', '句\r\n'])
  expect(texts('[^1]: 注。说明\n    续行！\n')).toEqual(['[^1]: 注。', '说明\n', '    续行！\n'])
})

it('can return more than 200000 tokens for the caller to apply its degradation limit', () => {
  const text = '甲。'.repeat(200_001)
  const tokens = tokenize(text)
  expect(tokens).toHaveLength(200_001)
  expect(tokens.map(token => token.text).join('')).toBe(text)
})

it('has contiguous UTF-16 offsets and preserves 600 seeded Markdown inputs', () => {
  let seed = 0x12345678
  const pieces = ['甲。乙！', '\uFEFF', '\r\n', '\n', '\r', '\t', '😀', '---\n', 'a: b\n', '...\n', '```ts\n', '~~~\n', '$$\n', '<div>\n', '\n\n', '| A。 | B |\n| --- | --- |\n', '[^x]: 甲。\n', '`x.y!`', '[甲。](url)', '{>>评。<<}', '[[链。]]', '末行']
  for (let sample = 0; sample < 600; sample++) {
    let text = ''
    for (let i = 0; i < sample % 31; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      text += pieces[seed % pieces.length]
    }
    const tokens = tokenize(text)
    expect(tokens.map(token => token.text).join('')).toBe(text)
    let offset = 0
    for (const token of tokens) {
      expect(token.start).toBe(offset)
      expect(token.end).toBeGreaterThan(token.start)
      expect(token.text).toBe(text.slice(token.start, token.end))
      offset = token.end
    }
    expect(offset).toBe(text.length)
  }
})
