import { describe, expect, it } from 'vitest'
import { localResourceCandidates } from './local-resource'

const context = { baseDir: '/vault/notes', vaultRoot: '/vault' }

describe('localResourceCandidates', () => {
  it('prefers vault root and retains the filesystem-absolute fallback', () => {
    expect(localResourceCandidates('/ssot/The%20Angel%20VC/chart.png', context)).toEqual([
      '/vault/ssot/The Angel VC/chart.png', '/ssot/The Angel VC/chart.png',
    ])
  })

  it.each([
    ['a.png', ['/vault/notes/a.png']],
    ['./a.png', ['/vault/notes/a.png']],
    ['../assets/a.png', ['/vault/assets/a.png']],
    ['/../../assets/a.png', ['/vault/assets/a.png', '/assets/a.png']],
    ['file:///tmp/a%20b.png', ['/tmp/a b.png']],
    ['file://localhost/tmp/a.png', ['/tmp/a.png']],
    ['file:///C:/notes/a%20b.png', ['C:/notes/a b.png']],
    ['file://server/share/a%20b.png', ['//server/share/a b.png']],
    ['C:\\notes\\a%20b.png', ['C:/notes/a b.png']],
    ['100%.png', ['/vault/notes/100%.png']],
    ['bad%2.png', ['/vault/notes/bad%2.png']],
    ['./part%23one%3F%2520.png?q=2#anchor', ['/vault/notes/part#one?%20.png']],
  ])('resolves %s without losing path semantics', (src, expected) => {
    expect(localResourceCandidates(src, context)).toEqual(expected)
  })

  it('never decodes the filesystem base directory', () => {
    expect(localResourceCandidates('./a%20b.png', { baseDir: '/vault/literal%20' }))
      .toEqual(['/vault/literal%20/a b.png'])
  })

  it('handles Windows vaults and document-relative parent segments', () => {
    const win = { vaultRoot: 'D:\\vault', baseDir: 'D:\\vault\\notes' }
    expect(localResourceCandidates('/assets/a.png', win)).toEqual(['D:/vault/assets/a.png', '/assets/a.png'])
    expect(localResourceCandidates('../a.png', win)).toEqual(['D:/vault/a.png'])
  })

  it('deduplicates candidates for a filesystem-root vault', () => {
    expect(localResourceCandidates('/a.png', { vaultRoot: '/' })).toEqual(['/a.png'])
  })

  it('requires a directory for relative paths, not root-relative paths', () => {
    expect(localResourceCandidates('a.png')).toEqual([])
    expect(localResourceCandidates('/a.png')).toEqual(['/a.png'])
    expect(localResourceCandidates('/a.png', { vaultRoot: '/vault' })).toEqual(['/vault/a.png', '/a.png'])
  })

  it.each(['', '#anchor', '?q=2', 'https://a/b', '//example.com/a', 'data:image/png;base64,YQ==', 'blob:image', 'javascript:alert(1)', 'ftp://host/a'])('does not resolve non-file targets: %s', (src) => {
    expect(localResourceCandidates(src, context)).toEqual([])
  })
})
