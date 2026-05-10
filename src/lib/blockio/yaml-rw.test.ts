import { describe, it, expect } from 'vitest'
import { serializeBlockYaml, parseBlockYaml } from './yaml-rw'
import type { BlockYaml } from './yaml-schema'
import { SCHEMA_VERSION, DEFAULT_CONFIG } from './yaml-schema'

const sample: BlockYaml = {
  meta: {
    source: 'doc.md',
    source_hash: 'abcdef012345',
    generation: 1,
    updated_at: '2026-05-10T00:00:00Z',
    schema_version: SCHEMA_VERSION,
    has_block_md: false,
  },
  config: { ...DEFAULT_CONFIG },
  active: [
    {
      id: 'b-7f3a9c',
      src_line: 1,
      src_pos: 0,
      fingerprint: { hash: 'a1b2c3d4e5f6', length: 14 },
      text: '# introduction',
      parents: [],
      created_gen: 1,
    },
  ],
  history: [],
}

describe('serializeBlockYaml + parseBlockYaml round-trip', () => {
  it('preserves all fields', () => {
    const yaml = serializeBlockYaml(sample)
    const parsed = parseBlockYaml(yaml)
    expect(parsed).toEqual(sample)
  })

  it('preserves multi-line text content', () => {
    const withMultiline: BlockYaml = {
      ...sample,
      active: [{ ...sample.active[0], text: 'line one\nline two\nline three' }],
    }
    const round = parseBlockYaml(serializeBlockYaml(withMultiline))
    expect(round.active[0].text).toBe('line one\nline two\nline three')
  })

  it('rejects yaml with wrong schema_version', () => {
    const wrong = serializeBlockYaml(sample).replace(
      'schema_version: 1',
      'schema_version: 99',
    )
    expect(() => parseBlockYaml(wrong)).toThrow(/schema/i)
  })

  it('throws on malformed yaml', () => {
    expect(() => parseBlockYaml('not: : valid')).toThrow()
  })
})
