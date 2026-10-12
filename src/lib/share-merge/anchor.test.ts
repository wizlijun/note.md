import { expect, it } from 'vitest'
import { anchor, makeSelector } from './index'

it('K18 gives a matching position priority and keeps UTF-16 offsets', () => {
  expect(anchor('😀中文 中文', { exact: '中文', start: 2, end: 4, prefix: 'wrong' })).toEqual({ status: 'exact', start: 2, end: 4 })
  expect(anchor('甲乙中文', { exact: '中文', start: 0, end: 2 })).toEqual({ status: 'exact', start: 2, end: 4 })
})

it('takes 32 UTF-16 units of context around a selector', () => {
  expect(makeSelector('前'.repeat(40) + '😀中' + '后'.repeat(40), 40, 43)).toEqual({ exact: '😀中', prefix: '前'.repeat(32), suffix: '后'.repeat(32), start: 40, end: 43 })
})

it('disambiguates exact repeats with suffix/prefix and stable proximity tie breaking', () => {
  expect(anchor('A引文B C引文D', { exact: '引文', prefix: 'C', suffix: 'D', start: 0 })).toEqual({ status: 'exact', start: 6, end: 8 })
  expect(anchor('x引文y x引文y', { exact: '引文', start: 4 })).toEqual({ status: 'exact', start: 6, end: 8 })
  expect(anchor('x引文y x引文y', { exact: '引文', start: 3.5 })).toEqual({ status: 'exact', start: 1, end: 3 })
})

it('anchors point annotations by joined context or a unique single side', () => {
  expect(anchor('甲😀乙', { exact: '', prefix: '甲😀', suffix: '乙' })).toEqual({ status: 'exact', start: 3, end: 3 })
  expect(anchor('甲😀新乙', { exact: '', prefix: '甲😀', suffix: 'gone' })).toEqual({ status: 'exact', start: 3, end: 3 })
  expect(anchor('新乙', { exact: '', prefix: 'gone', suffix: '乙' })).toEqual({ status: 'exact', start: 1, end: 1 })
  expect(anchor('重复重复', { exact: '', prefix: '重复', suffix: 'gone' })).toEqual({ status: 'orphan' })
  expect(anchor('甲', { exact: '' })).toEqual({ status: 'orphan' })
})

it('fuzzily anchors small edits and variable window lengths with adjacent context', () => {
  expect(anchor('前abcdefghXj后', { exact: 'abcdefghij', prefix: '前', suffix: '后', start: 1 })).toEqual({ status: 'fuzzy', start: 1, end: 11 })
  expect(anchor('前abcXdefghij后', { exact: 'abcdefghij', prefix: '前', suffix: '后', start: 1 })).toEqual({ status: 'fuzzy', start: 1, end: 12 })
  expect(anchor('前abcdfghij后', { exact: 'abcdefghij', prefix: '前', suffix: '后', start: 1 })).toEqual({ status: 'fuzzy', start: 1, end: 10 })
})

it('rejects weak quote similarity, weak context and out-of-range fuzzy candidates', () => {
  expect(anchor('前abcXXXghij后', { exact: 'abcdefghij', prefix: '前', suffix: '后' })).toEqual({ status: 'orphan' })
  expect(anchor('错误abcdefghXj错误', { exact: 'abcdefghij', prefix: '正确', suffix: '正确' })).toEqual({ status: 'orphan' })
  expect(anchor('x'.repeat(2100) + 'abcdefghXj', { exact: 'abcdefghij', start: 0 })).toEqual({ status: 'orphan' })
  expect(anchor('abcdefX', { exact: 'abcdefg' })).toEqual({ status: 'orphan' })
  expect(anchor('a'.repeat(512) + 'X', { exact: 'a'.repeat(513) })).toEqual({ status: 'orphan' })
})

it('prefers fuzzy similarity before distance and repeats deterministic ties', () => {
  const text = 'abcXXfghij........abcdefghXj'
  expect(anchor(text, { exact: 'abcdefghij', start: 0 })).toEqual({ status: 'fuzzy', start: 18, end: 28 })
  for (let i = 0; i < 3; i++) {
    expect(anchor('abcdefghXj....abcdefghYj', { exact: 'abcdefghij', start: 7 })).toEqual({ status: 'fuzzy', start: 0, end: 10 })
  }
})

it('accepts the quote and context thresholds inclusively', () => {
  expect(anchor('abXXeabcXXfghijXXXXX', { exact: 'abcdefghij', prefix: 'abcde', suffix: 'zzzzz', start: 5 })).toEqual({ status: 'fuzzy', start: 5, end: 15 })
})

it('handles the 512-unit fuzzy boundary on repetitive text without moving the anchor', () => {
  expect(anchor('a'.repeat(6000), { exact: 'a'.repeat(511) + 'b', start: 2512 })).toEqual({ status: 'fuzzy', start: 2512, end: 3023 })
})

it('handles long near-threshold quotes and rejects all weak adjacent contexts', () => {
  expect(anchor('a'.repeat(6000), { exact: 'a'.repeat(412) + 'b'.repeat(100), start: 2512 })).toEqual({ status: 'fuzzy', start: 2512, end: 2924 })
  expect(anchor('a'.repeat(6000), { exact: 'a'.repeat(511) + 'b', start: 2512, prefix: 'z'.repeat(32), suffix: 'z'.repeat(32) })).toEqual({ status: 'orphan' })
})
