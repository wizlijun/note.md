import { createHash } from 'node:crypto'
export const markers = ['SumiBenchStart', 'SumiBenchMiddle', 'SumiBenchEnd']
const phrase = '沉浸式写作让思绪慢慢成形。春雨落在窗外，纸上的句子保留每一次停顿。 Typewriter 1932 / 0123456789 / café é / 😀 👩‍💻。这一段包含中文、拉丁字母、数字与组合字符。\n\n'
function fill(units) {
  let value = ''
  while (value.length + phrase.length <= units) value += phrase
  for (const { segment } of new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(phrase)) {
    if (value.length + segment.length > units) break
    value += segment
  }
  return (value + '中'.repeat(units - value.length)).replace(/\n+$/, s => '中'.repeat(s.length))
}
export function corpus(units) {
  if (![10000, 100000, 1000000].includes(units)) throw new Error('supported sizes: 10000, 100000, 1000000 UTF-16 units')
  const reserved = markers.join('').length + 8
  const remaining = units - reserved
  const a = Math.floor(remaining / 2)
  const markdown = `${markers[0]}\n\n${fill(a)}\n\n${markers[1]}\n\n${fill(remaining - a)}\n\n${markers[2]}`
  if (markdown.length !== units) throw new Error('corpus length invariant')
  return {
    schema: 1, profile: 'mixed-cjk-prose-v1', markdown, markers,
    sha256: createHash('sha256').update(markdown).digest('hex'),
    utf16_units: markdown.length, unicode_scalars: [...markdown].length,
    utf8_bytes: Buffer.byteLength(markdown),
    graphemes: [...new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(markdown)].length,
    input_sequence: ['字', 'a', '你', '😀'],
  }
}
export function quantiles(values) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const q = p => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]
  return { count: sorted.length, p50: q(.5), p95: q(.95), p99: q(.99), max: sorted.at(-1) }
}
