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
      src_end_line: 1,
      src_end_pos: 14,
      fingerprint: {
        hash: 'a1b2c3d4e5f6',
        length: 14,
        minhash: 'a'.repeat(256),
      },
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

  it('preserves long minhash hex string on a single line', () => {
    const yaml = serializeBlockYaml(sample)
    // The 256-char minhash should not be folded across lines.
    expect(yaml).toContain(`minhash: ${'a'.repeat(256)}`)
  })

  it('rejects yaml with wrong schema_version', () => {
    const wrong = serializeBlockYaml(sample).replace(
      `schema_version: ${SCHEMA_VERSION}`,
      'schema_version: 99',
    )
    expect(() => parseBlockYaml(wrong)).toThrow(/schema/i)
  })

  it('rejects v1 yaml so the caller can quarantine and rebuild', () => {
    const v1 = serializeBlockYaml(sample).replace(
      `schema_version: ${SCHEMA_VERSION}`,
      'schema_version: 1',
    )
    expect(() => parseBlockYaml(v1)).toThrow(/schema/i)
  })

  it('throws on malformed yaml', () => {
    expect(() => parseBlockYaml('not: : valid')).toThrow()
  })
})
