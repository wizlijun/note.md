import { describe, expect, it } from 'vitest'
import { parseStrictJson } from './strict-json'

describe('parseStrictJson', () => {
  it('rejects duplicate members instead of silently keeping the last one', () => {
    const result = parseStrictJson('{"a":1,"a":2}')
    expect(result.diagnostics.some(item => item.code === 'json.duplicate-key')).toBe(true)
  })
  it('enforces byte and nesting limits', () => {
    expect(parseStrictJson('"汉"', { maxBytes: 5 }).value).toBe('汉')
    expect(parseStrictJson('"汉"', { maxBytes: 4 }).diagnostics[0].code).toBe('json.too-large')
    expect(parseStrictJson('[[[0]]]', { maxDepth: 2 }).diagnostics[0].code).toBe('json.syntax')
  })
})
