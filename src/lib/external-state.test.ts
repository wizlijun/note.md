import { describe, it, expect } from 'vitest'
import { decide, type ExternalEvent, type TabSnapshot } from './external-state'

const fresh = (overrides: Partial<TabSnapshot> = {}): TabSnapshot => ({
  initialContent: 'A',
  currentContent: 'A',
  lastKnownMtime: 1000,
  lastKnownHash: 'h-A',
  externalState: 'fresh',
  ...overrides,
})

const modifiedEvent = (mtime: number, hash: string, content: string): ExternalEvent =>
  ({ type: 'modified', snapshot: { mtime, hash, content } })

describe('decide', () => {
  it('clean tab + external modify → autoReload', () => {
    const d = decide(fresh(), modifiedEvent(2000, 'h-B', 'B'))
    expect(d).toEqual({ kind: 'autoReload', snapshot: { mtime: 2000, hash: 'h-B', content: 'B' } })
  })

  it('dirty tab + external modify → showChanged', () => {
    const d = decide(fresh({ currentContent: 'A-edited' }), modifiedEvent(2000, 'h-B', 'B'))
    expect(d).toEqual({ kind: 'showChanged', snapshot: { mtime: 2000, hash: 'h-B', content: 'B' } })
  })

  it('matching mtime+hash → ignore (self-write echo)', () => {
    const d = decide(fresh(), modifiedEvent(1000, 'h-A', 'A'))
    expect(d).toEqual({ kind: 'ignore' })
  })

  it('different mtime but identical hash → ignore (touch only)', () => {
    const d = decide(fresh(), modifiedEvent(9999, 'h-A', 'A'))
    expect(d).toEqual({ kind: 'ignore' })
  })

  it('delete event on fresh tab → showDeleted', () => {
    const d = decide(fresh(), { type: 'deleted' })
    expect(d).toEqual({ kind: 'showDeleted' })
  })

  it('delete event on already-deleted tab → ignore', () => {
    const d = decide(fresh({ externalState: 'deleted' }), { type: 'deleted' })
    expect(d).toEqual({ kind: 'ignore' })
  })

  it('modify on already-deleted tab (file was recreated) → showChanged when dirty', () => {
    const d = decide(
      fresh({ externalState: 'deleted', currentContent: 'A-edited' }),
      modifiedEvent(2000, 'h-B', 'B'),
    )
    expect(d).toEqual({ kind: 'showChanged', snapshot: { mtime: 2000, hash: 'h-B', content: 'B' } })
  })
})
