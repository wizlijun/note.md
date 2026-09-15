import { describe, expect, it } from 'vitest'
import { locateQuote, parseSourceLocation, resolveSourceUri } from './source-resolver'

describe('source resolver', () => {
  it('maps bundle and relative paths into the Vault without treating them as OS paths', () => {
    expect(resolveSourceUri('/ssot/a.md').vaultPath).toBe('ssot/a.md')
    expect(resolveSourceUri('../source.md', 'research/nested/data.knowledge.json').vaultPath).toBe('research/source.md')
    expect(resolveSourceUri('../../../../.env', 'research/data.json').kind).toBe('blocked')
    expect(resolveSourceUri('/Users/bruce/private.md').kind).toBe('external-path')
  })
  it('parses supported loc forms and reports ambiguous quote matches', () => {
    expect(parseSourceLocation('L12-L18')).toMatchObject({ kind: 'lines', startLine: 12, endLine: 18 })
    expect(parseSourceLocation('00:00:01.500-00:00:02')).toMatchObject({ kind: 'timecode', startMs: 1500, endMs: 2000 })
    expect(locateQuote('a\r\na\n', 'a').matches).toEqual([0, 2])
  })
})
