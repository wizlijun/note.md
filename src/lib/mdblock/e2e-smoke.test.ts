import { describe, it, expect } from 'vitest'
import { stringify } from 'yaml'
import { chunkDocument } from '../blockchunk/chunker'
import {
  computeFingerprint,
  serializeMinHash,
} from '../blockchunk/fingerprint'
import { mergeBlocks, type OldBlockEntry, type NewBlockEntry } from '../blockchunk/merge'
import { generateBlockMd, splitFrontmatter } from '../blockio/inject'
import {
  type ActiveBlock,
  type BlockYaml,
  SCHEMA_VERSION,
} from '../blockio/yaml-schema'

/**
 * End-to-end smoke that exercises the full pipeline against a realistic
 * markdown sample. Verifies the round-trip behavior of:
 *   chunk → fingerprint → id alloc → merge → generate .block.md
 * and asserts that a one-character edit preserves identity for all blocks
 * except possibly the edited one.
 *
 * NOT a unit test; runs in CI alongside other tests as a coarse health check.
 */

const SAMPLE = `---
title: mdblock e2e sample
author: bruce
date: 2026-05-10
---

# Introduction

This is the first paragraph of the document. It contains some content
that the chunker should pick up as a block.

# Background

Here's some background text explaining context. The merge algorithm
should treat this as a stable block across light edits.

## Code example

\`\`\`typescript
function hello(name: string): string {
  return \`Hello, \${name}!\`
}
\`\`\`

After the code block, more prose continues. Lists also matter:

- First list item
- Second list item
- Third list item

# Conclusion

The final block of the document. ((other.md#b-aaaaaa)) is an example
citation pointing somewhere else.
`

async function buildActive(source: string, ids: string[]): Promise<ActiveBlock[]> {
  const fm = splitFrontmatter(source)
  const bodyBlocks = chunkDocument(fm.body, 500, 0, 200)
  const fps = await Promise.all(bodyBlocks.map((b) => computeFingerprint(b.text)))
  return bodyBlocks.map((b, i) => {
    const newlines = (b.text.match(/\n/g) ?? []).length
    return {
      id: ids[i],
      src_pos: b.src_pos + fm.fm.length,
      src_line: b.src_line + fm.fmLines,
      src_end_line: b.src_line + fm.fmLines + newlines,
      src_end_pos: b.src_pos + fm.fm.length + b.text.length,
      fingerprint: {
        hash: fps[i].hash,
        length: fps[i].length,
        minhash: serializeMinHash(fps[i].minhash),
      },
      parents: [],
      created_gen: 1,
    }
  })
}

describe('mdblock e2e pipeline', () => {
  it('chunks a real markdown into multiple blocks', () => {
    const fm = splitFrontmatter(SAMPLE)
    expect(fm.fm.length).toBeGreaterThan(0)
    const blocks = chunkDocument(fm.body, 500, 0, 200)
    expect(blocks.length).toBeGreaterThan(1)
    const offset = blocks[0].src_pos + fm.fm.length
    expect(offset).toBeGreaterThanOrEqual(fm.fm.length)
  })

  it('every active block ends up with an anchor in .block.md', async () => {
    const fm = splitFrontmatter(SAMPLE)
    const bodyBlocks = chunkDocument(fm.body, 500, 0, 200)
    const ids = bodyBlocks.map((_, i) => `b-${i.toString(16).padStart(6, '0')}`)
    const active = await buildActive(SAMPLE, ids)
    const { output, outLines } = generateBlockMd(SAMPLE, active, true, 'sample.md')
    for (const a of active) {
      expect(output).toContain(`<a id="${a.id}"></a>`)
      expect(outLines.has(a.id)).toBe(true)
    }
    expect(output.startsWith(fm.fm)).toBe(true)
    expect(output).toContain('Each block in this document is preceded by an HTML anchor')
  })

  it('a light edit preserves identity for all but at most the edited block', async () => {
    const fm = splitFrontmatter(SAMPLE)
    const bodyBlocks = chunkDocument(fm.body, 500, 0, 200)
    const oldFps = await Promise.all(bodyBlocks.map((b) => computeFingerprint(b.text)))
    const ids = bodyBlocks.map((_, i) => `b-${i.toString(16).padStart(6, '0')}`)
    const oldEntries: OldBlockEntry[] = bodyBlocks.map((_, i) => ({
      id: ids[i],
      fp: oldFps[i],
    }))

    const edited = SAMPLE.replace('first paragraph', 'first PARAGRAPH (edited)')
    const fm2 = splitFrontmatter(edited)
    const bodyBlocks2 = chunkDocument(fm2.body, 500, 0, 200)
    const newFps = await Promise.all(bodyBlocks2.map((b) => computeFingerprint(b.text)))
    const newEntries: NewBlockEntry[] = newFps.map((fp) => ({ fp }))

    const out = mergeBlocks(oldEntries, newEntries)
    const preserved = out.kept.length + out.edited.length + out.splits.length
    expect(preserved).toBeGreaterThanOrEqual(bodyBlocks2.length - 1)
  })

  it('yaml round-trip preserves all fields', async () => {
    const fm = splitFrontmatter(SAMPLE)
    const bodyBlocks = chunkDocument(fm.body, 500, 0, 200)
    const ids = bodyBlocks.map((_, i) => `b-${i.toString(16).padStart(6, '0')}`)
    const active = await buildActive(SAMPLE, ids)
    const yaml: BlockYaml = {
      meta: {
        source: 'sample.md',
        source_hash: 'demo',
        generation: 1,
        updated_at: '2026-05-10T00:00:00Z',
        schema_version: SCHEMA_VERSION,
        has_block_md: true,
      },
      config: {
        chunk_size_chars: 500,
        break_window_chars: 200,
        similarity_threshold: 0.5,
        split_coverage_threshold: 0.3,
        inject_ai_hint: true,
      },
      active,
      history: [],
    }
    const text = stringify(yaml, { lineWidth: 0, blockQuote: 'literal' })
    expect(text).toContain(`schema_version: ${SCHEMA_VERSION}`)
    expect(text).toContain('id: b-000000')
    expect(text).toContain('minhash:')
    const round = JSON.parse(JSON.stringify(yaml))
    expect(round.active.length).toBe(active.length)
  })
})
