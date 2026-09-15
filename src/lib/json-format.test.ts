import { describe, expect, it } from 'vitest'
import { formatJsonSource } from './json-format'

describe('formatJsonSource', () => {
  it('adds structural whitespace without rewriting JSON token text', () => {
    const source = '{"big":900719925474099312345,"negative":-0,"exponent":1e+30,"text":"a,:{\\\"} 中 文","nested":[1,{"ok":true}],"empty":{},"big":2}'
    expect(formatJsonSource(source)).toBe(`{
  "big": 900719925474099312345,
  "negative": -0,
  "exponent": 1e+30,
  "text": "a,:{\\\"} 中 文",
  "nested": [
    1,
    {
      "ok": true
    }
  ],
  "empty": {},
  "big": 2
}\n`)
  })

  it('is idempotent and keeps empty containers compact', () => {
    const formatted = '{\n  "object": {},\n  "array": []\n}\n'
    expect(formatJsonSource(formatted)).toBe(formatted)
  })

  it('leaves invalid JSON untouched by declining to format it', () => {
    expect(formatJsonSource('{"broken":')).toBeNull()
    expect(formatJsonSource('// jsonc\n{"ok":true}')).toBeNull()
  })

  it('declines pathological nesting instead of amplifying indentation', () => {
    const source = `${'['.repeat(129)}0${']'.repeat(129)}`
    expect(formatJsonSource(source)).toBeNull()
  })
})
