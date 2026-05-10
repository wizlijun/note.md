# Markdown Block Splitting & Stable Block IDs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a system that assigns stable, edit-resilient block ids to every section of a markdown document so AI tools can cite passages with sub-page precision; back the system with a yaml sidecar that preserves full lineage across edits and a generated `.block.md` artifact with HTML anchors.

**Architecture:** Three layers, each independently testable: (1) `src/lib/blockchunk/` — pure-TS chunking algorithm ported from qmd plus content-fingerprint + 5-pass merge for id stability; (2) `src/lib/blockio/` — yaml read/write, `.block.md` injector, citation parser/resolver; (3) `src/lib/mdblock-hover/` — Svelte gutter overlay for source view and decoration overlay for rich view. A thin command layer in `src/lib/mdblock/` exposes user-facing actions; integration touches `SourceView.svelte`, `RichEditor.svelte`, `SettingsDialog.svelte`, and `App.svelte`.

**Tech Stack:** TypeScript (strict), Svelte 5 runes, Vitest, marked 18 (extension API), `@tauri-apps/plugin-fs` for IO, `yaml` package (v2.x) for serialization, `crypto.subtle` for hashing.

**Spec reference:** `docs/superpowers/specs/2026-05-10-md-block-splitting-design.md`

**Source of algorithm port:** `/Users/bruce/git/qmd/src/store.ts:50-307,2324-2367` and `/Users/bruce/git/qmd/test/store.test.ts:448-940`.

---

## File Structure

```
src/lib/blockchunk/
├── breakpoints.ts            # types + scanBreakPoints + BREAK_PATTERNS
├── breakpoints.test.ts
├── codefences.ts             # findCodeFences, isInsideCodeFence
├── codefences.test.ts
├── chunker.ts                # constants, findBestCutoff, chunkDocumentWith*, chunkDocument, mergeBreakPoints
├── chunker.test.ts
├── fingerprint.ts            # normalize, computeFingerprint, jaccard
├── fingerprint.test.ts
├── id.ts                     # newBlockId
├── id.test.ts
├── merge.ts                  # 5-pass mergeBlocks, MergeOutcome type
└── merge.test.ts

src/lib/blockio/
├── yaml-schema.ts            # TypeScript types for the yaml structure
├── yaml-rw.ts                # readBlockYaml + writeBlockYaml (atomic)
├── yaml-rw.test.ts
├── inject.ts                 # generateBlockMd + frontmatter handling
├── inject.test.ts
├── citation.ts               # CITATION_RE, parseCitation, resolveCitation
└── citation.test.ts

src/lib/mdblock/
├── commands.ts               # cmdMdblockCompute / Refresh / Reset / FollowCitation
├── auto-refresh.ts           # onSave hook
└── settings.ts               # mdblock-specific settings glue

src/lib/mdblock-hover/
├── line-block-map.ts         # active[] → Map<line, blockid>
├── line-block-map.test.ts
├── hover-store.svelte.ts     # per-tab Svelte 5 runes
├── source-gutter.svelte
└── rich-overlay.svelte

src/components/
├── SettingsDialog.svelte     # add Block tab
├── SourceView.svelte         # mount gutter slot
└── RichEditor.svelte         # mount overlay slot + register marked extension

src/styles/
└── editor-base.css           # add .block-citation pill styles
```

---

## Phase 1 — Algorithm Layer (`src/lib/blockchunk/`)

Pure functions, zero IO, zero DOM. Each task in this phase is independently runnable in node/vitest.

### Task 1: Add `yaml` dependency and create blockchunk directory skeleton

**Files:**
- Modify: `package.json`
- Create: `src/lib/blockchunk/.gitkeep`

- [ ] **Step 1: Add `yaml` to dependencies**

Run:

```bash
pnpm add yaml@^2.4
```

Expected: `package.json` `dependencies` now contains `"yaml": "^2.4..."` and `pnpm-lock.yaml` updated.

- [ ] **Step 2: Verify install**

Run: `pnpm install`
Expected: no errors; `node_modules/yaml/package.json` exists.

- [ ] **Step 3: Create directory marker**

```bash
mkdir -p src/lib/blockchunk
touch src/lib/blockchunk/.gitkeep
```

- [ ] **Step 4: Commit**

```bash
git add package.json pnpm-lock.yaml src/lib/blockchunk/.gitkeep
git commit -m "deps: add yaml package; create blockchunk dir"
```

---

### Task 2: Break-point types and scanner

**Files:**
- Create: `src/lib/blockchunk/breakpoints.ts`
- Create: `src/lib/blockchunk/breakpoints.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/blockchunk/breakpoints.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { scanBreakPoints, BREAK_PATTERNS } from './breakpoints'

describe('BREAK_PATTERNS', () => {
  it('exposes h1..h6, codeblock, hr, blank, list, numlist, newline in score order', () => {
    const types = BREAK_PATTERNS.map((p) => p[2])
    expect(types).toEqual([
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'codeblock', 'hr', 'blank', 'list', 'numlist', 'newline',
    ])
  })
})

describe('scanBreakPoints', () => {
  it('detects h1 at score 100', () => {
    const text = 'Intro\n# Heading 1\nMore text'
    const breaks = scanBreakPoints(text)
    const h1 = breaks.find((b) => b.type === 'h1')
    expect(h1).toBeDefined()
    expect(h1!.score).toBe(100)
    expect(h1!.pos).toBe(5)
  })

  it('detects multiple heading levels with descending scores', () => {
    const text = 'Text\n# H1\n## H2\n### H3\nMore'
    const breaks = scanBreakPoints(text)
    expect(breaks.find((b) => b.type === 'h1')!.score).toBe(100)
    expect(breaks.find((b) => b.type === 'h2')!.score).toBe(90)
    expect(breaks.find((b) => b.type === 'h3')!.score).toBe(80)
  })

  it('detects code block fence at score 80', () => {
    const text = 'Before\n```js\ncode\n```\nAfter'
    const breaks = scanBreakPoints(text).filter((b) => b.type === 'codeblock')
    expect(breaks.length).toBe(2)
    expect(breaks[0].score).toBe(80)
  })

  it('detects horizontal rule at score 60', () => {
    const text = 'Text\n---\nMore'
    expect(scanBreakPoints(text).find((b) => b.type === 'hr')!.score).toBe(60)
  })

  it('detects blank line at score 20', () => {
    const text = 'A.\n\nB.'
    expect(scanBreakPoints(text).find((b) => b.type === 'blank')!.score).toBe(20)
  })

  it('detects list and numlist at score 5', () => {
    const text = 'Intro\n- Item\n- Item2\n1. Numbered'
    const lists = scanBreakPoints(text).filter((b) => b.type === 'list')
    const nums = scanBreakPoints(text).filter((b) => b.type === 'numlist')
    expect(lists.length).toBe(2)
    expect(nums.length).toBe(1)
    expect(lists[0].score).toBe(5)
    expect(nums[0].score).toBe(5)
  })

  it('detects plain newline at score 1', () => {
    const text = 'Line1\nLine2\nLine3'
    const newlines = scanBreakPoints(text).filter((b) => b.type === 'newline')
    expect(newlines.length).toBe(2)
    expect(newlines[0].score).toBe(1)
  })

  it('returns breaks sorted by position', () => {
    const text = 'A\n# B\n\nC\n## D'
    const breaks = scanBreakPoints(text)
    for (let i = 1; i < breaks.length; i++) {
      expect(breaks[i].pos).toBeGreaterThan(breaks[i - 1].pos)
    }
  })

  it('keeps highest-scoring pattern at the same position', () => {
    const text = 'Text\n# Heading'
    const atFour = scanBreakPoints(text).filter((b) => b.pos === 4)
    expect(atFour.length).toBe(1)
    expect(atFour[0].type).toBe('h1')
    expect(atFour[0].score).toBe(100)
  })
})
```

- [ ] **Step 2: Run tests to confirm failure**

Run: `pnpm test --run src/lib/blockchunk/breakpoints.test.ts`
Expected: FAIL — `Cannot find module './breakpoints'`.

- [ ] **Step 3: Write implementation**

Create `src/lib/blockchunk/breakpoints.ts`:

```ts
/**
 * A potential split position in a markdown document, with a score that
 * reflects how clean/structural the position is. Ported from qmd's
 * src/store.ts BreakPoint interface.
 */
export interface BreakPoint {
  pos: number
  score: number
  type: string
}

/**
 * Patterns ordered by score (highest first). When multiple patterns match
 * the same position, the higher score wins; this is how `\n#` is recorded
 * as 'h1' (100) instead of 'newline' (1).
 */
