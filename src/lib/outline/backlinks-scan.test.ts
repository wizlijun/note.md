import { beforeEach, describe, expect, it, vi } from 'vitest'
import { backlinksFor, buildFolderIndex, createIndex, indexFileContent, pageCandidates, refreshFileInIndex } from './backlinks'

const fs = vi.hoisted(() => ({ readDir: vi.fn(), readTextFile: vi.fn(), stat: vi.fn() }))
const migrate = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/plugin-fs', () => fs)
vi.mock('./migrate', () => ({
  migrateLegacyFile: migrate,
  migratedPathFor: (path: string) => path.replace(/\.notes\.md$/i, '.note.md'),
}))

const indexText = '# 索引\n## 工作\n- [方案](./方案.md) #设计\n- [清单](./清单.md) [[设计]]\n'
const entry = (name: string, isDirectory = false, isSymlink = false) => ({ name, isDirectory, isSymlink })

beforeEach(() => {
  vi.resetAllMocks()
  fs.stat.mockResolvedValue({ size: 128, isSymlink: false })
  fs.readDir.mockResolvedValue([])
  fs.readTextFile.mockResolvedValue(indexText)
  migrate.mockResolvedValue('renamed')
})

describe('backlink source scans', () => {
  it('recursively reads index sources and notes, skips ordinary Markdown/hidden/symlink/oversize sources, and preserves legacy migration', async () => {
    fs.readDir.mockImplementation(async (dir: string) => dir === '/v' ? [
      entry('wikipage', true), entry('.hidden', true), entry('linked', true, true), entry('regular.md'),
    ] : dir === '/v/wikipage' ? [
      entry('catalog.index.md'), entry('legacy.notes.md'), entry('large.index.md'),
      entry('.hidden.index.md'), entry('linked.index.md', false, true), entry('unknown.index.md'),
    ] : [])
    fs.stat.mockImplementation(async (path: string) => {
      if (path.endsWith('unknown.index.md')) throw new Error('unreadable')
      return { size: path.endsWith('large.index.md') ? 1024 * 1024 + 1 : 128 }
    })
    fs.readTextFile.mockImplementation(async (path: string) => path.endsWith('.index.md') ? indexText : '- [[设计]]')
    const idx = await buildFolderIndex('/v', ['wikipage'])
    expect(fs.readDir.mock.calls.map(call => call[0])).toEqual(['/v', '/v/wikipage'])
    expect(fs.readTextFile.mock.calls.map(call => call[0])).toEqual(['/v/wikipage/catalog.index.md', '/v/wikipage/legacy.note.md'])
    expect(migrate).toHaveBeenCalledExactlyOnceWith('/v/wikipage/legacy.notes.md')
    expect(pageCandidates(idx)).toEqual(['legacy'])
    expect(backlinksFor(idx, '设计').map(hit => [hit.file, hit.line])).toEqual([
      ['/v/wikipage/catalog.index.md', 3], ['/v/wikipage/catalog.index.md', 4], ['/v/wikipage/legacy.note.md', 1],
    ])
  })

  it('retains migration conflict notification and indexes the unrenamed note', async () => {
    fs.readDir.mockResolvedValue([entry('legacy.notes.md')])
    fs.readTextFile.mockResolvedValue('- [[设计]]')
    migrate.mockResolvedValue('conflict')
    const onConflict = vi.fn()
    const idx = await buildFolderIndex('/v', ['wikipage'], onConflict)
    expect(onConflict).toHaveBeenCalledExactlyOnceWith('/v/legacy.notes.md')
    expect(backlinksFor(idx, '设计')[0].file).toBe('/v/legacy.notes.md')
  })

  it('updates both sides of an index rename and removes old references when a file exceeds 1MB', async () => {
    const idx = createIndex({ root: '/v', dirs: ['wikipage'] })
    const oldPath = '/v/old.index.md'
    const newPath = '/v/wikipage/new.index.md'
    indexFileContent(idx, oldPath, indexText)
    fs.stat.mockImplementation(async (path: string) => {
      if (path === oldPath) throw new Error('ENOENT')
      return { size: 1024 * 1024 }
    })
    await refreshFileInIndex(idx, oldPath)
    await refreshFileInIndex(idx, newPath)
    expect(backlinksFor(idx, '设计').map(hit => hit.file)).toEqual([newPath, newPath])
    expect(pageCandidates(idx)).toEqual([])
    fs.stat.mockResolvedValue({ size: 1024 * 1024 + 1 })
    fs.readTextFile.mockClear()
    await refreshFileInIndex(idx, newPath)
    expect(backlinksFor(idx, '设计')).toEqual([])
    expect(fs.readTextFile).not.toHaveBeenCalled()
  })

  it('ignores ordinary Markdown refreshes and removes sources that become unreadable', async () => {
    const idx = createIndex()
    await refreshFileInIndex(idx, '/v/regular.md')
    expect(fs.stat).not.toHaveBeenCalled()
    indexFileContent(idx, '/v/catalog.index.md', indexText)
    fs.stat.mockRejectedValue(new Error('unreadable'))
    await refreshFileInIndex(idx, '/v/catalog.index.md')
    expect(backlinksFor(idx, '设计')).toEqual([])
    expect(fs.readTextFile).not.toHaveBeenCalled()
  })
})
