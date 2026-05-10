import { describe, it, expect } from 'vitest'
import { mergeBlocks, type OldBlockEntry, type NewBlockEntry } from './merge'
import { computeFingerprint } from './fingerprint'

async function entry(id: string, text: string): Promise<OldBlockEntry> {
  return { id, fp: await computeFingerprint(text) }
}
async function nblock(text: string): Promise<NewBlockEntry> {
  return { fp: await computeFingerprint(text) }
}

describe('mergeBlocks', () => {
  it('Pass 1: identical hash → kept', async () => {
    const old = [await entry('b-aaaaaa', 'paragraph one'), await entry('b-bbbbbb', 'paragraph two')]
    const nw = [await nblock('paragraph one'), await nblock('paragraph two')]
    const out = mergeBlocks(old, nw)
    expect(out.kept.map((k) => k.oldId).sort()).toEqual(['b-aaaaaa', 'b-bbbbbb'])
    expect(out.edited.length).toBe(0)
    expect(out.fresh.length).toBe(0)
    expect(out.retired.length).toBe(0)
  })

  it('Pass 2: high Jaccard similarity → edited (id inherited)', async () => {
    const old = [await entry('b-aaaaaa', 'the quick brown fox jumps over the lazy dog')]
    const nw  = [await nblock('the quick brown fox jumps over the busy dog')] // edited
    const out = mergeBlocks(old, nw, 0.5)
    expect(out.edited.length).toBe(1)
    expect(out.edited[0].oldId).toBe('b-aaaaaa')
    expect(out.fresh.length).toBe(0)
    expect(out.retired.length).toBe(0)
  })

  it('low similarity → fresh + retired', async () => {
    const old = [await entry('b-aaaaaa', 'completely original content here')]
    const nw  = [await nblock('zzz zzz zzz zzz zzz zzz')]
    const out = mergeBlocks(old, nw, 0.5)
    expect(out.fresh.length).toBe(1)
    expect(out.retired.map((r) => r.oldId)).toEqual(['b-aaaaaa'])
    expect(out.retired[0].replacedBy).toEqual([])
  })

  it('Pass 3: 1 old → 2 new (split). Siblings appear ONLY in splits[].siblings, not in fresh.', async () => {
    const long = 'the quick brown fox jumps over the lazy dog. ' +
                 'a stitch in time saves nine when no one is looking.'
    const half1 = 'the quick brown fox jumps over the lazy dog.'
    const half2 = 'a stitch in time saves nine when no one is looking.'
    const old = [await entry('b-aaaaaa', long)]
    const nw  = [await nblock(half1), await nblock(half2)]
    const out = mergeBlocks(old, nw, 0.95, 0.3) // raise threshold so neither edited path matches
    expect(out.splits.length).toBe(1)
    expect(out.splits[0].oldId).toBe('b-aaaaaa')
    expect(out.splits[0].siblings.length).toBe(1) // the sibling that didn't inherit
    expect(out.fresh.length).toBe(0)              // siblings are NOT also in fresh
    expect(out.retired.length).toBe(0)
  })

  it('Pass 4: 2 old → 1 new (merge). Caller derives retirements from merges[].', async () => {
    const half1 = 'the quick brown fox jumps over the lazy dog.'
    const half2 = 'a stitch in time saves nine when no one is looking.'
    const long  = `${half1} ${half2}`
    const old = [await entry('b-aaaaaa', half1), await entry('b-bbbbbb', half2)]
    const nw  = [await nblock(long)]
    const out = mergeBlocks(old, nw, 0.95, 0.3)
    expect(out.merges.length).toBe(1)
    expect(out.merges[0].oldIds.sort()).toEqual(['b-aaaaaa', 'b-bbbbbb'])
    expect(out.fresh.length).toBe(0) // the merged new block is in `merges`, not `fresh`
    // mergeBlocks does NOT push to retired for merge participants — the
    // caller does that once it has allocated the new block's id. So both
    // old ids are absorbed by `merges` and `retired` stays empty here.
    expect(out.retired.length).toBe(0)
  })

  it('handles identical-content blocks via document-order tiebreak', async () => {
    const old = [
      await entry('b-aaaaaa', '## section'),
      await entry('b-bbbbbb', '## section'),
    ]
    const nw = [await nblock('## section'), await nblock('## section')]
    const out = mergeBlocks(old, nw)
    expect(out.kept.length).toBe(2)
    // First old to first new, second to second
    expect(out.kept[0].oldId).toBe('b-aaaaaa')
    expect(out.kept[0].newIdx).toBe(0)
    expect(out.kept[1].oldId).toBe('b-bbbbbb')
    expect(out.kept[1].newIdx).toBe(1)
  })

  it('reorder preserves ids', async () => {
    const old = [
      await entry('b-aaaaaa', 'paragraph A unique content'),
      await entry('b-bbbbbb', 'paragraph B distinct words'),
    ]
    // swap order
    const nw = [
      await nblock('paragraph B distinct words'),
      await nblock('paragraph A unique content'),
    ]
    const out = mergeBlocks(old, nw)
    expect(out.kept.map((k) => `${k.newIdx}:${k.oldId}`).sort()).toEqual([
      '0:b-bbbbbb', '1:b-aaaaaa',
    ])
  })

  it('empty old → all fresh', async () => {
    const out = mergeBlocks([], [await nblock('a'), await nblock('b')])
    expect(out.fresh.length).toBe(2)
    expect(out.kept.length).toBe(0)
  })

  it('empty new → all retired', async () => {
    const out = mergeBlocks([await entry('b-aaaaaa', 'a')], [])
    expect(out.retired).toEqual([{ oldId: 'b-aaaaaa', replacedBy: [] }])
  })
})
