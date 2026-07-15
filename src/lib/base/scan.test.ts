import { describe, it, expect } from 'vitest'
import { extractFrontmatter, scanBaseDir, type ScanDeps } from './scan'

describe('extractFrontmatter', () => {
  it('parses leading YAML frontmatter and tags', () => {
    const { data, tags } = extractFrontmatter('---\nstatus: read\ntags: [a, b]\n---\nbody')
    expect(data).toEqual({ status: 'read', tags: ['a', 'b'] })
    expect(tags).toEqual(['a', 'b'])
  })
  it('returns empty for no frontmatter', () => {
    expect(extractFrontmatter('# just body').data).toEqual({})
  })
  it('normalizes a single string tag', () => {
    expect(extractFrontmatter('---\ntags: solo\n---').tags).toEqual(['solo'])
  })
})

describe('scanBaseDir', () => {
  it('recursively collects md records, skipping dotfiles and non-md', () => {
    const tree: Record<string, { name: string; isDirectory: boolean }[]> = {
      '/v': [
        { name: 'a.md', isDirectory: false },
        { name: 'note.txt', isDirectory: false },
        { name: '.hidden.md', isDirectory: false },
        { name: 'a.note.md', isDirectory: false },
        { name: 'x.notes.md', isDirectory: false },
        { name: 'sub', isDirectory: true },
      ],
      '/v/sub': [{ name: 'b.md', isDirectory: false }],
    }
    const deps: ScanDeps = {
      readDir: async (d) => tree[d] ?? [],
      stat: async () => ({ mtime: new Date(1000), birthtime: new Date(500), size: 12 }),
      readTextFile: async (p) => (p.endsWith('a.md') ? '---\nstatus: read\n---\n' : ''),
    }
    return scanBaseDir('/v', deps).then((recs) => {
      const names = recs.map((r) => r.name).sort()
      expect(names).toEqual(['a.md', 'b.md'])
      const a = recs.find((r) => r.name === 'a.md')!
      expect(a.folder).toBe('/v')
      expect(a.mtime).toBe(1000)
      expect(a.frontmatter).toEqual({ status: 'read' })
    })
  })
})
