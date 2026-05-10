import { describe, it, expect } from 'vitest'
import { generateBlockMd, splitFrontmatter } from './inject'
import { chunkDocument } from '../blockchunk/chunker'
import type { ActiveBlock } from './yaml-schema'

/**
 * Verifies the contract between commands.ts (which chunks the body only and
 * offsets src_pos by fm.length) and generateBlockMd (which expects all block
 * src_pos to be valid full-source coordinates pointing into the body).
 *
 * Regression guard: the older flow chunked the FULL source, producing a
 * first block whose src_pos=0 fell inside frontmatter; generateBlockMd's
 * body_pos filter then dropped it, leaving the first block with no anchor.
 */
describe('frontmatter + block injection', () => {
  it('every active block gets an anchor even when source begins with frontmatter', () => {
    const source =
`---
title: Foo
author: bruce
---

# Heading

Body paragraph here.

# Second Heading

More body content.`

    // Simulate the corrected commands.ts flow: chunk the body alone,
    // offset src_pos and src_line by the frontmatter's footprint.
    const fm = splitFrontmatter(source)
    const bodyBlocks = chunkDocument(fm.body, 50, 0, 20)
    const active: ActiveBlock[] = bodyBlocks.map((b, i) => ({
      id: `b-${i.toString(16).padStart(6, '0')}`,
      src_pos: b.src_pos + fm.fm.length,
      src_line: b.src_line + fm.fmLines,
      fingerprint: { hash: '0', length: 1, minhash: '' },
      parents: [],
      created_gen: 1,
    }))

    const { output, outLines } = generateBlockMd(source, active, false, 'doc.md')

    // Every active id should have an anchor and an out_line in the output.
    for (const b of active) {
      expect(output).toContain(`<a id="${b.id}"></a>`)
      expect(outLines.has(b.id)).toBe(true)
    }
    // Frontmatter is preserved verbatim at the top.
    expect(output.startsWith('---\ntitle: Foo\nauthor: bruce\n---\n')).toBe(true)
  })
})