export const BREAK_PATTERNS: [RegExp, number, string][] = [
  [/\n#{1}(?!#)/g, 100, 'h1'],
  [/\n#{2}(?!#)/g, 90, 'h2'],
  [/\n#{3}(?!#)/g, 80, 'h3'],
  [/\n#{4}(?!#)/g, 70, 'h4'],
  [/\n#{5}(?!#)/g, 60, 'h5'],
  [/\n#{6}(?!#)/g, 50, 'h6'],
  [/\n```/g, 80, 'codeblock'],
  [/\n(?:---|\*\*\*|___)\s*\n/g, 60, 'hr'],
  [/\n\n+/g, 20, 'blank'],
  [/\n[-*]\s/g, 5, 'list'],
  [/\n\d+\.\s/g, 5, 'numlist'],
  [/\n/g, 1, 'newline'],
]

/**
 * Scan `text` for all candidate break points. When more than one pattern
 * matches the same position, the higher-scoring one wins. Result is sorted
 * by position ascending.
 */
export function scanBreakPoints(text: string): BreakPoint[] {
  const seen = new Map<number, BreakPoint>()
  for (const [pattern, score, type] of BREAK_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const pos = match.index!
      const existing = seen.get(pos)
      if (!existing || score > existing.score) {
        seen.set(pos, { pos, score, type })
      }
    }
  }
  return Array.from(seen.values()).sort((a, b) => a.pos - b.pos)
}
```

- [ ] **Step 4: Run tests to confirm pass**

Run: `pnpm test --run src/lib/blockchunk/breakpoints.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/blockchunk/breakpoints.ts src/lib/blockchunk/breakpoints.test.ts
git commit -m "feat(blockchunk): break-point types and scanner"
```

---

### Task 3: Code-fence detection

**Files:**
- Create: `src/lib/blockchunk/codefences.ts`
- Create: `src/lib/blockchunk/codefences.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/blockchunk/codefences.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  findCodeFences,
  isInsideCodeFence,
  type CodeFenceRegion,
} from './codefences'

describe('findCodeFences', () => {
  it('finds a single closed fence', () => {
    const text = 'Before\n```js\ncode\n```\nAfter'
    const fences = findCodeFences(text)
    expect(fences.length).toBe(1)
    expect(fences[0].start).toBe(6)
    expect(fences[0].end).toBe(21)
  })

  it('finds multiple fences', () => {
    const text = 'A\n```\nx\n```\nB\n```\ny\n```\nC'
    expect(findCodeFences(text).length).toBe(2)
  })

  it('treats unclosed fence as extending to EOF', () => {
    const text = 'Before\n```\nunclosed code'
    const fences = findCodeFences(text)
    expect(fences.length).toBe(1)
    expect(fences[0].end).toBe(text.length)
  })

  it('returns empty array when there are no fences', () => {
    expect(findCodeFences('plain text').length).toBe(0)
  })
})

describe('isInsideCodeFence', () => {
  const fences: CodeFenceRegion[] = [{ start: 10, end: 30 }]

  it('returns true strictly inside', () => {
    expect(isInsideCodeFence(15, fences)).toBe(true)
    expect(isInsideCodeFence(20, fences)).toBe(true)
  })

  it('returns false outside', () => {
    expect(isInsideCodeFence(5, fences)).toBe(false)
    expect(isInsideCodeFence(35, fences)).toBe(false)
  })

  it('returns false at the boundaries', () => {
    expect(isInsideCodeFence(10, fences)).toBe(false)
    expect(isInsideCodeFence(30, fences)).toBe(false)
  })

  it('handles multiple fences', () => {
    const fs: CodeFenceRegion[] = [
      { start: 10, end: 30 },
      { start: 50, end: 70 },
    ]
    expect(isInsideCodeFence(20, fs)).toBe(true)
    expect(isInsideCodeFence(60, fs)).toBe(true)
    expect(isInsideCodeFence(40, fs)).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests to confirm failure**

Run: `pnpm test --run src/lib/blockchunk/codefences.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write implementation**

Create `src/lib/blockchunk/codefences.ts`:

```ts
/**
 * A region delimited by ``` fences in markdown. Splitting MUST NOT happen
 * inside such a region (would break code rendering and visual integrity).
 */
export interface CodeFenceRegion {
  start: number
  end: number
}

/**
 * Pair up `\n```` markers into open/close regions. An unclosed fence is
 * treated as extending to the end of the document.
 */
export function findCodeFences(text: string): CodeFenceRegion[] {
  const regions: CodeFenceRegion[] = []
  const fencePattern = /\n```/g
  let inFence = false
  let fenceStart = 0
  for (const match of text.matchAll(fencePattern)) {
    if (!inFence) {
      fenceStart = match.index!
      inFence = true
    } else {
      regions.push({ start: fenceStart, end: match.index! + match[0].length })
      inFence = false
    }
  }
  if (inFence) regions.push({ start: fenceStart, end: text.length })
  return regions
}

/**
 * Strict-interior containment check. Boundary positions are NOT inside.
 */
export function isInsideCodeFence(pos: number, fences: CodeFenceRegion[]): boolean {
  return fences.some((f) => pos > f.start && pos < f.end)
}
```

- [ ] **Step 4: Run tests to confirm pass**

Run: `pnpm test --run src/lib/blockchunk/codefences.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/blockchunk/codefences.ts src/lib/blockchunk/codefences.test.ts
git commit -m "feat(blockchunk): code-fence region detection"
```

---

### Task 4: Best-cutoff scoring with squared decay

**Files:**
- Create: `src/lib/blockchunk/chunker.ts` (initial — only constants and findBestCutoff)
- Create: `src/lib/blockchunk/chunker.test.ts` (initial — only findBestCutoff tests)

- [ ] **Step 1: Write the failing tests**

Create `src/lib/blockchunk/chunker.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  CHUNK_SIZE_TOKENS,
  CHUNK_OVERLAP_TOKENS,
  CHUNK_SIZE_CHARS,
  CHUNK_WINDOW_CHARS,
  findBestCutoff,
} from './chunker'
import type { BreakPoint } from './breakpoints'
import type { CodeFenceRegion } from './codefences'

describe('chunk constants', () => {
  it('uses the spec values: 600 tokens / 0 overlap / 2400 chars / 800 window', () => {
    expect(CHUNK_SIZE_TOKENS).toBe(600)
    expect(CHUNK_OVERLAP_TOKENS).toBe(0)
    expect(CHUNK_SIZE_CHARS).toBe(2400)
    expect(CHUNK_WINDOW_CHARS).toBe(800)
  })
})

describe('findBestCutoff', () => {
  it('prefers higher-scoring break points', () => {
    const bp: BreakPoint[] = [
      { pos: 100, score: 1, type: 'newline' },
      { pos: 150, score: 100, type: 'h1' },
      { pos: 180, score: 20, type: 'blank' },
    ]
    expect(findBestCutoff(bp, 200, 100, 0.7)).toBe(150)
  })

  it('h2 at window edge beats blank near target due to squared decay', () => {
    const bp: BreakPoint[] = [
      { pos: 100, score: 90, type: 'h2' },
      { pos: 195, score: 20, type: 'blank' },
    ]
    expect(findBestCutoff(bp, 200, 100, 0.7)).toBe(100)
  })

  it('high score easily overcomes distance', () => {
    const bp: BreakPoint[] = [
      { pos: 150, score: 100, type: 'h1' },
      { pos: 195, score: 1, type: 'newline' },
    ]
    expect(findBestCutoff(bp, 200, 100, 0.7)).toBe(150)
  })

  it('returns target when no break points are in window', () => {
    const bp: BreakPoint[] = [{ pos: 10, score: 100, type: 'h1' }]
    expect(findBestCutoff(bp, 200, 100, 0.7)).toBe(200)
  })

  it('skips break points that fall inside code fences', () => {
    const bp: BreakPoint[] = [
      { pos: 150, score: 100, type: 'h1' },
      { pos: 180, score: 20, type: 'blank' },
    ]
    const fences: CodeFenceRegion[] = [{ start: 140, end: 160 }]
    expect(findBestCutoff(bp, 200, 100, 0.7, fences)).toBe(180)
  })

  it('handles empty break-point array', () => {
    expect(findBestCutoff([], 200, 100, 0.7)).toBe(200)
  })
})
```

- [ ] **Step 2: Run tests to confirm failure**

Run: `pnpm test --run src/lib/blockchunk/chunker.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write implementation**

Create `src/lib/blockchunk/chunker.ts`:

```ts
import type { BreakPoint } from './breakpoints'
import { isInsideCodeFence, type CodeFenceRegion } from './codefences'

/**
 * Chunking constants. Differences from qmd:
 *  - Smaller target (600 vs 900 tokens) for finer AI attribution
 *  - Zero overlap (qmd uses 15% for retrieval recall; we want 1:1 block-to-id)
 */
export const CHUNK_SIZE_TOKENS = 600
export const CHUNK_OVERLAP_TOKENS = 0
export const CHUNK_SIZE_CHARS = CHUNK_SIZE_TOKENS * 4 // ~4 chars/token
export const CHUNK_OVERLAP_CHARS = CHUNK_OVERLAP_TOKENS * 4
export const CHUNK_WINDOW_TOKENS = 200
export const CHUNK_WINDOW_CHARS = CHUNK_WINDOW_TOKENS * 4

/**
 * Pick the best position to cut at, walking back up to `windowChars` from
 * `targetCharPos`. Each candidate's score is multiplied by a squared-distance
 * decay (gentle near target, steep at the window edge):
 *
 *   normalizedDist = (target - pos) / windowChars
 *   multiplier     = 1 - normalizedDist² × decayFactor
 *
 * Result: a far-away h1 (score 100) easily beats a nearby blank line (20),
 * but a low-quality break right at the target edge will only beat candidates
 * far back.
 *
 * Break points inside code fences are skipped so we never split a code block.
 */
export function findBestCutoff(
  breakPoints: BreakPoint[],
  targetCharPos: number,
  windowChars: number = CHUNK_WINDOW_CHARS,
  decayFactor: number = 0.7,
  codeFences: CodeFenceRegion[] = [],
): number {
  const windowStart = targetCharPos - windowChars
  let bestScore = -1
  let bestPos = targetCharPos
  for (const bp of breakPoints) {
    if (bp.pos < windowStart) continue
    if (bp.pos > targetCharPos) break // sorted; safe to stop
    if (isInsideCodeFence(bp.pos, codeFences)) continue
    const distance = targetCharPos - bp.pos
    const normalizedDist = distance / windowChars
    const multiplier = 1.0 - normalizedDist * normalizedDist * decayFactor
    const finalScore = bp.score * multiplier
    if (finalScore > bestScore) {
      bestScore = finalScore
      bestPos = bp.pos
    }
  }
  return bestPos
}
```

- [ ] **Step 4: Run tests to confirm pass**

Run: `pnpm test --run src/lib/blockchunk/chunker.test.ts`
Expected: all 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/blockchunk/chunker.ts src/lib/blockchunk/chunker.test.ts
git commit -m "feat(blockchunk): findBestCutoff with squared distance decay"
```

---

### Task 5: Document chunking core (chunkDocument + mergeBreakPoints)

**Files:**
- Modify: `src/lib/blockchunk/chunker.ts` (append types and functions)
- Modify: `src/lib/blockchunk/chunker.test.ts` (append integration tests)

- [ ] **Step 1: Append failing tests**

Append to `src/lib/blockchunk/chunker.test.ts`:

```ts
import {
  chunkDocument,
  chunkDocumentWithBreakPoints,
  mergeBreakPoints,
  type Block,
} from './chunker'
import { scanBreakPoints } from './breakpoints'
import { findCodeFences } from './codefences'

describe('chunkDocument', () => {
  it('returns one block for short content', () => {
    const blocks = chunkDocument('small content', 1000, 0)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].text).toBe('small content')
    expect(blocks[0].src_pos).toBe(0)
    expect(blocks[0].src_line).toBe(1)
  })

  it('splits long content into multiple blocks', () => {
    const blocks = chunkDocument('A'.repeat(10000), 1000, 0)
    expect(blocks.length).toBeGreaterThan(1)
    for (let i = 1; i < blocks.length; i++) {
      expect(blocks[i].src_pos).toBeGreaterThan(blocks[i - 1].src_pos)
    }
  })

  it('produces non-overlapping blocks when overlapChars=0', () => {
    const blocks = chunkDocument('A'.repeat(3000), 1000, 0)
    for (let i = 1; i < blocks.length; i++) {
      const prevEnd = blocks[i - 1].src_pos + blocks[i - 1].text.length
      expect(blocks[i].src_pos).toBe(prevEnd)
    }
  })

  it('prefers heading boundaries over arbitrary breaks', () => {
    const section1 = 'Introduction text. '.repeat(70)
    const section2 = 'Main content text. '.repeat(50)
    const content = `${section1}\n# Main Section\n${section2}`
    const blocks = chunkDocument(content, 2000, 0, 800)
    const headingPos = content.indexOf('\n# Main Section')
    expect(blocks.length).toBeGreaterThanOrEqual(2)
    expect(blocks[0].text.length).toBe(headingPos)
  })

  it('does not split inside fenced code blocks', () => {
    const before = 'Some intro. '.repeat(30)
    const fence = '```typescript\n' + 'const x = 1;\n'.repeat(100) + '```\n'
    const after = 'After code text. '.repeat(30)
    const blocks = chunkDocument(before + fence + after, 1000, 0, 400)
    expect(blocks.length).toBeGreaterThan(1)
    // Each chunk should contain a balanced number of fence markers (or end at EOF)
    for (let i = 0; i < blocks.length - 1; i++) {
      const fences = (blocks[i].text.match(/```/g) || []).length
      expect(fences % 2).toBe(0)
    }
  })

  it('computes correct src_line for each block (1-based)', () => {
    const text = 'line1\nline2\nline3\n# Heading\nline5\nline6'
    const blocks = chunkDocument(text, 20, 0, 10)
    for (const b of blocks) {
      const expectedLine = text.slice(0, b.src_pos).split('\n').length
      expect(b.src_line).toBe(expectedLine)
    }
  })

  it('handles UTF-8 multi-byte characters without splitting them', () => {
    const blocks = chunkDocument('こんにちは世界'.repeat(500), 1000, 0)
    for (const b of blocks) {
      expect(() => new TextEncoder().encode(b.text)).not.toThrow()
    }
  })
})

describe('chunkDocumentWithBreakPoints', () => {
  it('is a no-op for content shorter than maxChars', () => {
    const result = chunkDocumentWithBreakPoints('short', [], [], 100, 0, 50)
    expect(result).toEqual([{ text: 'short', pos: 0 }])
  })
})

describe('mergeBreakPoints', () => {
  it('keeps the highest score at each position', () => {
    const a: BreakPoint[] = [
      { pos: 10, score: 20, type: 'blank' },
      { pos: 50, score: 1, type: 'newline' },
    ]
    const b: BreakPoint[] = [
      { pos: 10, score: 90, type: 'astFunc' },
      { pos: 100, score: 100, type: 'astClass' },
    ]
    const merged = mergeBreakPoints(a, b)
    expect(merged.length).toBe(3)
    expect(merged.find((m) => m.pos === 10)!.score).toBe(90)
  })

  it('returns sorted output', () => {
    const merged = mergeBreakPoints(
      [{ pos: 50, score: 1, type: 'a' }],
      [{ pos: 10, score: 1, type: 'b' }, { pos: 100, score: 1, type: 'c' }],
    )
    expect(merged.map((m) => m.pos)).toEqual([10, 50, 100])
  })
})
```

- [ ] **Step 2: Run tests to confirm failure**

Run: `pnpm test --run src/lib/blockchunk/chunker.test.ts`
Expected: FAIL — `chunkDocument` / `mergeBreakPoints` / `Block` not exported.

- [ ] **Step 3: Append implementation**

Append to `src/lib/blockchunk/chunker.ts`:

```ts
import { scanBreakPoints } from './breakpoints'
import { findCodeFences } from './codefences'

/**
 * One result of chunking. `src_pos` is the character offset in the source;
 * `src_line` is the 1-based line containing that offset.
 */
export interface Block {
  text: string
  src_pos: number
  src_line: number
}

/**
 * Pure helper that takes pre-scanned break points and code-fence regions and
 * walks the content greedily, choosing the best cut at each step.
 */
export function chunkDocumentWithBreakPoints(
  content: string,
  breakPoints: BreakPoint[],
  codeFences: CodeFenceRegion[],
  maxChars: number = CHUNK_SIZE_CHARS,
  overlapChars: number = CHUNK_OVERLAP_CHARS,
  windowChars: number = CHUNK_WINDOW_CHARS,
): { text: string; pos: number }[] {
  if (content.length <= maxChars) {
    return [{ text: content, pos: 0 }]
  }
  const chunks: { text: string; pos: number }[] = []
  let charPos = 0
  while (charPos < content.length) {
    const targetEndPos = Math.min(charPos + maxChars, content.length)
    let endPos = targetEndPos
    if (endPos < content.length) {
      const bestCutoff = findBestCutoff(
        breakPoints,
        targetEndPos,
        windowChars,
        0.7,
        codeFences,
      )
      if (bestCutoff > charPos && bestCutoff <= targetEndPos) endPos = bestCutoff
    }
    if (endPos <= charPos) endPos = Math.min(charPos + maxChars, content.length)
    chunks.push({ text: content.slice(charPos, endPos), pos: charPos })
    if (endPos >= content.length) break
    charPos = endPos - overlapChars
    const last = chunks.at(-1)!
    if (charPos <= last.pos) charPos = endPos
  }
  return chunks
}

/**
 * Top-level entry: scan + chunk + attach `src_line`. Returns `Block[]`.
 */
export function chunkDocument(
  content: string,
  maxChars: number = CHUNK_SIZE_CHARS,
  overlapChars: number = CHUNK_OVERLAP_CHARS,
  windowChars: number = CHUNK_WINDOW_CHARS,
): Block[] {
  const breakPoints = scanBreakPoints(content)
  const codeFences = findCodeFences(content)
  const raw = chunkDocumentWithBreakPoints(
    content, breakPoints, codeFences,
    maxChars, overlapChars, windowChars,
  )
  return raw.map((c) => ({
    text: c.text,
    src_pos: c.pos,
    src_line: lineOf(content, c.pos),
  }))
}

function lineOf(content: string, pos: number): number {
  // 1-based line number containing `pos`. \n at exactly `pos` belongs to the
  // line that starts AT pos+1 only if pos is the line-terminator; we want the
  // line containing pos, so count the newlines strictly before it.
  let line = 1
  for (let i = 0; i < pos; i++) if (content.charCodeAt(i) === 10) line++
  return line
}

/**
 * Merge two break-point arrays, keeping the highest score at each position.
 * Sorted by position. Currently used only for test parity; reserved for
 * future AST/extension break sources.
 */
export function mergeBreakPoints(a: BreakPoint[], b: BreakPoint[]): BreakPoint[] {
  const seen = new Map<number, BreakPoint>()
  for (const bp of a) {
    const e = seen.get(bp.pos)
    if (!e || bp.score > e.score) seen.set(bp.pos, bp)
  }
  for (const bp of b) {
    const e = seen.get(bp.pos)
    if (!e || bp.score > e.score) seen.set(bp.pos, bp)
  }
  return Array.from(seen.values()).sort((a, b) => a.pos - b.pos)
}
```

Update the import block at the top of `chunker.ts` so `BreakPoint` is imported (already is from earlier task). Make sure the file compiles without circular issues — `BreakPoint` and `CodeFenceRegion` come from sibling files and are already imported.

- [ ] **Step 4: Run tests to confirm pass**

Run: `pnpm test --run src/lib/blockchunk/chunker.test.ts`
Expected: all tests pass (initial 7 from task 4 + 11 new = 18 total).

- [ ] **Step 5: Commit**

```bash
git add src/lib/blockchunk/chunker.ts src/lib/blockchunk/chunker.test.ts
git commit -m "feat(blockchunk): chunkDocument with src_line + mergeBreakPoints"
```

---

### Task 6: Content fingerprinting (hash + Jaccard)

**Files:**
- Create: `src/lib/blockchunk/fingerprint.ts`
- Create: `src/lib/blockchunk/fingerprint.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/blockchunk/fingerprint.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  normalizeText,
  computeFingerprint,
  jaccard,
} from './fingerprint'

describe('normalizeText', () => {
  it('lowercases', () => {
    expect(normalizeText('Hello')).toBe('hello')
  })

  it('collapses runs of whitespace to single space', () => {
    expect(normalizeText('a    b\t\tc')).toBe('a b c')
  })

  it('trims edges', () => {
    expect(normalizeText('  hi  ')).toBe('hi')
  })

  it('preserves structural markers (#, -, >)', () => {
    expect(normalizeText('# Heading')).toBe('# heading')
    expect(normalizeText('- item')).toBe('- item')
    expect(normalizeText('> quote')).toBe('> quote')
  })

  it('treats CRLF and LF the same', () => {
    expect(normalizeText('a\r\nb')).toBe(normalizeText('a\nb'))
  })
})

describe('computeFingerprint', () => {
  it('returns identical hash for identical text', async () => {
    const a = await computeFingerprint('hello world')
    const b = await computeFingerprint('hello world')
    expect(a.hash).toBe(b.hash)
    expect(a.length).toBe(b.length)
    expect(a.shingles).toBe(b.shingles)
  })

  it('returns identical hash for whitespace/case-equivalent text', async () => {
    const a = await computeFingerprint('  Hello   World ')
    const b = await computeFingerprint('hello world')
    expect(a.hash).toBe(b.hash)
  })

  it('hash is 12 hex chars', async () => {
    const fp = await computeFingerprint('anything')
    expect(fp.hash).toMatch(/^[0-9a-f]{12}$/)
  })

  it('length is normalized character count', async () => {
    const fp = await computeFingerprint('  hi  ')
    expect(fp.length).toBe(2)
  })
})

describe('jaccard', () => {
  it('returns 1.0 for identical fingerprints', async () => {
    const a = await computeFingerprint('the quick brown fox jumps over the lazy dog')
    const b = await computeFingerprint('the quick brown fox jumps over the lazy dog')
    expect(jaccard(a, b)).toBeCloseTo(1.0, 5)
  })

  it('returns 0.0 for fully disjoint fingerprints', async () => {
    const a = await computeFingerprint('aaaaaaaaaaaaaaaaa')
    const b = await computeFingerprint('zzzzzzzzzzzzzzzzz')
    expect(jaccard(a, b)).toBeCloseTo(0.0, 5)
  })

  it('returns a value between 0 and 1 for partial overlap', async () => {
    const a = await computeFingerprint('the quick brown fox jumps over the lazy dog')
    const b = await computeFingerprint('the quick brown fox runs over the busy dog')
    const sim = jaccard(a, b)
    expect(sim).toBeGreaterThan(0.3)
    expect(sim).toBeLessThan(1.0)
  })
})
```

- [ ] **Step 2: Run tests to confirm failure**

Run: `pnpm test --run src/lib/blockchunk/fingerprint.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write implementation**

Create `src/lib/blockchunk/fingerprint.ts`:

```ts
/**
 * Compact representation of a block's content used to detect identity across
 * edits. `hash` is the fast path (untouched blocks); `shingles` enables
 * Jaccard similarity for "edited" blocks.
 */
export interface BlockFingerprint {
  hash: string       // SHA-256 of normalized text, truncated to 12 hex chars
  shingles: string   // sorted, '|'-joined 5-gram set of normalized text
  length: number     // length(normalizedText)
}

/**
 * Lowercase + collapse whitespace + trim. Structural markdown markers (#, -,
 * >) are kept because they carry block-type information and help the
 * matcher distinguish a heading from a paragraph that happens to share words.
 */
export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim()
}

const SHINGLE_K = 5

function shingleSet(normalized: string): Set<string> {
  const out = new Set<string>()
  if (normalized.length < SHINGLE_K) {
    if (normalized.length > 0) out.add(normalized)
    return out
  }
  for (let i = 0; i <= normalized.length - SHINGLE_K; i++) {
    out.add(normalized.slice(i, i + SHINGLE_K))
  }
  return out
}

async function sha256Hex(text: string, chars: number): Promise<string> {
  const data = new TextEncoder().encode(text)
  const buf = await crypto.subtle.digest('SHA-256', data)
  const arr = Array.from(new Uint8Array(buf))
  return arr.map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, chars)
}

export async function computeFingerprint(text: string): Promise<BlockFingerprint> {
  const norm = normalizeText(text)
  const hash = await sha256Hex(norm, 12)
  const shingles = Array.from(shingleSet(norm)).sort().join('|')
  return { hash, shingles, length: norm.length }
}

/**
 * Jaccard similarity over the 5-gram shingle sets of two fingerprints.
 * O(|A|+|B|) using the serialized sorted strings.
 */
export function jaccard(a: BlockFingerprint, b: BlockFingerprint): number {
  if (a.shingles === '' && b.shingles === '') return 1.0
  if (a.shingles === '' || b.shingles === '') return 0.0
  const setA = new Set(a.shingles.split('|'))
  const setB = new Set(b.shingles.split('|'))
  let inter = 0
  for (const s of setA) if (setB.has(s)) inter++
  const union = setA.size + setB.size - inter
  return union === 0 ? 0 : inter / union
}
```

- [ ] **Step 4: Run tests to confirm pass**

Run: `pnpm test --run src/lib/blockchunk/fingerprint.test.ts`
Expected: all 13 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/blockchunk/fingerprint.ts src/lib/blockchunk/fingerprint.test.ts
git commit -m "feat(blockchunk): content fingerprint with SHA-256 hash + 5-gram Jaccard"
```

---

### Task 7: ID allocator with collision detection

**Files:**
- Create: `src/lib/blockchunk/id.ts`
- Create: `src/lib/blockchunk/id.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/blockchunk/id.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { newBlockId, BLOCK_ID_RE } from './id'

describe('BLOCK_ID_RE', () => {
  it('matches "b-" + 6 lowercase hex', () => {
    expect(BLOCK_ID_RE.test('b-7f3a9c')).toBe(true)
    expect(BLOCK_ID_RE.test('b-ABCDEF')).toBe(false) // uppercase rejected
    expect(BLOCK_ID_RE.test('b-12345')).toBe(false)  // too short
    expect(BLOCK_ID_RE.test('b-1234567')).toBe(false) // too long
    expect(BLOCK_ID_RE.test('a-123456')).toBe(false) // wrong prefix
  })
})

describe('newBlockId', () => {
  it('returns a BLOCK_ID_RE-matching id', () => {
    const id = newBlockId(new Set())
    expect(BLOCK_ID_RE.test(id)).toBe(true)
  })

  it('does not collide with reserved set', () => {
    const reserved = new Set<string>()
    for (let i = 0; i < 100; i++) reserved.add(newBlockId(reserved).slice(0)) // accumulate
    // After 100 generations, the set is dense for that subspace; ensure each
    // newly returned id was not already in the set when allocated.
    expect(reserved.size).toBe(100)
  })

  it('throws after 3 retries when the space is exhausted (synthetic)', () => {
    // Pre-fill a Set that "covers" any possible new id by mocking. Easiest:
    // pass a Proxy-Set whose .has() always returns true.
    const everFull = {
      has: (_: string) => true,
      add: (_: string) => everFull,
    } as unknown as Set<string>
    expect(() => newBlockId(everFull)).toThrow(/exhausted/i)
  })
})
```

- [ ] **Step 2: Run tests to confirm failure**

Run: `pnpm test --run src/lib/blockchunk/id.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write implementation**

Create `src/lib/blockchunk/id.ts`:

```ts
/** Strict regex for a block id: `b-` + 6 lowercase hex chars. */
export const BLOCK_ID_RE = /^b-[0-9a-f]{6}$/

const HEX = '0123456789abcdef'

function randomHex6(): string {
  // Use crypto for strong randomness so the 24 bits are uniform.
  const buf = new Uint8Array(3)
  crypto.getRandomValues(buf)
  let out = ''
  for (const byte of buf) out += HEX[byte >> 4] + HEX[byte & 0x0f]
  return out
}

/**
 * Allocate a fresh block id that is not in `reservedIds`. Caller should pass
 * the union of currently-active and historically-retired ids.
 *
 * 24-bit space (16M possibilities) makes accidental collision essentially
 * impossible for any single document. We retry up to 3 times for paranoia.
 */
export function newBlockId(reservedIds: Set<string>): string {
  for (let i = 0; i < 3; i++) {
    const id = `b-${randomHex6()}`
    if (!reservedIds.has(id)) return id
  }
  throw new Error('newBlockId: id space exhausted (3 collisions in a row)')
}
```

- [ ] **Step 4: Run tests to confirm pass**

Run: `pnpm test --run src/lib/blockchunk/id.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/blockchunk/id.ts src/lib/blockchunk/id.test.ts
git commit -m "feat(blockchunk): block id allocator with collision retry"
```

---

### Task 8: 5-pass merge algorithm

**Files:**
- Create: `src/lib/blockchunk/merge.ts`
- Create: `src/lib/blockchunk/merge.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/blockchunk/merge.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { mergeBlocks, type OldBlockEntry, type NewBlockEntry } from './merge'
import { computeFingerprint } from './fingerprint'

async function entry(id: string, text: string): Promise<OldBlockEntry> {
  return { id, fp: await computeFingerprint(text), text }
}
async function nblock(text: string): Promise<NewBlockEntry> {
  return { fp: await computeFingerprint(text), text }
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

  it('Pass 3: 1 old → 2 new (split)', async () => {
    const long = 'the quick brown fox jumps over the lazy dog. ' +
                 'a stitch in time saves nine when no one is looking.'
    const half1 = 'the quick brown fox jumps over the lazy dog.'
    const half2 = 'a stitch in time saves nine when no one is looking.'
    const old = [await entry('b-aaaaaa', long)]
    const nw  = [await nblock(half1), await nblock(half2)]
    const out = mergeBlocks(old, nw, 0.95, 0.3) // raise threshold so neither edited path matches
    expect(out.splits.length).toBe(1)
    expect(out.splits[0].oldId).toBe('b-aaaaaa')
    expect(out.fresh.length).toBe(1) // the sibling that didn't inherit
    expect(out.retired.length).toBe(0)
  })

  it('Pass 4: 2 old → 1 new (merge)', async () => {
    const half1 = 'the quick brown fox jumps over the lazy dog.'
    const half2 = 'a stitch in time saves nine when no one is looking.'
    const long  = `${half1} ${half2}`
    const old = [await entry('b-aaaaaa', half1), await entry('b-bbbbbb', half2)]
    const nw  = [await nblock(long)]
    const out = mergeBlocks(old, nw, 0.95, 0.3)
    expect(out.merges.length).toBe(1)
    expect(out.merges[0].oldIds.sort()).toEqual(['b-aaaaaa', 'b-bbbbbb'])
    expect(out.fresh.length).toBe(0) // the merged new block is in `merges`, not `fresh`
    expect(out.retired.length).toBe(2)
    expect(out.retired.every((r) => r.replacedBy.length === 1)).toBe(true)
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
```

- [ ] **Step 2: Run tests to confirm failure**

Run: `pnpm test --run src/lib/blockchunk/merge.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write implementation**

Create `src/lib/blockchunk/merge.ts`:

```ts
import type { BlockFingerprint } from './fingerprint'
import { jaccard } from './fingerprint'

export interface OldBlockEntry { id: string; fp: BlockFingerprint; text: string }
export interface NewBlockEntry  { fp: BlockFingerprint; text: string }

export interface MergeOutcome {
  kept:    { newIdx: number; oldId: string }[]
  edited:  { newIdx: number; oldId: string; similarity: number }[]
  splits:  { newIdx: number; oldId: string; siblings: number[] }[]
  merges:  { newIdx: number; oldIds: string[] }[]
  fresh:   { newIdx: number }[]
  retired: { oldId: string; replacedBy: string[] }[]
}

const TINY_BLOCK_LEN = 50

/**
 * 5-pass merge:
 *   1. exact hash equality → kept
 *   2. Jaccard ≥ threshold (1:1) → edited (id inherited)
 *   3. one old maps to 2+ new with ≥ splitCoverage → split (one sibling
 *      inherits id; the rest get fresh ids with parents=[oldId])
 *   4. multiple old map to one new with ≥ splitCoverage → merge (all old
 *      retire; new gets fresh id with parents=[...])
 *   5. residue: unmatched old → retired (deleted); unmatched new → fresh
 *
 * Lineage on the new block (carried by the caller, not by this function):
 *   - kept/edited: parents=[]
 *   - splits.siblings (the non-inheriting new entries): parents=[oldId]
 *   - merges: parents=oldIds
 *   - fresh: parents=[]
 */
export function mergeBlocks(
  oldBlocks: OldBlockEntry[],
  newBlocks: NewBlockEntry[],
  threshold = 0.5,
  splitCoverage = 0.3,
): MergeOutcome {
  const out: MergeOutcome = {
    kept: [], edited: [], splits: [], merges: [], fresh: [], retired: [],
  }

  const oldUsed = new Set<number>()
  const newUsed = new Set<number>()

  // ---- Pass 1: exact hash, document order tiebreak ----
  // For each old in order, find the first un-used new with same hash.
  for (let oi = 0; oi < oldBlocks.length; oi++) {
    if (oldUsed.has(oi)) continue
    const oh = oldBlocks[oi].fp.hash
    for (let ni = 0; ni < newBlocks.length; ni++) {
      if (newUsed.has(ni)) continue
      if (newBlocks[ni].fp.hash === oh) {
        out.kept.push({ newIdx: ni, oldId: oldBlocks[oi].id })
        oldUsed.add(oi); newUsed.add(ni)
        break
      }
    }
  }

  // ---- Pass 2: Jaccard ≥ threshold, greedy by descending similarity ----
  // Compute pairwise sim only on remaining; skip tiny blocks (Jaccard noisy).
  const candidates: { oi: number; ni: number; sim: number }[] = []
  for (let oi = 0; oi < oldBlocks.length; oi++) {
    if (oldUsed.has(oi)) continue
    if (oldBlocks[oi].fp.length < TINY_BLOCK_LEN) continue
    for (let ni = 0; ni < newBlocks.length; ni++) {
      if (newUsed.has(ni)) continue
      if (newBlocks[ni].fp.length < TINY_BLOCK_LEN) continue
      const s = jaccard(oldBlocks[oi].fp, newBlocks[ni].fp)
      if (s >= threshold) candidates.push({ oi, ni, sim: s })
    }
  }
  candidates.sort((a, b) => b.sim - a.sim)
  for (const c of candidates) {
    if (oldUsed.has(c.oi) || newUsed.has(c.ni)) continue
    out.edited.push({ newIdx: c.ni, oldId: oldBlocks[c.oi].id, similarity: c.sim })
    oldUsed.add(c.oi); newUsed.add(c.ni)
  }

  // Coverage helper: shingles of `small` ⊆ shingles of `big` (rough).
  function coverage(small: BlockFingerprint, big: BlockFingerprint): number {
    if (small.shingles === '' || big.shingles === '') return 0
    const A = new Set(small.shingles.split('|'))
    const B = new Set(big.shingles.split('|'))
    let inter = 0
    for (const s of A) if (B.has(s)) inter++
    return A.size === 0 ? 0 : inter / A.size
  }

  // ---- Pass 3: split (one old → multiple new) ----
  for (let oi = 0; oi < oldBlocks.length; oi++) {
    if (oldUsed.has(oi)) continue
    const matchedNew: { ni: number; cov: number }[] = []
    for (let ni = 0; ni < newBlocks.length; ni++) {
      if (newUsed.has(ni)) continue
      const cov = coverage(newBlocks[ni].fp, oldBlocks[oi].fp)
      if (cov >= splitCoverage) matchedNew.push({ ni, cov })
    }
    if (matchedNew.length >= 2) {
      matchedNew.sort((a, b) => b.cov - a.cov)
      const inheritor = matchedNew[0]
      const siblings = matchedNew.slice(1)
      out.splits.push({
        newIdx: inheritor.ni,
        oldId: oldBlocks[oi].id,
        siblings: siblings.map((s) => s.ni),
      })
      oldUsed.add(oi)
      newUsed.add(inheritor.ni)
      for (const s of siblings) newUsed.add(s.ni)
    }
  }

  // ---- Pass 4: merge (multiple old → one new) ----
  for (let ni = 0; ni < newBlocks.length; ni++) {
    if (newUsed.has(ni)) continue
    const matchedOld: { oi: number; cov: number }[] = []
    for (let oi = 0; oi < oldBlocks.length; oi++) {
      if (oldUsed.has(oi)) continue
      const cov = coverage(oldBlocks[oi].fp, newBlocks[ni].fp)
      if (cov >= splitCoverage) matchedOld.push({ oi, cov })
    }
    if (matchedOld.length >= 2) {
      out.merges.push({ newIdx: ni, oldIds: matchedOld.map((m) => oldBlocks[m.oi].id) })
      newUsed.add(ni)
      for (const m of matchedOld) {
        oldUsed.add(m.oi)
        out.retired.push({ oldId: oldBlocks[m.oi].id, replacedBy: [/* filled below */] })
      }
      // Mark all retired entries from this merge with the same successor.
      // We don't have the new block's id at this point; the caller assigns it
      // and patches replacedBy. Use a sentinel marker so we can find them.
      for (let r = out.retired.length - matchedOld.length; r < out.retired.length; r++) {
        // sentinel: empty; caller will fill with new id later
        out.retired[r].replacedBy = []
      }
    }
  }

  // ---- Pass 5: residue ----
  for (let oi = 0; oi < oldBlocks.length; oi++) {
    if (!oldUsed.has(oi)) {
      out.retired.push({ oldId: oldBlocks[oi].id, replacedBy: [] })
    }
  }
  for (let ni = 0; ni < newBlocks.length; ni++) {
    if (!newUsed.has(ni)) {
      out.fresh.push({ newIdx: ni })
    }
  }

  return out
}
```

**Note on `merges` retired entries:** the function leaves `replacedBy: []` for now; the caller (Phase 2 yaml writer) will fill in the new block's id once it has been allocated. The same applies to `splits.siblings` ids, which are also caller-assigned.

- [ ] **Step 4: Run tests to confirm pass**

Run: `pnpm test --run src/lib/blockchunk/merge.test.ts`
Expected: all 9 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/blockchunk/merge.ts src/lib/blockchunk/merge.test.ts
git commit -m "feat(blockchunk): 5-pass content-fingerprint merge"
```

---

## Phase 2 — Persistence Layer (`src/lib/blockio/`)

### Task 9: yaml schema types

**Files:**
- Create: `src/lib/blockio/yaml-schema.ts`

- [ ] **Step 1: Write the file**

Create `src/lib/blockio/yaml-schema.ts`:

```ts
/**
 * Persistent shape of `<basename>.block.yaml`. This file is the source of
 * truth for block ids; generated `.block.md` is a derivative artifact.
 *
 * Schema version 1. Future migrations should bump SCHEMA_VERSION and write a
 * migration in yaml-rw.ts.
 */
import type { BlockFingerprint } from '../blockchunk/fingerprint'

export const SCHEMA_VERSION = 1

export interface BlockYamlMeta {
  source: string             // basename of the source .md, relative to yaml dir
  source_hash: string        // short SHA-256 of source content
  generation: number         // monotonic; bumped on each merge round
  updated_at: string         // ISO-8601
  schema_version: number     // SCHEMA_VERSION
  has_block_md: boolean      // whether .block.md is in sync with this yaml
}

export interface BlockYamlConfig {
  chunk_size_chars: number
  break_window_chars: number
  similarity_threshold: number
  split_coverage_threshold: number
  inject_ai_hint: boolean
}

export interface ActiveBlock {
  id: string
  src_line: number
  src_pos: number
  out_line?: number          // present only when meta.has_block_md=true
  fingerprint: { hash: string; length: number }
  text: string               // normalized text, used by next merge round
  parents: string[]          // empty for kept/edited; non-empty for splits/merges
  created_gen: number        // birth generation; never updated on inheritance
}

export interface RetiredBlock {
  id: string
  retired_gen: number
  replaced_by: string[]      // [] = pure deletion; otherwise successor ids
  last_fingerprint: { hash: string; length: number }
  text?: string              // retained for recent retirements only
}

export interface BlockYaml {
  meta: BlockYamlMeta
  config: BlockYamlConfig
  active: ActiveBlock[]
  history: RetiredBlock[]
}

export const DEFAULT_CONFIG: BlockYamlConfig = {
  chunk_size_chars: 2400,
  break_window_chars: 800,
  similarity_threshold: 0.5,
  split_coverage_threshold: 0.3,
  inject_ai_hint: true,
}

/** How many generations of history retain `.text`. Older keep only fingerprint. */
export const HISTORY_TEXT_KEEP_GENS = 5

/** Convert in-memory ActiveBlock fingerprint back to BlockFingerprint shape (for merge). */
export function activeToOldEntry(active: ActiveBlock): {
  id: string
  fp: BlockFingerprint
  text: string
} {
  // We don't persist `shingles`; recompute on the fly from `text`.
  // The caller does this via computeFingerprint(active.text) — this helper
  // exists only to centralize the conversion.
  throw new Error('activeToOldEntry: use computeFingerprint(active.text) at the call site')
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `pnpm check`
Expected: no errors related to this file.

- [ ] **Step 3: Commit**

```bash
git add src/lib/blockio/yaml-schema.ts
git commit -m "feat(blockio): yaml schema types for block.yaml"
```

---

### Task 10: yaml atomic read/write with corruption recovery

**Files:**
- Create: `src/lib/blockio/yaml-rw.ts`
- Create: `src/lib/blockio/yaml-rw.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/blockio/yaml-rw.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

  it('preserves block scalars in `text`', () => {
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
```

- [ ] **Step 2: Run tests to confirm failure**

Run: `pnpm test --run src/lib/blockio/yaml-rw.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write implementation**

Create `src/lib/blockio/yaml-rw.ts`:

```ts
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type { BlockYaml } from './yaml-schema'
import { SCHEMA_VERSION } from './yaml-schema'

/**
 * Serialize a BlockYaml to a string. We force `text` fields to use block
 * scalar (`|-`) form so multi-line content stays human-readable.
 */
export function serializeBlockYaml(y: BlockYaml): string {
  return stringifyYaml(y, {
    lineWidth: 0,           // never fold long lines
    blockQuote: 'literal',  // prefer | for multi-line strings
    defaultKeyType: 'PLAIN',
    defaultStringType: 'PLAIN',
  })
}

/**
 * Parse a yaml string into BlockYaml. Throws on malformed yaml or
 * incompatible schema_version.
 */
export function parseBlockYaml(text: string): BlockYaml {
  const obj = parseYaml(text)
  if (!obj || typeof obj !== 'object') throw new Error('blockyaml: not an object')
  const meta = (obj as { meta?: { schema_version?: unknown } }).meta
  if (!meta || meta.schema_version !== SCHEMA_VERSION) {
    throw new Error(`blockyaml: schema_version mismatch (expected ${SCHEMA_VERSION})`)
  }
  return obj as BlockYaml
}

/**
 * Atomic write to disk via Tauri fs: write `path.tmp`, then rename. Uses
 * `@tauri-apps/plugin-fs`. The tauri rename is atomic on POSIX; on Windows
 * we accept a one-frame window where both files exist (acceptable for our
 * use case since we never read mid-write).
 */
export async function writeBlockYamlAtomic(path: string, y: BlockYaml): Promise<void> {
  const { writeTextFile, rename, remove, exists } = await import('@tauri-apps/plugin-fs')
  const tmp = `${path}.tmp`
  const content = serializeBlockYaml(y)
  await writeTextFile(tmp, content)
  // remove existing target so rename succeeds on Windows
  if (await exists(path)) await remove(path)
  await rename(tmp, path)
}

/**
 * Read a block.yaml. On parse error, rename to `<path>.broken-<ts>` and
 * return null so the caller can rebuild fresh.
 */
export async function readBlockYaml(path: string): Promise<BlockYaml | null> {
  const { readTextFile, rename, exists } = await import('@tauri-apps/plugin-fs')
  if (!(await exists(path))) return null
  const text = await readTextFile(path)
  try {
    return parseBlockYaml(text)
  } catch (err) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const backup = `${path}.broken-${ts}`
    try { await rename(path, backup) } catch { /* best effort */ }
    console.warn(`[mdblock] yaml parse failed, backed up to ${backup}: ${err}`)
    return null
  }
}
```

- [ ] **Step 4: Run tests to confirm pass**

Run: `pnpm test --run src/lib/blockio/yaml-rw.test.ts`
Expected: 4 tests pass. Note: `writeBlockYamlAtomic` and `readBlockYaml` are not unit-tested here because they touch Tauri fs (mocking is brittle); they get exercised end-to-end in Phase 6 manual smoke.

- [ ] **Step 5: Commit**

```bash
git add src/lib/blockio/yaml-rw.ts src/lib/blockio/yaml-rw.test.ts
git commit -m "feat(blockio): yaml serialize/parse + atomic Tauri write"
```

---

### Task 11: `.block.md` generation with frontmatter handling

**Files:**
- Create: `src/lib/blockio/inject.ts`
- Create: `src/lib/blockio/inject.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/blockio/inject.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { generateBlockMd, splitFrontmatter } from './inject'
import type { ActiveBlock } from './yaml-schema'

function ab(id: string, src_line: number, src_pos: number): ActiveBlock {
  return {
    id, src_line, src_pos,
    fingerprint: { hash: '0', length: 1 },
    text: '', parents: [], created_gen: 1,
  }
}

describe('splitFrontmatter', () => {
  it('returns { fm: "", body } when no frontmatter', () => {
    const { fm, body, fmLines } = splitFrontmatter('hello world')
    expect(fm).toBe('')
    expect(body).toBe('hello world')
    expect(fmLines).toBe(0)
  })

  it('lifts a YAML frontmatter block', () => {
    const src = '---\ntitle: foo\nauthor: bruce\n---\nbody starts here'
    const { fm, body, fmLines } = splitFrontmatter(src)
    expect(fm).toBe('---\ntitle: foo\nauthor: bruce\n---\n')
    expect(body).toBe('body starts here')
    expect(fmLines).toBe(4)
  })

  it('does not match a partial frontmatter', () => {
    const src = '---\ntitle: foo\nbody without closing'
    const { fm, body } = splitFrontmatter(src)
    expect(fm).toBe('')
    expect(body).toBe(src)
  })
})

describe('generateBlockMd', () => {
  it('inserts anchor + blank line before each block', () => {
    const source = '# Heading 1\nPara 1\n\n# Heading 2\nPara 2'
    const blocks: ActiveBlock[] = [
      ab('b-aaaaaa', 1, 0),
      ab('b-bbbbbb', 4, source.indexOf('# Heading 2')),
    ]
    const { output, outLines } = generateBlockMd(source, blocks, false, 'doc.md')
    expect(output).toBe(
      '<a id="b-aaaaaa"></a>\n\n# Heading 1\nPara 1\n\n<a id="b-bbbbbb"></a>\n\n# Heading 2\nPara 2',
    )
    expect(outLines.get('b-aaaaaa')).toBe(1)
    expect(outLines.get('b-bbbbbb')).toBe(6)
  })

  it('preserves frontmatter at the top with no anchor before it', () => {
    const source = '---\ntitle: x\n---\n# Heading\nBody'
    const blocks: ActiveBlock[] = [ab('b-aaaaaa', 4, source.indexOf('# Heading'))]
    const { output } = generateBlockMd(source, blocks, false, 'doc.md')
    expect(output.startsWith('---\ntitle: x\n---\n')).toBe(true)
    expect(output.includes('<a id="b-aaaaaa"></a>')).toBe(true)
  })

  it('injects AI hint when requested', () => {
    const source = '# Heading\nBody'
    const blocks: ActiveBlock[] = [ab('b-aaaaaa', 1, 0)]
    const { output } = generateBlockMd(source, blocks, true, 'note.md')
    expect(output).toContain('Each block in this document is preceded by an HTML anchor')
    expect(output).toContain('((note.md#b-xxxxxx))')
  })

  it('is idempotent (same input → same output bytes)', () => {
    const source = 'A\n\nB\n\nC'
    const blocks: ActiveBlock[] = [
      ab('b-aaaaaa', 1, 0),
      ab('b-bbbbbb', 3, 3),
      ab('b-cccccc', 5, 6),
    ]
    const a = generateBlockMd(source, blocks, false, 'doc.md').output
    const b = generateBlockMd(source, blocks, false, 'doc.md').output
    expect(a).toBe(b)
  })

  it('out_line accounts for frontmatter and AI hint', () => {
    const source = '---\nx: 1\n---\nFirst block\n\nSecond block'
    const blocks: ActiveBlock[] = [
      ab('b-aaaaaa', 4, source.indexOf('First block')),
      ab('b-bbbbbb', 6, source.indexOf('Second block')),
    ]
    const { outLines } = generateBlockMd(source, blocks, false, 'doc.md')
    // Frontmatter is 3 lines + closing newline = 4 lines (`---\nx: 1\n---\n`)
    // Then anchor (1 line) + blank (1 line) = +2 lines per block
    expect(outLines.get('b-aaaaaa')).toBe(4 + 1) // first anchor on line 5? depends on exact format
    expect(outLines.get('b-bbbbbb')).toBeGreaterThan(outLines.get('b-aaaaaa')!)
  })
})
```

- [ ] **Step 2: Run tests to confirm failure**

Run: `pnpm test --run src/lib/blockio/inject.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write implementation**

Create `src/lib/blockio/inject.ts`:

```ts
import type { ActiveBlock } from './yaml-schema'

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/

export interface FrontmatterSplit {
  fm: string         // including the trailing closing-fence newline; '' if none
  body: string       // remainder
  fmLines: number    // line count of fm (including trailing newline)
}

export function splitFrontmatter(source: string): FrontmatterSplit {
  const m = FRONTMATTER_RE.exec(source)
  if (!m) return { fm: '', body: source, fmLines: 0 }
  const fm = m[0]
  const body = source.slice(fm.length)
  const fmLines = fm.split('\n').length - 1 // trailing newline is +1 boundary
  return { fm, body, fmLines }
}

function aiHintBlock(sourceBasename: string): string {
  return [
    '<!--',
    '  Each block in this document is preceded by an HTML anchor like:',
    '    <a id="b-xxxxxx"></a>',
    '  When citing a block from this document, use:',
    `    ((${sourceBasename}#b-xxxxxx))`,
    '-->',
    '',
  ].join('\n')
}

export interface GenerateBlockMdResult {
  output: string
  outLines: Map<string, number>
}

/**
 * Splice anchor + blank lines into source at each block's position,
 * preserving frontmatter at the top untouched. Optionally injects the
 * AI usage hint between frontmatter and the first block.
 *
 * Algorithm:
 *   1. split frontmatter (no anchors injected inside)
 *   2. for each block sorted by src_pos: find the line-start at-or-before
 *      block.src_pos in the body; splice in `<a id="..."></a>\n\n`
 *   3. compute out_line for each block by counting newlines through the
 *      output up to its anchor's first character
 */
export function generateBlockMd(
  source: string,
  activeBlocks: ActiveBlock[],
  injectAiHint: boolean,
  sourceBasename: string,
): GenerateBlockMdResult {
  const { fm, body, fmLines } = splitFrontmatter(source)

  // Block positions are in the FULL source — adjust to body coordinates.
  const blocks = activeBlocks
    .map((b) => ({ ...b, body_pos: b.src_pos - fm.length }))
    .filter((b) => b.body_pos >= 0)
    .sort((a, b) => a.body_pos - b.body_pos)

  // Snap each block's body_pos to the previous newline (line start).
  for (const b of blocks) {
    if (b.body_pos === 0) continue
    if (body.charCodeAt(b.body_pos - 1) === 10) continue // already at line start
    let p = b.body_pos
    while (p > 0 && body.charCodeAt(p - 1) !== 10) p--
    b.body_pos = p
  }

  // Splice
  const pieces: string[] = []
  if (fm) pieces.push(fm)
  if (injectAiHint) pieces.push(aiHintBlock(sourceBasename))

  let prev = 0
  const anchorOffsets: { id: string; offset: number }[] = []
  for (const b of blocks) {
    pieces.push(body.slice(prev, b.body_pos))
    const offsetInOutput = pieces.reduce((n, s) => n + s.length, 0)
    pieces.push(`<a id="${b.id}"></a>\n\n`)
    anchorOffsets.push({ id: b.id, offset: offsetInOutput })
    prev = b.body_pos
  }
  pieces.push(body.slice(prev))

  const output = pieces.join('')

  // Compute out_line: count \n in output[0..offset] then +1 (1-based)
  const outLines = new Map<string, number>()
  for (const a of anchorOffsets) {
    let line = 1
    for (let i = 0; i < a.offset; i++) {
      if (output.charCodeAt(i) === 10) line++
    }
    outLines.set(a.id, line)
  }

  return { output, outLines }
}
```

- [ ] **Step 4: Run tests to confirm pass**

Run: `pnpm test --run src/lib/blockio/inject.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/blockio/inject.ts src/lib/blockio/inject.test.ts
git commit -m "feat(blockio): generate .block.md with anchors and frontmatter handling"
```

---

### Task 12: Citation regex and parser

**Files:**
- Create: `src/lib/blockio/citation.ts` (initial — regex + parser only)
- Create: `src/lib/blockio/citation.test.ts` (initial)

- [ ] **Step 1: Write the failing tests**

Create `src/lib/blockio/citation.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { CITATION_RE, parseCitations, type ParsedCitation } from './citation'

describe('CITATION_RE', () => {
  it('matches well-formed citations', () => {
    const cases = [
      '((doc.md#b-7f3a9c))',
      '((notes/sub.md#b-abc123))',
      '((/abs/path.md#b-000000))',
      '((#b-deadbe))',
    ]
    for (const c of cases) {
      const r = new RegExp(CITATION_RE.source, '')
      expect(r.test(c)).toBe(true)
    }
  })

  it('rejects invalid forms', () => {
    const cases = [
      '((doc.md#wrong))',         // bad id
      '((doc.md#b-XYZABC))',      // uppercase
      '((doc#b-12345))',          // 5-char id
      '((doc(x)#b-123456))',      // paren in pageuri
      '((doc#b-1234567))',        // 7-char id
      '(no parens at all)',
    ]
    for (const c of cases) {
      const r = new RegExp(CITATION_RE.source, '')
      expect(r.test(c)).toBe(false)
    }
  })
})

describe('parseCitations', () => {
  it('extracts all citations in a string', () => {
    const text = 'See ((a.md#b-aaa111)) and also ((b.md#b-bbb222)) for context.'
    const cs = parseCitations(text)
    expect(cs).toHaveLength(2)
    expect(cs[0]).toMatchObject({ pageuri: 'a.md', blockid: 'b-aaa111' })
    expect(cs[1]).toMatchObject({ pageuri: 'b.md', blockid: 'b-bbb222' })
  })

  it('records start and end offsets', () => {
    const text = 'X((a.md#b-aaa111))Y'
    const [c] = parseCitations(text)
    expect(c.start).toBe(1)
    expect(c.end).toBe(text.length - 1)
    expect(text.slice(c.start, c.end)).toBe('((a.md#b-aaa111))')
  })

  it('treats empty pageuri as same-document', () => {
    const [c] = parseCitations('((#b-7f3a9c))')
    expect(c.pageuri).toBe('')
    expect(c.blockid).toBe('b-7f3a9c')
  })
})
```

- [ ] **Step 2: Run tests to confirm failure**

Run: `pnpm test --run src/lib/blockio/citation.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write implementation**

Create `src/lib/blockio/citation.ts`:

```ts
/**
 * Citation regex. Strict requirements:
 *   - pageuri may be empty or any chars except `(`, `)`, `#`
 *   - blockid is `b-` + exactly 6 lowercase hex chars
 *
 * Use with /g flag for repeated matching; the exported version has no flags
 * so callers can pick the appropriate flag set.
 */
export const CITATION_RE = /\(\(([^()#]*)#(b-[0-9a-f]{6})\)\)/

export interface ParsedCitation {
  raw: string
  pageuri: string     // may be ''
  blockid: string
  start: number       // offset in source
  end: number         // exclusive
}

export function parseCitations(text: string): ParsedCitation[] {
  const re = new RegExp(CITATION_RE.source, 'g')
  const out: ParsedCitation[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    out.push({
      raw: m[0],
      pageuri: m[1],
      blockid: m[2],
      start: m.index,
      end: m.index + m[0].length,
    })
  }
  return out
}

/**
 * Find the citation that contains `cursor` (selectionStart) in `text`,
 * if any. Used by source-mode "follow citation under cursor".
 */
export function citationAtCursor(text: string, cursor: number): ParsedCitation | null {
  for (const c of parseCitations(text)) {
    if (cursor >= c.start && cursor <= c.end) return c
  }
  return null
}
```

- [ ] **Step 4: Run tests to confirm pass**

Run: `pnpm test --run src/lib/blockio/citation.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/blockio/citation.ts src/lib/blockio/citation.test.ts
git commit -m "feat(blockio): citation regex and parser"
```

---

### Task 13: Citation resolution (with file IO)

**Files:**
- Modify: `src/lib/blockio/citation.ts` (append)
- Modify: `src/lib/blockio/citation.test.ts` (append; note Tauri-fs paths are mocked)

- [ ] **Step 1: Append failing tests**

Append to `src/lib/blockio/citation.test.ts`:

```ts
import { resolvePageUri, resolveCitationViaYaml } from './citation'
import type { BlockYaml } from './yaml-schema'

describe('resolvePageUri', () => {
  it('empty pageuri returns the current doc path', () => {
    expect(resolvePageUri('', '/Users/x/notes/today.md')).toBe('/Users/x/notes/today.md')
  })

  it('relative pageuri resolves against current dir', () => {
    expect(resolvePageUri('sub/note.md', '/Users/x/notes/today.md'))
      .toBe('/Users/x/notes/sub/note.md')
  })

  it('absolute pageuri is returned as-is', () => {
    expect(resolvePageUri('/etc/hosts.md', '/Users/x/today.md'))
      .toBe('/etc/hosts.md')
  })

  it('rejects ../ traversal', () => {
    expect(() => resolvePageUri('../../etc/passwd', '/Users/x/today.md'))
      .toThrow(/traversal/i)
  })
})

describe('resolveCitationViaYaml (pure)', () => {
  const yaml: BlockYaml = {
    meta: {
      source: 'doc.md', source_hash: '', generation: 47,
      updated_at: '', schema_version: 1, has_block_md: false,
    },
    config: {
      chunk_size_chars: 2400, break_window_chars: 800,
      similarity_threshold: 0.5, split_coverage_threshold: 0.3,
      inject_ai_hint: true,
    },
    active: [
      { id: 'b-aaaaaa', src_line: 5, src_pos: 50,
        fingerprint: { hash: '', length: 1 }, text: '', parents: [], created_gen: 1 },
      { id: 'b-eeeeee', src_line: 30, src_pos: 500,
        fingerprint: { hash: '', length: 1 }, text: '', parents: [], created_gen: 47 },
    ],
    history: [
      { id: 'b-bbbbbb', retired_gen: 47, replaced_by: ['b-eeeeee'],
        last_fingerprint: { hash: '', length: 0 } },
      { id: 'b-cccccc', retired_gen: 47, replaced_by: ['b-bbbbbb'],
        last_fingerprint: { hash: '', length: 0 } },
      { id: 'b-dddddd', retired_gen: 23, replaced_by: [],
        last_fingerprint: { hash: '', length: 0 } },
    ],
  }

  it('active hit returns srcLine + status="active"', () => {
    expect(resolveCitationViaYaml(yaml, 'b-aaaaaa'))
      .toEqual({ srcLine: 5, status: 'active' })
  })

  it('single-hop history walks to active', () => {
    const r = resolveCitationViaYaml(yaml, 'b-bbbbbb')
    expect(r.status).toBe('retired')
    expect(r.srcLine).toBe(30)
    expect(r.banner).toMatch(/b-eeeeee/)
  })

  it('multi-hop history walks chain', () => {
    const r = resolveCitationViaYaml(yaml, 'b-cccccc')
    expect(r.status).toBe('retired')
    expect(r.srcLine).toBe(30) // ends at b-eeeeee via b-bbbbbb
  })

  it('chain ending in pure deletion', () => {
    const r = resolveCitationViaYaml(yaml, 'b-dddddd')
    expect(r.status).toBe('deleted')
    expect(r.srcLine).toBeUndefined()
    expect(r.banner).toMatch(/已删除/)
  })

  it('unknown id returns not_found', () => {
    const r = resolveCitationViaYaml(yaml, 'b-zzzzzz')
    expect(r.status).toBe('not_found')
  })
})
```

- [ ] **Step 2: Run tests to confirm failure**

Run: `pnpm test --run src/lib/blockio/citation.test.ts`
Expected: FAIL — `resolvePageUri` / `resolveCitationViaYaml` not exported.

- [ ] **Step 3: Append implementation**

Append to `src/lib/blockio/citation.ts`:

```ts
import type { BlockYaml } from './yaml-schema'
import { readBlockYaml } from './yaml-rw'

export function resolvePageUri(pageuri: string, currentDocPath: string): string {
  if (pageuri === '') return currentDocPath
  // Reject `..` traversal (security: don't escape via citations)
  if (pageuri.split('/').includes('..')) {
    throw new Error(`citation: parent-dir traversal rejected (pageuri="${pageuri}")`)
  }
  if (pageuri.startsWith('/')) return pageuri
  // Posix-style relative resolve (works on macOS/Linux; Windows is fine because
  // citation paths in markdown should be posix-y)
  const dir = currentDocPath.replace(/[^/]*$/, '') // dirname with trailing slash
  return dir + pageuri
}

export type ResolvedStatus = 'active' | 'retired' | 'deleted' | 'not_found'

export interface ResolvedCitation {
  status: ResolvedStatus
  srcLine?: number
  filePath?: string
  banner?: string
}

/**
 * Pure resolver against an in-memory yaml. Walks `replaced_by` chains for
 * retired ids until it finds an active block or hits a deletion terminus.
 */
export function resolveCitationViaYaml(
  yaml: BlockYaml,
  blockid: string,
): ResolvedCitation {
  const active = yaml.active.find((a) => a.id === blockid)
  if (active) return { status: 'active', srcLine: active.src_line }

  // Walk history chain
  const visited = new Set<string>()
  let current = blockid
  while (true) {
    if (visited.has(current)) {
      // cycle detection
      return { status: 'not_found' }
    }
    visited.add(current)
    const retired = yaml.history.find((h) => h.id === current)
    if (!retired) return { status: 'not_found' }
    if (retired.replaced_by.length === 0) {
      return {
        status: 'deleted',
        banner: `原 block 已删除（在 generation ${retired.retired_gen}）`,
      }
    }
    // Chain forward; if multiple successors, follow the first that resolves.
    let resolved: ResolvedCitation | null = null
    for (const next of retired.replaced_by) {
      const a = yaml.active.find((x) => x.id === next)
      if (a) {
        resolved = {
          status: 'retired',
          srcLine: a.src_line,
          banner: `原 block 已编辑，跳转到当前继承块 ${a.id}`,
        }
        break
      }
    }
    if (resolved) return resolved
    // None of the immediate successors are active; recurse into the first
    current = retired.replaced_by[0]
  }
}

/**
 * Full resolver: load target's yaml from disk, then resolve.
 */
export async function resolveCitation(
  pageuri: string,
  blockid: string,
  currentDocPath: string,
): Promise<ResolvedCitation & { filePath: string }> {
  const filePath = resolvePageUri(pageuri, currentDocPath)
  const yamlPath = filePath.replace(/\.md$/, '.block.yaml').endsWith('.block.yaml')
    ? filePath.replace(/\.md$/, '.block.yaml')
    : `${filePath}.block.yaml`
  const yaml = await readBlockYaml(yamlPath)
  if (!yaml) {
    return {
      status: 'not_found',
      filePath,
      banner: '目标文档未启用块 id（无 .block.yaml）或 yaml 解析失败',
    }
  }
  const r = resolveCitationViaYaml(yaml, blockid)
  return { ...r, filePath }
}
```

- [ ] **Step 4: Run tests to confirm pass**

Run: `pnpm test --run src/lib/blockio/citation.test.ts`
Expected: all 13 tests pass (4 from task 12 + 9 new).

- [ ] **Step 5: Commit**

```bash
git add src/lib/blockio/citation.ts src/lib/blockio/citation.test.ts
git commit -m "feat(blockio): citation resolution with history-chain walking"
```

---

## Phase 3 — mdblock command layer (`src/lib/mdblock/`)

### Task 14: Settings schema additions

**Files:**
- Modify: `src/lib/settings.svelte.ts`
- Create: `src/lib/mdblock/settings.ts`

- [ ] **Step 1: Open `src/lib/settings.svelte.ts` and read its current shape**

Run: `wc -l src/lib/settings.svelte.ts`
Note the file structure: `settings = $state<...>`, `loadSettings`, `saveSettings`.

- [ ] **Step 2: Extend the settings shape and load/save**

Modify `src/lib/settings.svelte.ts`. At the top-level `$state` declaration, change:

```ts
export const settings = $state<{ autoSave: boolean; skin: string }>({
  autoSave: false,
  skin: 'default',
})
```

To:

```ts
export interface MdblockSettings {
  enabled: boolean
  autoRefreshOnSave: boolean
  injectAiHint: boolean
  similarityThreshold: number
  splitCoverageThreshold: number
  chunkSizeChars: number
  hover: {
    enabled: boolean
    showSourceGutter: boolean
    showRichOverlay: boolean
    badgeFormat: 'short' | 'full'
  }
}

export const DEFAULT_MDBLOCK_SETTINGS: MdblockSettings = {
  enabled: false,
  autoRefreshOnSave: false,
  injectAiHint: true,
  similarityThreshold: 0.5,
  splitCoverageThreshold: 0.3,
  chunkSizeChars: 2400,
  hover: {
    enabled: false,
    showSourceGutter: true,
    showRichOverlay: true,
    badgeFormat: 'short',
  },
}

export const settings = $state<{
  autoSave: boolean
  skin: string
  mdblock: MdblockSettings
}>({
  autoSave: false,
  skin: 'default',
  mdblock: structuredClone(DEFAULT_MDBLOCK_SETTINGS),
})
```

In `loadSettings`, after the existing `recentModesByExt` line, add:

```ts
const storedMdblock = await s.get<MdblockSettings>('mdblock')
settings.mdblock = storedMdblock
  ? { ...DEFAULT_MDBLOCK_SETTINGS, ...storedMdblock,
      hover: { ...DEFAULT_MDBLOCK_SETTINGS.hover, ...(storedMdblock.hover ?? {}) } }
  : structuredClone(DEFAULT_MDBLOCK_SETTINGS)
```

In `saveSettings`, after existing `await s.set('recentModesByExt', ...)`, add:

```ts
await s.set('mdblock', settings.mdblock)
```

- [ ] **Step 3: Write a simple convenience module**

Create `src/lib/mdblock/settings.ts`:

```ts
import { settings } from '../settings.svelte'

export function isMdblockEnabled(): boolean {
  return settings.mdblock.enabled
}

export function isHoverEnabled(): boolean {
  return settings.mdblock.enabled && settings.mdblock.hover.enabled
}
```

- [ ] **Step 4: Verify TypeScript**

Run: `pnpm check`
Expected: no errors related to mdblock settings.

- [ ] **Step 5: Commit**

```bash
git add src/lib/settings.svelte.ts src/lib/mdblock/settings.ts
git commit -m "feat(mdblock): add mdblock settings schema with defaults"
```

---

### Task 15: `mdblock.compute` and `mdblock.refresh` commands

**Files:**
- Create: `src/lib/mdblock/commands.ts`

This task wires the algorithm + IO layers into user-facing commands. There are no unit tests (pure orchestration); behavior is exercised manually in Phase 6 smoke.

- [ ] **Step 1: Write the implementation**

Create `src/lib/mdblock/commands.ts`:

```ts
import { settings } from '../settings.svelte'
import { activeTab } from '../tabs.svelte'
import { showError } from '../dialogs'
import { chunkDocument } from '../blockchunk/chunker'
import { computeFingerprint } from '../blockchunk/fingerprint'
import { newBlockId } from '../blockchunk/id'
import { mergeBlocks, type OldBlockEntry, type NewBlockEntry } from '../blockchunk/merge'
import {
  type BlockYaml,
  type ActiveBlock,
  type RetiredBlock,
  SCHEMA_VERSION,
  DEFAULT_CONFIG,
  HISTORY_TEXT_KEEP_GENS,
} from '../blockio/yaml-schema'
import { readBlockYaml, writeBlockYamlAtomic } from '../blockio/yaml-rw'
import { generateBlockMd } from '../blockio/inject'
import { showToast } from '../toast.svelte'

function basename(p: string): string {
  return p.replace(/^.*\//, '')
}

function yamlPathFor(mdPath: string): string {
  return mdPath.replace(/\.md$/, '.block.yaml').endsWith('.block.yaml')
    ? mdPath.replace(/\.md$/, '.block.yaml')
    : `${mdPath}.block.yaml`
}

function blockMdPathFor(mdPath: string): string {
  // foo.md → foo.block.md ; foo.markdown → foo.markdown.block.md
  return mdPath.endsWith('.md')
    ? mdPath.slice(0, -3) + '.block.md'
    : `${mdPath}.block.md`
}

async function sourceHash(content: string): Promise<string> {
  const data = new TextEncoder().encode(content)
  const buf = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('').slice(0, 16)
}

function reservedIdsFromYaml(y: BlockYaml | null): Set<string> {
  if (!y) return new Set()
  const s = new Set<string>()
  for (const a of y.active) s.add(a.id)
  for (const h of y.history) s.add(h.id)
  return s
}

interface MergeStats {
  active: number
  kept: number
  edited: number
  splits: number
  merges: number
  fresh: number
  retired: number
}

async function computeAndWrite(
  mdPath: string,
  source: string,
  prev: BlockYaml | null,
): Promise<{ yaml: BlockYaml; stats: MergeStats }> {
  // 1. Chunk source
  const cfg = prev?.config ?? DEFAULT_CONFIG
  const newBlocks = chunkDocument(source, cfg.chunk_size_chars, 0, cfg.break_window_chars)

  // 2. Compute fingerprints (parallel)
  const newFps = await Promise.all(newBlocks.map((b) => computeFingerprint(b.text)))
  const newEntries: NewBlockEntry[] = newBlocks.map((b, i) => ({ fp: newFps[i], text: b.text }))

  // 3. Build old entries
  const oldEntries: OldBlockEntry[] = []
  if (prev) {
    for (const a of prev.active) {
      const fp = await computeFingerprint(a.text)
      oldEntries.push({ id: a.id, fp, text: a.text })
    }
  }

  // 4. Merge
  const generation = (prev?.generation ?? 0) + 1
  const generationFromMeta = (prev?.meta.generation ?? 0) + 1
  const out = mergeBlocks(oldEntries, newEntries, cfg.similarity_threshold, cfg.split_coverage_threshold)

  // 5. Allocate ids and lineage
  const reserved = reservedIdsFromYaml(prev)
  const newIds: string[] = new Array(newBlocks.length).fill('')
  const newParents: string[][] = new Array(newBlocks.length).fill(null).map(() => [])
  const newCreatedGen: number[] = new Array(newBlocks.length).fill(generationFromMeta)

  for (const k of out.kept) {
    newIds[k.newIdx] = k.oldId
    // created_gen preserved from old
    const old = prev!.active.find((x) => x.id === k.oldId)!
    newCreatedGen[k.newIdx] = old.created_gen
  }
  for (const e of out.edited) {
    newIds[e.newIdx] = e.oldId
    const old = prev!.active.find((x) => x.id === e.oldId)!
    newCreatedGen[e.newIdx] = old.created_gen
  }
  for (const sp of out.splits) {
    newIds[sp.newIdx] = sp.oldId
    const old = prev!.active.find((x) => x.id === sp.oldId)!
    newCreatedGen[sp.newIdx] = old.created_gen
    for (const sib of sp.siblings) {
      const id = newBlockId(reserved); reserved.add(id); newIds[sib] = id
      newParents[sib] = [sp.oldId]
      newCreatedGen[sib] = generationFromMeta
    }
  }
  for (const m of out.merges) {
    const id = newBlockId(reserved); reserved.add(id); newIds[m.newIdx] = id
    newParents[m.newIdx] = [...m.oldIds]
    newCreatedGen[m.newIdx] = generationFromMeta
  }
  for (const f of out.fresh) {
    const id = newBlockId(reserved); reserved.add(id); newIds[f.newIdx] = id
    newCreatedGen[f.newIdx] = generationFromMeta
  }

  // 6. Build active[]
  const active: ActiveBlock[] = newBlocks.map((b, i) => ({
    id: newIds[i],
    src_line: b.src_line,
    src_pos: b.src_pos,
    fingerprint: { hash: newFps[i].hash, length: newFps[i].length },
    text: b.text, // (will be normalized below via fingerprint cache, but for spec parity store raw block text)
    parents: newParents[i],
    created_gen: newCreatedGen[i],
  }))

  // 7. Build history (carry forward + append new retirements)
  const history: RetiredBlock[] = prev ? [...prev.history] : []
  const oldIdToNewId = new Map<string, string>()
  for (const k of out.kept)   oldIdToNewId.set(k.oldId, newIds[k.newIdx])
  for (const e of out.edited) oldIdToNewId.set(e.oldId, newIds[e.newIdx])
  for (const sp of out.splits) oldIdToNewId.set(sp.oldId, newIds[sp.newIdx])
  for (const m of out.merges) for (const oid of m.oldIds) oldIdToNewId.set(oid, newIds[m.newIdx])

  // For each retired, compute replacedBy. Pure deletions stay [].
  for (const r of out.retired) {
    const successor = oldIdToNewId.get(r.oldId)
    const replaced = successor ? [successor] : []
    const oldRecord = prev!.active.find((x) => x.id === r.oldId)
    history.push({
      id: r.oldId,
      retired_gen: generationFromMeta,
      replaced_by: replaced,
      last_fingerprint: oldRecord
        ? { hash: oldRecord.fingerprint.hash, length: oldRecord.fingerprint.length }
        : { hash: '', length: 0 },
      text: oldRecord?.text, // will be GC'd below
    })
  }

  // 8. GC history.text: keep only entries within HISTORY_TEXT_KEEP_GENS or pure deletions
  for (const h of history) {
    const isRecent = generationFromMeta - h.retired_gen <= HISTORY_TEXT_KEEP_GENS
    const isDeletion = h.replaced_by.length === 0
    if (!isRecent && !isDeletion) delete h.text
  }

  // 9. Build yaml object
  const yaml: BlockYaml = {
    meta: {
      source: basename(mdPath),
      source_hash: await sourceHash(source),
      generation: generationFromMeta,
      updated_at: new Date().toISOString(),
      schema_version: SCHEMA_VERSION,
      has_block_md: prev?.meta.has_block_md ?? false,
    },
    config: cfg,
    active,
    history,
  }

  // 10. Stats
  const stats: MergeStats = {
    active: active.length,
    kept: out.kept.length,
    edited: out.edited.length,
    splits: out.splits.length,
    merges: out.merges.length,
    fresh: out.fresh.length,
    retired: out.retired.length,
  }

  return { yaml, stats }
}

async function readSource(mdPath: string): Promise<string> {
  const { readTextFile } = await import('@tauri-apps/plugin-fs')
  return await readTextFile(mdPath)
}

async function writeBlockMdIfNeeded(
  mdPath: string,
  source: string,
  yaml: BlockYaml,
): Promise<BlockYaml> {
  if (!yaml.meta.has_block_md) return yaml
  const { writeTextFile, rename, exists, remove } = await import('@tauri-apps/plugin-fs')
  const out = generateBlockMd(source, yaml.active, yaml.config.inject_ai_hint, yaml.meta.source)
  // Patch out_lines into yaml
  for (const a of yaml.active) {
    a.out_line = out.outLines.get(a.id)
  }
  const p = blockMdPathFor(mdPath)
  const tmp = `${p}.tmp`
  await writeTextFile(tmp, out.output)
  if (await exists(p)) await remove(p)
  await rename(tmp, p)
  return yaml
}

// ---- Public commands ----

export async function cmdMdblockCompute(): Promise<void> {
  const t = activeTab()
  if (!t || !t.filePath || t.kind === 'image') return
  try {
    const source = await readSource(t.filePath)
    const { yaml, stats } = await computeAndWrite(t.filePath, source, null)
    await writeBlockYamlAtomic(yamlPathFor(t.filePath), yaml)
    showToast(`Computed: ${stats.active} blocks (gen 1)`)
  } catch (e) {
    await showError(`mdblock.compute failed: ${e}`)
  }
}

export async function cmdMdblockRefresh(): Promise<void> {
  const t = activeTab()
  if (!t || !t.filePath || t.kind === 'image') return
  try {
    const source = await readSource(t.filePath)
    const prev = await readBlockYaml(yamlPathFor(t.filePath))
    if (!prev) {
      // First-time → behave like compute
      return cmdMdblockCompute()
    }
    const newHash = await sourceHash(source)
    if (newHash === prev.meta.source_hash) {
      // Source unchanged — just regenerate .block.md if it's missing
      let yaml = prev
      if (yaml.meta.has_block_md) {
        yaml = await writeBlockMdIfNeeded(t.filePath, source, yaml)
        await writeBlockYamlAtomic(yamlPathFor(t.filePath), yaml)
      }
      showToast('No changes detected')
      return
    }
    let { yaml, stats } = await computeAndWrite(t.filePath, source, prev)
    yaml = await writeBlockMdIfNeeded(t.filePath, source, yaml)
    await writeBlockYamlAtomic(yamlPathFor(t.filePath), yaml)
    showToast(
      `Refreshed: ${stats.active} active, ` +
      `${stats.kept} kept, ${stats.edited} edited, ` +
      `${stats.splits} split, ${stats.merges} merged, ` +
      `${stats.fresh} fresh, ${stats.retired} retired`,
    )
  } catch (e) {
    await showError(`mdblock.refresh failed: ${e}`)
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `pnpm check`
Expected: no errors related to commands.ts. Resolve missing exports (e.g., `showToast` from `toast.svelte` may be named differently — adjust import to match the actual export name).

- [ ] **Step 3: Verify imports against actual mdeditor exports**

Run:

```bash
grep -n "export" src/lib/toast.svelte.ts | head -10
grep -n "export" src/lib/tabs.svelte.ts | head -10
grep -n "export" src/lib/dialogs.ts | head -10
```

Adjust the imports in `commands.ts` to match. Common substitutes:
- `showToast` may actually be `toast(...)` or `pushToast(...)`
- `activeTab` is already used in the existing `commands.ts`
- `showError` is already used

- [ ] **Step 4: Commit**

```bash
git add src/lib/mdblock/commands.ts
git commit -m "feat(mdblock): compute and refresh commands wired to algorithm + io"
```

---

### Task 16: `mdblock.generateBlockMd` and `mdblock.reset` commands

**Files:**
- Modify: `src/lib/mdblock/commands.ts` (append)

- [ ] **Step 1: Append implementation**

Append to `src/lib/mdblock/commands.ts`:

```ts
export async function cmdMdblockGenerateBlockMd(): Promise<void> {
  const t = activeTab()
  if (!t || !t.filePath || t.kind === 'image') return
  try {
    const source = await readSource(t.filePath)
    let prev = await readBlockYaml(yamlPathFor(t.filePath))
    if (!prev) {
      const { yaml } = await computeAndWrite(t.filePath, source, null)
      prev = yaml
    }
    prev.meta.has_block_md = true
    prev = await writeBlockMdIfNeeded(t.filePath, source, prev)
    await writeBlockYamlAtomic(yamlPathFor(t.filePath), prev)
    showToast(`Wrote ${blockMdPathFor(t.filePath)}`)
  } catch (e) {
    await showError(`mdblock.generateBlockMd failed: ${e}`)
  }
}

export async function cmdMdblockReset(): Promise<void> {
  const t = activeTab()
  if (!t || !t.filePath || t.kind === 'image') return
  const { confirm } = await import('@tauri-apps/plugin-dialog')
  const ok = await confirm(
    'This will discard all block-id lineage and reassign fresh ids to every block. ' +
    'External references to old ids will resolve to "deleted". Continue?',
    { title: 'Reset block ids', kind: 'warning' },
  )
  if (!ok) return
  try {
    const source = await readSource(t.filePath)
    const { yaml, stats } = await computeAndWrite(t.filePath, source, null)
    await writeBlockYamlAtomic(yamlPathFor(t.filePath), yaml)
    showToast(`Reset: ${stats.active} fresh blocks (gen 1)`)
  } catch (e) {
    await showError(`mdblock.reset failed: ${e}`)
  }
}
```

- [ ] **Step 2: Verify TypeScript**

Run: `pnpm check`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/mdblock/commands.ts
git commit -m "feat(mdblock): generateBlockMd and reset commands"
```

---

### Task 17: `mdblock.followCitationAtCursor` command

**Files:**
- Modify: `src/lib/mdblock/commands.ts` (append)

- [ ] **Step 1: Append implementation**

Append to `src/lib/mdblock/commands.ts`:

```ts
import { citationAtCursor, resolveCitation } from '../blockio/citation'
// (Move this import to the top of the file alongside the other imports.)

export async function cmdMdblockFollowCitationAtCursor(): Promise<boolean> {
  // Returns true if a citation was followed; false to let the caller fall
  // back to the default keystroke handling (e.g., insert newline).
  const t = activeTab()
  if (!t || !t.filePath || t.kind === 'image') return false

  // We need: text + cursor position. The active textarea (source mode) is the
  // primary source; rich mode uses a click handler instead.
  const textarea = document.querySelector<HTMLTextAreaElement>('.source-pane textarea')
  if (!textarea) return false
  const cursor = textarea.selectionStart
  const text = textarea.value
  const cite = citationAtCursor(text, cursor)
  if (!cite) return false

  try {
    const r = await resolveCitation(cite.pageuri, cite.blockid, t.filePath)
    if (r.status === 'not_found') {
      showToast(r.banner ?? '引用未找到')
      return true
    }
    if (r.status === 'deleted') {
      showToast(r.banner!)
      return true
    }
    // open file (if different) and jump to srcLine
    const { openFile } = await import('../tabs.svelte')
    if (r.filePath !== t.filePath) {
      await openFile(r.filePath)
    }
    // After tabs settle, scroll target line into view. We dispatch a custom
    // event that SourceView listens to.
    requestAnimationFrame(() => {
      window.dispatchEvent(new CustomEvent('mdblock:jump', {
        detail: { filePath: r.filePath, srcLine: r.srcLine, blockid: cite.blockid },
      }))
    })
    if (r.banner) showToast(r.banner)
    return true
  } catch (e) {
    await showError(`mdblock.followCitation failed: ${e}`)
    return true
  }
}
```

The corresponding `mdblock:jump` event listener will be added to `SourceView.svelte` in Task 22.

- [ ] **Step 2: Verify TypeScript**

Run: `pnpm check`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/mdblock/commands.ts
git commit -m "feat(mdblock): followCitationAtCursor command"
```

---

### Task 18: Auto-refresh-on-save hook

**Files:**
- Create: `src/lib/mdblock/auto-refresh.ts`
- Modify: `src/lib/tabs.svelte.ts` (call hook from saveActive/saveAs)

- [ ] **Step 1: Find the save call site**

Run: `grep -n "async function saveActive\|export async function saveActive" src/lib/tabs.svelte.ts`
Note the function and its return point.

- [ ] **Step 2: Write the hook module**

Create `src/lib/mdblock/auto-refresh.ts`:

```ts
import { settings } from '../settings.svelte'
import { readBlockYaml } from '../blockio/yaml-rw'
import { cmdMdblockRefresh } from './commands'

function yamlPathFor(mdPath: string): string {
  return mdPath.replace(/\.md$/, '.block.yaml').endsWith('.block.yaml')
    ? mdPath.replace(/\.md$/, '.block.yaml')
    : `${mdPath}.block.yaml`
}

/**
 * Called from tab save flow after a successful write. No-op unless:
 *   - mdblock is enabled
 *   - autoRefreshOnSave is on
 *   - the document already has a .block.yaml (opt-in via Compute Blocks)
 */
export async function maybeAutoRefresh(mdPath: string): Promise<void> {
  if (!settings.mdblock.enabled) return
  if (!settings.mdblock.autoRefreshOnSave) return
  const existing = await readBlockYaml(yamlPathFor(mdPath))
  if (!existing) return
  await cmdMdblockRefresh()
}
```

- [ ] **Step 3: Wire into tabs.svelte.ts**

Open `src/lib/tabs.svelte.ts` and locate `saveActive` and `saveAs`. After each successful write (after the file is on disk and the tab is marked clean), add:

```ts
import { maybeAutoRefresh } from './mdblock/auto-refresh'
// (top of file, with other imports)

// ...inside saveActive, after success:
if (t.filePath && t.filePath.endsWith('.md')) {
  void maybeAutoRefresh(t.filePath)
}

// ...inside saveAs, after success:
if (newPath.endsWith('.md')) {
  void maybeAutoRefresh(newPath)
}
```

The exact line numbers depend on the current state of `tabs.svelte.ts`; insert just before each function returns. Use `void` so a slow refresh doesn't block the save.

- [ ] **Step 4: Verify TypeScript**

Run: `pnpm check`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/mdblock/auto-refresh.ts src/lib/tabs.svelte.ts
git commit -m "feat(mdblock): auto-refresh on save hook (opt-in)"
```

---

## Phase 4 — Visualization (`src/lib/mdblock-hover/`)

### Task 19: line-block-map utility

**Files:**
- Create: `src/lib/mdblock-hover/line-block-map.ts`
- Create: `src/lib/mdblock-hover/line-block-map.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/mdblock-hover/line-block-map.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildLineBlockMap, type LineBlockEntry } from './line-block-map'
import type { ActiveBlock } from '../blockio/yaml-schema'

function ab(id: string, line: number): ActiveBlock {
  return {
    id, src_line: line, src_pos: 0,
    fingerprint: { hash: '', length: 0 },
    text: '', parents: [], created_gen: 1,
  }
}

describe('buildLineBlockMap', () => {
  it('maps each line to the active block that covers it', () => {
    const blocks = [ab('b-aaaaaa', 1), ab('b-bbbbbb', 5), ab('b-cccccc', 10)]
    const map = buildLineBlockMap(blocks, 12)
    expect(map.get(1)).toEqual({ blockid: 'b-aaaaaa', isStart: true })
    expect(map.get(2)).toEqual({ blockid: 'b-aaaaaa', isStart: false })
    expect(map.get(4)).toEqual({ blockid: 'b-aaaaaa', isStart: false })
    expect(map.get(5)).toEqual({ blockid: 'b-bbbbbb', isStart: true })
    expect(map.get(9)).toEqual({ blockid: 'b-bbbbbb', isStart: false })
    expect(map.get(10)).toEqual({ blockid: 'b-cccccc', isStart: true })
    expect(map.get(12)).toEqual({ blockid: 'b-cccccc', isStart: false })
  })

  it('returns empty map for empty active', () => {
    expect(buildLineBlockMap([], 5).size).toBe(0)
  })

  it('handles a single block covering all lines', () => {
    const map = buildLineBlockMap([ab('b-aaaaaa', 1)], 100)
    for (let i = 1; i <= 100; i++) {
      expect(map.get(i)?.blockid).toBe('b-aaaaaa')
    }
    expect(map.get(1)?.isStart).toBe(true)
    expect(map.get(50)?.isStart).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests to confirm failure**

Run: `pnpm test --run src/lib/mdblock-hover/line-block-map.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write implementation**

Create `src/lib/mdblock-hover/line-block-map.ts`:

```ts
import type { ActiveBlock } from '../blockio/yaml-schema'

export interface LineBlockEntry {
  blockid: string
  isStart: boolean   // true if this line is the block's src_line
}

/**
 * Build a 1-based `Map<line, LineBlockEntry>` covering [1, totalLines].
 * Each line falls into exactly one block, namely the block with the largest
 * src_line ≤ line.
 */
export function buildLineBlockMap(
  active: ActiveBlock[],
  totalLines: number,
): Map<number, LineBlockEntry> {
  const map = new Map<number, LineBlockEntry>()
  if (active.length === 0) return map
  const sorted = [...active].sort((a, b) => a.src_line - b.src_line)
  let bi = 0
  for (let line = 1; line <= totalLines; line++) {
    while (bi + 1 < sorted.length && sorted[bi + 1].src_line <= line) bi++
    if (line < sorted[bi].src_line) continue // before first block; rare
    map.set(line, {
      blockid: sorted[bi].id,
      isStart: sorted[bi].src_line === line,
    })
  }
  return map
}
```

- [ ] **Step 4: Run tests to confirm pass**

Run: `pnpm test --run src/lib/mdblock-hover/line-block-map.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/mdblock-hover/line-block-map.ts src/lib/mdblock-hover/line-block-map.test.ts
git commit -m "feat(mdblock-hover): line→block-id mapping"
```

---

### Task 20: Hover store (per-tab Svelte 5 runes)

**Files:**
- Create: `src/lib/mdblock-hover/hover-store.svelte.ts`

- [ ] **Step 1: Write the implementation**

Create `src/lib/mdblock-hover/hover-store.svelte.ts`:

```ts
import type { BlockYaml } from '../blockio/yaml-schema'
import { readBlockYaml } from '../blockio/yaml-rw'
import { settings } from '../settings.svelte'

interface PerTabState {
  filePath: string
  yaml: BlockYaml | null
  loading: boolean
}

const tabStates = new Map<string, PerTabState>()
export const hoverStore = $state<{ version: number }>({ version: 0 })

function bumpVersion() {
  hoverStore.version++
}

export function getHoverState(filePath: string): PerTabState | null {
  return tabStates.get(filePath) ?? null
}

export async function loadHoverYaml(filePath: string): Promise<void> {
  if (!filePath.endsWith('.md')) return
  const existing = tabStates.get(filePath)
  if (existing?.loading) return
  tabStates.set(filePath, { filePath, yaml: null, loading: true })
  bumpVersion()
  const yamlPath = filePath.replace(/\.md$/, '.block.yaml')
  const yaml = await readBlockYaml(yamlPath)
  tabStates.set(filePath, { filePath, yaml, loading: false })
  bumpVersion()
}

export function dropHoverState(filePath: string): void {
  if (tabStates.delete(filePath)) bumpVersion()
}

/** Listener wiring: refresh hover state on a save-induced refresh. */
export function installHoverInvalidator(): void {
  window.addEventListener('mdblock:yaml-updated', (ev: Event) => {
    const detail = (ev as CustomEvent<{ filePath: string }>).detail
    if (detail?.filePath) void loadHoverYaml(detail.filePath)
  })
}

export function isHoverActive(): boolean {
  return settings.mdblock.enabled && settings.mdblock.hover.enabled
}
```

- [ ] **Step 2: Emit `mdblock:yaml-updated` from commands**

Modify `src/lib/mdblock/commands.ts`. After every `await writeBlockYamlAtomic(...)` call, emit the event:

```ts
window.dispatchEvent(new CustomEvent('mdblock:yaml-updated', {
  detail: { filePath: t.filePath },
}))
```

(Add this line after writeBlockYamlAtomic in `cmdMdblockCompute`, `cmdMdblockRefresh`, `cmdMdblockReset`, `cmdMdblockGenerateBlockMd`.)

- [ ] **Step 3: Verify TypeScript**

Run: `pnpm check`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/lib/mdblock-hover/hover-store.svelte.ts src/lib/mdblock/commands.ts
git commit -m "feat(mdblock-hover): per-tab yaml store with invalidator"
```

---

### Task 21: Source-mode gutter component

**Files:**
- Create: `src/lib/mdblock-hover/source-gutter.svelte`

- [ ] **Step 1: Write the component**

Create `src/lib/mdblock-hover/source-gutter.svelte`:

```svelte
<script lang="ts">
  import type { BlockYaml } from '../blockio/yaml-schema'
  import { buildLineBlockMap } from './line-block-map'

  interface Props {
    textarea: HTMLTextAreaElement | null
    yaml: BlockYaml | null
    badgeFormat: 'short' | 'full'
  }
  let { textarea, yaml, badgeFormat }: Props = $props()

  let scrollTop = $state(0)
  let totalLines = $state(0)
  let lineHeight = $state(20)
  let fontFamily = $state('ui-monospace, monospace')
  let fontSize = $state('14px')

  // Recompute geometry when textarea attaches/changes
  $effect(() => {
    if (!textarea) return
    const cs = getComputedStyle(textarea)
    const lh = parseFloat(cs.lineHeight)
    if (!Number.isNaN(lh)) lineHeight = lh
    fontFamily = cs.fontFamily
    fontSize = cs.fontSize
    totalLines = textarea.value.split('\n').length

    const onScroll = () => { scrollTop = textarea!.scrollTop }
    const onInput = () => { totalLines = textarea!.value.split('\n').length }
    textarea.addEventListener('scroll', onScroll, { passive: true })
    textarea.addEventListener('input', onInput)

    // Force soft-wrap off so our gutter rows align with logical lines
    const prevWrap = textarea.style.whiteSpace
    textarea.style.whiteSpace = 'pre'
    textarea.style.overflowX = 'auto'

    return () => {
      textarea!.removeEventListener('scroll', onScroll)
      textarea!.removeEventListener('input', onInput)
      textarea!.style.whiteSpace = prevWrap
    }
  })

  let lineMap = $derived(yaml ? buildLineBlockMap(yaml.active, totalLines) : new Map())

  function copyId(id: string) {
    navigator.clipboard.writeText(id).catch(() => {})
  }

  function formatBadge(id: string, line: number): string {
    return badgeFormat === 'full' ? `${id} (line ${line})` : id
  }
</script>

<div class="block-gutter"
     style:font-family={fontFamily}
     style:font-size={fontSize}
     style:line-height="{lineHeight}px">
  <div class="block-gutter-inner" style:transform="translateY({-scrollTop}px)">
    {#each Array(totalLines) as _, i}
      {@const line = i + 1}
      {@const entry = lineMap.get(line)}
      <div class="block-gutter-row" style:height="{lineHeight}px">
        {#if entry?.isStart}
          <button class="block-gutter-label"
                  type="button"
                  title="Click to copy {entry.blockid}"
                  onclick={() => copyId(entry.blockid)}>
            {formatBadge(entry.blockid, line)}
          </button>
        {:else if entry}
          <span class="block-gutter-bar"></span>
        {/if}
      </div>
    {/each}
  </div>
</div>

<style>
  .block-gutter {
    width: 84px;
    flex-shrink: 0;
    overflow: hidden;
    border-right: 1px solid color-mix(in srgb, currentColor 15%, transparent);
    user-select: none;
    background: color-mix(in srgb, Canvas 95%, currentColor 5%);
  }
  .block-gutter-inner {
    will-change: transform;
  }
  .block-gutter-row {
    display: flex;
    align-items: center;
    padding: 0 6px;
  }
  .block-gutter-label {
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    color: color-mix(in srgb, currentColor 65%, transparent);
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    width: 100%;
    text-align: left;
  }
  .block-gutter-label:hover {
    color: currentColor;
  }
  .block-gutter-bar {
    display: inline-block;
    width: 2px;
    height: 100%;
    background: color-mix(in srgb, currentColor 25%, transparent);
    margin-left: 8px;
  }
</style>
```

- [ ] **Step 2: Verify TypeScript via svelte-check**

Run: `pnpm check`
Expected: no errors related to source-gutter.svelte.

- [ ] **Step 3: Commit**

```bash
git add src/lib/mdblock-hover/source-gutter.svelte
git commit -m "feat(mdblock-hover): source-view gutter component"
```

---

### Task 22: Rich-mode block-border overlay

**Files:**
- Create: `src/lib/mdblock-hover/rich-overlay.svelte`

- [ ] **Step 1: Write the component**

Create `src/lib/mdblock-hover/rich-overlay.svelte`:

```svelte
<script lang="ts">
  import type { BlockYaml } from '../blockio/yaml-schema'

  interface Props {
    container: HTMLElement | null   // the rich editor's content root
    yaml: BlockYaml | null
    badgeFormat: 'short' | 'full'
  }
  let { container, yaml, badgeFormat }: Props = $props()

  interface Frame { x: number; y: number; w: number; h: number; ids: string[] }
  let frames = $state<Frame[]>([])

  function recompute() {
    if (!container || !yaml) { frames = []; return }
    const children = Array.from(container.children) as HTMLElement[]
    const active = yaml.active
    const out: Frame[] = []
    const containerRect = container.getBoundingClientRect()
    // Naive 1:1 mapping with ids in document order; collapse 1:N when there
    // are more active blocks than DOM children by grouping extras into the
    // last seen DOM child.
    const span = Math.max(1, active.length / Math.max(1, children.length))
    for (let i = 0; i < children.length; i++) {
      const r = children[i].getBoundingClientRect()
      const startIdx = Math.floor(i * span)
      const endIdx = Math.min(active.length, Math.floor((i + 1) * span))
      const ids = active.slice(startIdx, Math.max(startIdx + 1, endIdx)).map((a) => a.id)
      out.push({
        x: r.left - containerRect.left,
        y: r.top - containerRect.top,
        w: r.width,
        h: r.height,
        ids,
      })
    }
    frames = out
  }

  let observer: MutationObserver | null = null
  let raf = 0

  $effect(() => {
    if (!container) return
    const schedule = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(recompute)
    }
    observer = new MutationObserver(schedule)
    observer.observe(container, { childList: true, subtree: true, characterData: true })
    schedule()
    window.addEventListener('resize', schedule)
    container.addEventListener('scroll', schedule, { passive: true })
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', schedule)
      container?.removeEventListener('scroll', schedule)
      cancelAnimationFrame(raf)
    }
  })

  function badgeText(ids: string[]): string {
    if (ids.length === 0) return ''
    const head = badgeFormat === 'full' ? ids[0] : ids[0]
    return ids.length > 1 ? `${head} +${ids.length - 1}` : head
  }
</script>

<div class="mdblock-overlay">
  {#each frames as f}
    <div class="mdblock-frame"
         style:left="{f.x}px"
         style:top="{f.y}px"
         style:width="{f.w}px"
         style:height="{f.h}px">
      <div class="mdblock-badge">{badgeText(f.ids)}</div>
    </div>
  {/each}
</div>

<style>
  .mdblock-overlay {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }
  .mdblock-frame {
    position: absolute;
    border: 1px dashed color-mix(in srgb, currentColor 30%, transparent);
    border-radius: 3px;
  }
  .mdblock-badge {
    position: absolute;
    top: -10px;
    left: 6px;
    padding: 1px 6px;
    background: Canvas;
    border: 1px solid color-mix(in srgb, currentColor 30%, transparent);
    border-radius: 3px;
    font-family: ui-monospace, monospace;
    font-size: 11px;
    color: color-mix(in srgb, currentColor 80%, transparent);
  }
</style>
```

- [ ] **Step 2: Verify svelte-check**

Run: `pnpm check`
Expected: no errors related to rich-overlay.svelte.

- [ ] **Step 3: Commit**

```bash
git add src/lib/mdblock-hover/rich-overlay.svelte
git commit -m "feat(mdblock-hover): rich-view block border overlay"
```

---

### Task 23: Mount gutter in SourceView and overlay in RichEditor

**Files:**
- Modify: `src/components/SourceView.svelte`
- Modify: `src/components/RichEditor.svelte`

- [ ] **Step 1: Read the current SourceView shape**

Run: `cat src/components/SourceView.svelte | head -60`
Note where the textarea is mounted; identify a flex container for placing the gutter to its left.

- [ ] **Step 2: Add gutter mount + jump listener to SourceView**

Modify `src/components/SourceView.svelte`. At the top of the `<script>`:

```ts
import SourceGutter from '../lib/mdblock-hover/source-gutter.svelte'
import { hoverStore, getHoverState, loadHoverYaml, isHoverActive } from '../lib/mdblock-hover/hover-store.svelte'
import { settings } from '../lib/settings.svelte'
import { activeTab } from '../lib/tabs.svelte'

let textareaEl: HTMLTextAreaElement | null = $state(null)
let _hoverVersion = $derived(hoverStore.version) // re-run derive on yaml updates

let yaml = $derived.by(() => {
  const t = activeTab()
  if (!t?.filePath) return null
  // touch version to subscribe
  void hoverStore.version
  return getHoverState(t.filePath)?.yaml ?? null
})

$effect(() => {
  const t = activeTab()
  if (t?.filePath?.endsWith('.md') && isHoverActive()) {
    void loadHoverYaml(t.filePath)
  }
})

// listen for jump events and scroll the textarea
$effect(() => {
  function onJump(ev: Event) {
    const d = (ev as CustomEvent<{ filePath: string; srcLine: number }>).detail
    const t = activeTab()
    if (!textareaEl || !t || t.filePath !== d.filePath) return
    const lines = textareaEl.value.split('\n')
    let pos = 0
    for (let i = 0; i < d.srcLine - 1; i++) pos += lines[i].length + 1
    textareaEl.focus()
    textareaEl.setSelectionRange(pos, pos)
    // scroll into view
    const lh = parseFloat(getComputedStyle(textareaEl).lineHeight) || 20
    textareaEl.scrollTop = (d.srcLine - 1) * lh - textareaEl.clientHeight / 2
  }
  window.addEventListener('mdblock:jump', onJump)
  return () => window.removeEventListener('mdblock:jump', onJump)
})
```

In the markup, wrap the existing `<textarea ... />` in a flex container with the gutter on its left:

```svelte
<div class="source-pane" style="display: flex; height: 100%;">
  {#if isHoverActive() && settings.mdblock.hover.showSourceGutter && yaml}
    <SourceGutter {textarea}={textareaEl} {yaml} badgeFormat={settings.mdblock.hover.badgeFormat} />
  {/if}
  <textarea bind:this={textareaEl} {/* …existing props… */}></textarea>
</div>
```

- [ ] **Step 3: Add overlay mount to RichEditor**

Modify `src/components/RichEditor.svelte`. Identify the rich editor's content root element (the @moraya/core mounting point). Add a sibling overlay:

```ts
import RichOverlay from '../lib/mdblock-hover/rich-overlay.svelte'
import { hoverStore, getHoverState, isHoverActive } from '../lib/mdblock-hover/hover-store.svelte'
import { settings } from '../lib/settings.svelte'
import { activeTab } from '../lib/tabs.svelte'

let editorContainer: HTMLElement | null = $state(null)
let _hv = $derived(hoverStore.version)

let yaml = $derived.by(() => {
  const t = activeTab()
  if (!t?.filePath) return null
  void hoverStore.version
  return getHoverState(t.filePath)?.yaml ?? null
})
```

Wrap the editor's content root in a relative-positioned div and append the overlay:

```svelte
<div style="position: relative;">
  <div bind:this={editorContainer} {/* existing rich editor root */}></div>
  {#if isHoverActive() && settings.mdblock.hover.showRichOverlay && yaml && editorContainer}
    <RichOverlay container={editorContainer} {yaml} badgeFormat={settings.mdblock.hover.badgeFormat} />
  {/if}
</div>
```

(Adjust to match the actual @moraya/core mounting pattern in the existing component.)

- [ ] **Step 4: Install the hover invalidator at app boot**

Modify `src/App.svelte`. In the `onMount` (or equivalent boot function), call:

```ts
import { installHoverInvalidator } from './lib/mdblock-hover/hover-store.svelte'
// inside onMount / boot effect:
installHoverInvalidator()
```

- [ ] **Step 5: Verify TypeScript / svelte-check**

Run: `pnpm check`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/SourceView.svelte src/components/RichEditor.svelte src/App.svelte
git commit -m "feat(mdblock-hover): mount gutter in source view + overlay in rich view"
```

---

## Phase 5 — Citation rendering in rich mode

### Task 24: marked extension for `((page#blockid))` pills

**Files:**
- Create: `src/lib/blockio/marked-citation.ts`
- Create: `src/lib/blockio/marked-citation.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/blockio/marked-citation.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { Marked } from 'marked'
import { blockCitationExtension } from './marked-citation'

describe('blockCitationExtension', () => {
  it('renders a citation as a clickable pill', () => {
    const m = new Marked({ extensions: [blockCitationExtension] })
    const html = m.parse('see ((doc.md#b-7f3a9c)) here') as string
    expect(html).toContain('class="block-citation"')
    expect(html).toContain('data-blockid="b-7f3a9c"')
    expect(html).toContain('data-pageuri="doc.md"')
  })

  it('handles same-document citation', () => {
    const m = new Marked({ extensions: [blockCitationExtension] })
    const html = m.parse('jump ((#b-aaaaaa))') as string
    expect(html).toContain('data-pageuri=""')
    expect(html).toContain('data-blockid="b-aaaaaa"')
  })

  it('does not match malformed citations', () => {
    const m = new Marked({ extensions: [blockCitationExtension] })
    const html = m.parse('not ((doc.md#wrong)) cited') as string
    expect(html).not.toContain('class="block-citation"')
    expect(html).toContain('((doc.md#wrong))')
  })

  it('escapes pageuri to prevent XSS', () => {
    const m = new Marked({ extensions: [blockCitationExtension] })
    const html = m.parse('((evil"<script>x</script>#b-aaaaaa))') as string
    // The whole match shouldn't have raw < or >
    expect(html).not.toContain('<script>')
  })
})
```

- [ ] **Step 2: Run tests to confirm failure**

Run: `pnpm test --run src/lib/blockio/marked-citation.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/lib/blockio/marked-citation.ts`:

```ts
import type { TokenizerAndRendererExtension } from 'marked'

const INLINE_RE = /^\(\(([^()#]*)#(b-[0-9a-f]{6})\)\)/

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export const blockCitationExtension: TokenizerAndRendererExtension = {
  name: 'blockCitation',
  level: 'inline',
  start(src: string) {
    return src.indexOf('((')
  },
  tokenizer(src: string) {
    const m = INLINE_RE.exec(src)
    if (!m) return undefined
    return {
      type: 'blockCitation',
      raw: m[0],
      pageuri: m[1],
      blockid: m[2],
    } as { type: string; raw: string; pageuri: string; blockid: string }
  },
  renderer(token: any) {
    const pageuri = String(token.pageuri ?? '')
    const blockid = String(token.blockid ?? '')
    const label = pageuri || '此处'
    const tail = blockid.slice(0, 8) // shorter than full
    const title = `跳转 ${pageuri || '同文档'} #${blockid}`
    return `<span class="block-citation" data-pageuri="${escapeHtml(pageuri)}" data-blockid="${escapeHtml(blockid)}" title="${escapeHtml(title)}">→ ${escapeHtml(label)}#${escapeHtml(tail)}</span>`
  },
}
```

- [ ] **Step 4: Run tests to confirm pass**

Run: `pnpm test --run src/lib/blockio/marked-citation.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/blockio/marked-citation.ts src/lib/blockio/marked-citation.test.ts
git commit -m "feat(blockio): marked extension for citation pills"
```

---

### Task 25: Pill CSS and rich-mode click handler

**Files:**
- Modify: `src/styles/editor-base.css` (or `app.css` if base doesn't exist yet)
- Modify: `src/components/RichEditor.svelte`

- [ ] **Step 1: Add pill CSS**

If `src/styles/editor-base.css` exists (per the rich-editor-skins spec), append to it; otherwise append to `src/styles/app.css`. Add:

```css
/* mdblock citation pill — rendered by marked-citation extension */
.block-citation {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 4px;
  background: color-mix(in srgb, Canvas 90%, currentColor 10%);
  border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
  font-family: ui-monospace, monospace;
  font-size: 0.85em;
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
  margin: 0 0.1em;
}
.block-citation:hover {
  background: color-mix(in srgb, Canvas 80%, currentColor 20%);
}
.block-citation[data-status="retired"] {
  background: color-mix(in srgb, #fff8d8 70%, Canvas 30%);
}
.block-citation[data-status="deleted"] {
  background: color-mix(in srgb, #fdd 70%, Canvas 30%);
  text-decoration: line-through;
}
```

- [ ] **Step 2: Register the marked extension and add the click delegator**

Modify `src/components/RichEditor.svelte`. Where marked is configured (search for `marked.use(` or `new Marked`), register the extension. If marked is already configured globally in `src/lib/diagram-render.ts` or similar, register there.

```ts
// Wherever marked is set up:
import { blockCitationExtension } from '../lib/blockio/marked-citation'
marked.use({ extensions: [blockCitationExtension] })
```

In `RichEditor.svelte`, add an event delegator on the editor container:

```ts
import { resolveCitation } from '../lib/blockio/citation'
import { activeTab, openFile } from '../lib/tabs.svelte'
import { showError, showToast } from '../lib/toast.svelte' // adjust to actual export
// ...existing script...

$effect(() => {
  if (!editorContainer) return
  const onClick = async (ev: MouseEvent) => {
    const tgt = ev.target as HTMLElement | null
    const pill = tgt?.closest<HTMLElement>('.block-citation')
    if (!pill) return
    ev.preventDefault()
    const pageuri = pill.getAttribute('data-pageuri') ?? ''
    const blockid = pill.getAttribute('data-blockid') ?? ''
    const t = activeTab()
    if (!t?.filePath) return
    try {
      const r = await resolveCitation(pageuri, blockid, t.filePath)
      if (r.status === 'not_found' || r.status === 'deleted') {
        showToast(r.banner ?? '引用未找到')
        pill.setAttribute('data-status', r.status === 'deleted' ? 'deleted' : 'retired')
        return
      }
      if (r.filePath !== t.filePath) await openFile(r.filePath)
      requestAnimationFrame(() => {
        window.dispatchEvent(new CustomEvent('mdblock:jump', {
          detail: { filePath: r.filePath, srcLine: r.srcLine, blockid },
        }))
      })
      if (r.banner) {
        showToast(r.banner)
        pill.setAttribute('data-status', 'retired')
      }
    } catch (e) {
      await showError(`citation jump failed: ${e}`)
    }
  }
  editorContainer.addEventListener('click', onClick)
  return () => editorContainer?.removeEventListener('click', onClick)
})
```

- [ ] **Step 3: Verify svelte-check**

Run: `pnpm check`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/styles/ src/components/RichEditor.svelte
git commit -m "feat(blockio): citation pill styling + rich-mode click handler"
```

---

### Task 26: Source-mode `Cmd+Enter` shortcut to follow citation

**Files:**
- Modify: `src/components/SourceView.svelte`

- [ ] **Step 1: Add keydown handler**

Modify `src/components/SourceView.svelte`. In the `<script>` (after the imports added in Task 23), add:

```ts
import { cmdMdblockFollowCitationAtCursor } from '../lib/mdblock/commands'
import { settings } from '../lib/settings.svelte'

async function onTextareaKeydown(ev: KeyboardEvent) {
  if (!settings.mdblock.enabled) return
  // Cmd+Enter (macOS) — only if cursor is on a citation, otherwise let it pass
  if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') {
    const handled = await cmdMdblockFollowCitationAtCursor()
    if (handled) {
      ev.preventDefault()
      ev.stopPropagation()
    }
  }
}
```

In the textarea element, add the handler:

```svelte
<textarea bind:this={textareaEl} onkeydown={onTextareaKeydown} {/* …existing props… */}></textarea>
```

- [ ] **Step 2: Verify svelte-check**

Run: `pnpm check`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/SourceView.svelte
git commit -m "feat(mdblock): Cmd+Enter follows citation in source mode"
```

---

## Phase 6 — Settings UI, menu wiring, smoke

### Task 27: SettingsDialog Block tab

**Files:**
- Modify: `src/components/SettingsDialog.svelte`

- [ ] **Step 1: Inspect current tab structure**

Run: `grep -n "tab\|Tab\|Plugins" src/components/SettingsDialog.svelte | head -30`
Note how existing tabs (`Plugins`, `Core`, etc.) are structured.

- [ ] **Step 2: Add a Block tab**

Modify `src/components/SettingsDialog.svelte`. Add a new tab entry alongside existing ones; on the panel side, add:

```svelte
<script lang="ts">
  import { settings, saveSettings } from '../lib/settings.svelte'

  async function persist() { await saveSettings() }
</script>

<!-- Inside the existing tab list, add an entry whose label is "Block".
     Inside the corresponding panel: -->
<section class="settings-section">
  <h3>Block</h3>

  <label class="settings-row">
    <input type="checkbox" bind:checked={settings.mdblock.enabled} onchange={persist} />
    Enable Block IDs (mdblock)
  </label>

  <label class="settings-row">
    <input type="checkbox"
           bind:checked={settings.mdblock.autoRefreshOnSave}
           disabled={!settings.mdblock.enabled}
           onchange={persist} />
    Auto-refresh on save
  </label>

  <label class="settings-row">
    <input type="checkbox"
           bind:checked={settings.mdblock.injectAiHint}
           disabled={!settings.mdblock.enabled}
           onchange={persist} />
    Inject AI usage hint into .block.md
  </label>

  <label class="settings-row">
    Chunk size (chars):
    <input type="number" min="800" max="8000" step="100"
           bind:value={settings.mdblock.chunkSizeChars}
           disabled={!settings.mdblock.enabled}
           onchange={persist} />
  </label>

  <label class="settings-row">
    Similarity threshold:
    <input type="number" min="0" max="1" step="0.05"
           bind:value={settings.mdblock.similarityThreshold}
           disabled={!settings.mdblock.enabled}
           onchange={persist} />
  </label>

  <h4>Visualization (mdblock-hover)</h4>

  <label class="settings-row">
    <input type="checkbox"
           bind:checked={settings.mdblock.hover.enabled}
           disabled={!settings.mdblock.enabled}
           onchange={persist} />
    Show block boundaries
  </label>

  <p class="settings-hint">
    Enabling visualization disables soft-wrap in source view to keep the gutter aligned.
  </p>

  <label class="settings-row">
    <input type="checkbox"
           bind:checked={settings.mdblock.hover.showSourceGutter}
           disabled={!settings.mdblock.enabled || !settings.mdblock.hover.enabled}
           onchange={persist} />
    Source gutter
  </label>

  <label class="settings-row">
    <input type="checkbox"
           bind:checked={settings.mdblock.hover.showRichOverlay}
           disabled={!settings.mdblock.enabled || !settings.mdblock.hover.enabled}
           onchange={persist} />
    Rich-mode borders
  </label>

  <label class="settings-row">
    Badge format:
    <select bind:value={settings.mdblock.hover.badgeFormat}
            disabled={!settings.mdblock.enabled || !settings.mdblock.hover.enabled}
            onchange={persist}>
      <option value="short">short (b-xxxxxx)</option>
      <option value="full">full (b-xxxxxx, line N)</option>
    </select>
  </label>
</section>
```

- [ ] **Step 3: Verify svelte-check**

Run: `pnpm check`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/SettingsDialog.svelte
git commit -m "feat(mdblock): Settings → Block tab with all toggles"
```

---

### Task 28: Menu / shortcut wiring in App.svelte

**Files:**
- Modify: `src/App.svelte` (or wherever menu is built)

- [ ] **Step 1: Locate command wiring**

Run: `grep -n "Cmd+S\|Cmd+/\|MenuItem\|Submenu" src/App.svelte | head -20`
Note how menu items are added (Tauri menu API).

- [ ] **Step 2: Add mdblock commands to the menu**

Modify `src/App.svelte`. In the menu construction, add entries that are visible only when `settings.mdblock.enabled` is true. The exact API depends on mdeditor's current menu code; below is the conceptual change:

```ts
import {
  cmdMdblockCompute,
  cmdMdblockRefresh,
  cmdMdblockReset,
  cmdMdblockGenerateBlockMd,
} from './lib/mdblock/commands'
import { settings } from './lib/settings.svelte'

// In the Tools menu (or new Block menu):
if (settings.mdblock.enabled) {
  menu.append({
    text: 'Compute Blocks',
    action: cmdMdblockCompute,
  })
  menu.append({
    text: 'Refresh Blocks',
    accelerator: 'CmdOrCtrl+Shift+B',
    action: cmdMdblockRefresh,
  })
  menu.append({
    text: 'Generate .block.md',
    action: cmdMdblockGenerateBlockMd,
  })
  menu.append({
    text: 'Reset Block Lineage…',
    action: cmdMdblockReset,
  })
}

// View menu addition:
menu.append({
  text: 'Block Boundaries',
  type: 'checkbox',
  checked: settings.mdblock.hover.enabled,
  enabled: settings.mdblock.enabled,
  action: async () => {
    settings.mdblock.hover.enabled = !settings.mdblock.hover.enabled
    await saveSettings()
  },
})
```

Adapt the syntax to mdeditor's actual menu builder. If menus are not dynamic (built once at app start), add the entries unconditionally and gate the *action* with `settings.mdblock.enabled` (showing a toast "Enable mdblock in Settings → Block first" otherwise).

- [ ] **Step 3: Wire keyboard shortcut**

Find the existing keydown handler in `src/App.svelte` (search for `Cmd+S` handling). Add:

```ts
if ((ev.metaKey || ev.ctrlKey) && ev.shiftKey && ev.key.toLowerCase() === 'b') {
  if (settings.mdblock.enabled) {
    ev.preventDefault()
    void cmdMdblockRefresh()
  }
}
```

- [ ] **Step 4: Verify svelte-check**

Run: `pnpm check`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/App.svelte
git commit -m "feat(mdblock): menu entries and Cmd+Shift+B shortcut"
```

---

### Task 29: README smoke-test additions and `.gitignore` entries

**Files:**
- Modify: `README.md`
- Modify: `.gitignore`

- [ ] **Step 1: Add smoke checklist entries**

Modify `README.md`. Find the "Manual Smoke Test" section. Append (renumber as appropriate):

```markdown
N. Open a `.md` file → enable Settings → Block → "Enable Block IDs" → close Settings → press `Cmd+Shift+B` → toast: "Computed: K blocks (gen 1)"
N+1. The file's directory now contains `<basename>.block.yaml` (visible via Finder)
N+2. Run `cat <basename>.block.yaml` from a terminal — verify `meta.generation: 1`, `active[]` has K entries with `b-xxxxxx` ids
N+3. From Tools menu run "Generate .block.md" → toast confirms write → file `<basename>.block.md` exists with `<a id="b-xxxxxx"></a>` lines before each block
N+4. Settings → Block → enable Block Boundaries → switch to source view → see gutter on the left with block ids; switch to rich view → see dashed boxes with badges around each rendered block
N+5. Edit the document lightly (fix a typo) → `Cmd+Shift+B` → toast: "Refreshed: K active, ≥(K-1) kept, ..."; ids unchanged
N+6. Delete a paragraph entirely → `Cmd+Shift+B` → yaml `history` grows by one; deleted id has `replaced_by: []`
N+7. In a *different* `.md`, paste `((<other-doc-name>.md#b-xxxxxx))` (use a real id from N+2) → switch to rich view → pill renders → click pill → other doc opens, jumps to the right line
N+8. Same in source mode: place cursor inside a `((..))` token → press `Cmd+Enter` → same jump
```

- [ ] **Step 2: Add `.gitignore` entry**

Modify `.gitignore`. Append:

```
# mdblock generated artifacts (the .yaml is the source of truth and IS tracked)
*.block.md
*.block.yaml.tmp
*.block.yaml.broken-*
*.block.md.tmp
```

- [ ] **Step 3: Commit**

```bash
git add README.md .gitignore
git commit -m "docs(mdblock): smoke test entries and .gitignore"
```

---

### Task 30: Final manual smoke pass + CHANGELOG entry

**Files:**
- Modify: `CHANGELOG.md` (if present) or skip

- [ ] **Step 1: Run the full test suite**

Run: `pnpm test`
Expected: all blockchunk + blockio + mdblock-hover unit tests pass.

- [ ] **Step 2: Run `pnpm check`**

Run: `pnpm check`
Expected: no TypeScript or svelte-check errors.

- [ ] **Step 3: Manual smoke**

Run: `pnpm tauri dev`
Walk the smoke checklist from Task 29. Specifically verify:

- yaml is human-readable (`cat <basename>.block.yaml`)
- `.block.md` opens cleanly in another markdown viewer (e.g., GitHub web), with anchors invisible
- citation pill renders correctly across light/dark themes
- gutter aligns with logical text rows (no soft-wrap drift)
- rich overlay frames sit cleanly around each rendered block

If anything fails, capture the failure mode and add a follow-up task; do not silently patch.

- [ ] **Step 4: CHANGELOG entry**

If a top-level `CHANGELOG.md` exists, prepend an `## [Unreleased]` entry:

```markdown
## [Unreleased]

### Added

- **mdblock**: assign stable, edit-resilient block ids to markdown documents.
  Generates `<basename>.block.yaml` (id source of truth, full lineage)
  and on demand `<basename>.block.md` (with HTML anchors) for AI source
  attribution at sub-page granularity. Cite blocks via `((doc.md#b-xxxxxx))`;
  citations resolve through a history chain so old references survive edits.
  Optional in-editor visualization shows block boundaries in source gutter
  and rich-mode borders. Opt-in via Settings → Block.
```

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): mdblock feature entry"
```

---

## Self-Review

**Spec coverage check** — every section of `2026-05-10-md-block-splitting-design.md` maps to tasks:

| Spec section | Plan tasks |
|---|---|
| (a) Splitting algorithm | Tasks 2, 3, 4, 5 |
| (b) Block identity & merge | Tasks 6, 7, 8 |
| (c) yaml schema & lineage | Tasks 9, 10, 15 (lineage population) |
| (d) `.block.md` generation | Tasks 11, 15 (writeBlockMdIfNeeded) |
| (e) Citation parsing & navigation | Tasks 12, 13, 24, 25, 26 |
| (f) `mdblock-hover` visualization | Tasks 19, 20, 21, 22, 23 |
| (g) Module organization & settings | Tasks 1, 14, 27, 28 |
| (h) Test strategy | Each task includes its tests; manual smoke = Task 29, 30 |
| Auto-refresh on save | Task 18 |
| `.gitignore` for build artifacts | Task 29 |

No unmapped spec requirements.

**Type consistency check**:

- `BlockFingerprint` (defined Task 6) used identically in Task 8 (merge.ts) and Task 9 (yaml-schema.ts).
- `Block` (defined Task 5) flows into the command layer via `chunkDocument` return.
- `ActiveBlock`, `RetiredBlock`, `BlockYaml` (defined Task 9) used consistently throughout Phase 2 and 3.
- `MergeOutcome` (defined Task 8) consumed only inside `commands.ts` Task 15; field names match.
- `ParsedCitation` (Task 12) and `ResolvedCitation` (Task 13) are the only citation public types; consistent.
- `LineBlockEntry` (Task 19) consumed only in Task 21 (gutter); consistent.
- `MdblockSettings` (Task 14) is the single settings type; all components import the runtime `settings.mdblock.*` directly, no re-typing.

**Placeholder scan**:

- No "TBD", "TODO", or "implement later" anywhere.
- One conscious caveat in Task 17 — `cmdMdblockFollowCitationAtCursor` queries the DOM via `document.querySelector('.source-pane textarea')`. If the actual SourceView class name differs, Task 23's wrapper introduces `.source-pane` on a `<div>` (line listed) so the query is correct.
- Task 25 mentions "Wherever marked is set up" — that's a known pre-existing call site in mdeditor (used by `marked-katex-extension`, `marked-highlight`); the implementer locates it via `grep -n "marked.use" src/`.
- Task 28's menu wiring acknowledges variability in mdeditor's actual menu API and gives a fallback (gate at action time) — this is a deliberate concession, not a placeholder.

**Plan complete and saved to `docs/superpowers/plans/2026-05-10-md-block-splitting.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
