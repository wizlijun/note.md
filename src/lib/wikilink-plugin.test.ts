import { describe, it, expect } from 'vitest'
import { WIKILINK_RE } from './wikilink-plugin'

/** Collect every wikilink target found in a string. */
function targets(text: string): string[] {
  WIKILINK_RE.lastIndex = 0
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = WIKILINK_RE.exec(text)) !== null) out.push(m[1])
  return out
}

describe('WIKILINK_RE', () => {
  it('matches a single wikilink', () => {
    expect(targets('see [[subagent-cwd-not-worktree]] here')).toEqual(['subagent-cwd-not-worktree'])
  })

  it('matches multiple wikilinks on one line', () => {
    expect(targets('[[a]] and [[b/c]]')).toEqual(['a', 'b/c'])
  })

  it('captures alias targets verbatim (split happens later)', () => {
    expect(targets('[[foo|Display]]')).toEqual(['foo|Display'])
  })

  it('does not match empty or nested brackets', () => {
    expect(targets('[[]]')).toEqual([])
    expect(targets('a [ [x] ] b')).toEqual([])
  })

  it('does not span across newlines', () => {
    expect(targets('[[a\nb]]')).toEqual([])
  })
})
