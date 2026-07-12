import { describe, it, expect } from 'vitest'
import { parseUnifiedDiff } from './diff-parse'

describe('parseUnifiedDiff', () => {
  it('classifies git-show header lines as meta (no line numbers)', () => {
    const src = [
      'commit abcdef1234',
      'Author: Jane <j@x>',
      'Date:   Mon',
      '',
      '    vault: auto-sync',
      '',
      'diff --git a/f.md b/f.md',
      'index 000..111 100644',
      '--- a/f.md',
      '+++ b/f.md',
      '@@ -1,2 +1,2 @@',
      ' keep',
      '-old',
      '+new',
    ].join('\n')
    const rows = parseUnifiedDiff(src)
    // everything before the hunk is meta
    const preHunk = rows.slice(0, rows.findIndex((r) => r.type === 'hunk'))
    expect(preHunk.every((r) => r.type === 'meta')).toBe(true)
    expect(preHunk.every((r) => r.oldLn === null && r.newLn === null)).toBe(true)
  })

  it('tracks old/new line numbers across context/add/del', () => {
    const src = [
      '@@ -1,2 +1,2 @@',
      ' keep',
      '-old',
      '+new',
    ].join('\n')
    const rows = parseUnifiedDiff(src).filter((r) => r.type !== 'hunk')
    expect(rows).toEqual([
      { type: 'context', oldLn: 1, newLn: 1, text: 'keep' },
      { type: 'del', oldLn: 2, newLn: null, text: 'old' },
      { type: 'add', oldLn: null, newLn: 2, text: 'new' },
    ])
  })

  it('handles a new-file diff (all additions) with numbering from 1', () => {
    const src = [
      'diff --git a/f.md b/f.md',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/f.md',
      '@@ -0,0 +1,2 @@',
      '+line one',
      '+line two',
    ].join('\n')
    const adds = parseUnifiedDiff(src).filter((r) => r.type === 'add')
    expect(adds.map((r) => [r.newLn, r.text])).toEqual([
      [1, 'line one'],
      [2, 'line two'],
    ])
    expect(adds.every((r) => r.oldLn === null)).toBe(true)
  })

  it('does NOT mistake a deleted "- item" line for a --- file header', () => {
    // removing a markdown list item "- item" appears as "-- item" in the diff
    const src = ['@@ -1,1 +0,0 @@', '-- item'].join('\n')
    const rows = parseUnifiedDiff(src).filter((r) => r.type !== 'hunk')
    expect(rows).toEqual([{ type: 'del', oldLn: 1, newLn: null, text: '- item' }])
  })

  it('resets numbering per hunk and handles multi-hunk diffs', () => {
    const src = [
      '@@ -1,1 +1,1 @@',
      ' a',
      '@@ -10,1 +12,2 @@',
      ' b',
      '+c',
    ].join('\n')
    const rows = parseUnifiedDiff(src).filter((r) => r.type === 'context' || r.type === 'add')
    expect(rows).toEqual([
      { type: 'context', oldLn: 1, newLn: 1, text: 'a' },
      { type: 'context', oldLn: 10, newLn: 12, text: 'b' },
      { type: 'add', oldLn: null, newLn: 13, text: 'c' },
    ])
  })

  it('marks the "\\ No newline at end of file" note as meta', () => {
    const src = ['@@ -1,1 +1,1 @@', '-a', '+b', '\\ No newline at end of file'].join('\n')
    const rows = parseUnifiedDiff(src)
    expect(rows[rows.length - 1]).toEqual({ type: 'meta', oldLn: null, newLn: null, text: '\\ No newline at end of file' })
  })

  it('drops only the trailing newline artifact, keeping blank context lines', () => {
    const src = '@@ -1,2 +1,2 @@\n a\n \n' // blank context line then trailing newline
    const rows = parseUnifiedDiff(src).filter((r) => r.type === 'context')
    expect(rows).toEqual([
      { type: 'context', oldLn: 1, newLn: 1, text: 'a' },
      { type: 'context', oldLn: 2, newLn: 2, text: '' },
    ])
  })
})
