import { describe, it, expect } from 'vitest'
import { parentDir, isWithinDir, sortEntries, type FolderEntry } from './folder-view.svelte'
import { vi, beforeEach } from 'vitest'

// Mock the Tauri plugins used by the module's side-effects.
const readDirMock = vi.fn()
vi.mock('@tauri-apps/plugin-fs', () => ({
  readDir: (...args: unknown[]) => readDirMock(...args),
}))
const storeGet = vi.fn()
const storeSet = vi.fn()
const storeSave = vi.fn()
vi.mock('@tauri-apps/plugin-store', () => ({
  Store: { load: vi.fn(async () => ({ get: storeGet, set: storeSet, save: storeSave })) },
}))

import {
  folderView,
  readFolder,
  syncToActiveFile,
  toggleExpanded,
  loadFolderViewState,
  setVisible,
  setWidth,
} from './folder-view.svelte'

beforeEach(() => {
  readDirMock.mockReset()
  storeGet.mockReset(); storeSet.mockReset(); storeSave.mockReset()
  folderView.visible = false
  folderView.width = 240
  folderView.rootDir = null
  folderView.expanded = new Set()
  folderView.entriesCache = new Map()
})

describe('readFolder', () => {
  it('reads, classifies, sorts, and caches directory entries', async () => {
    readDirMock.mockResolvedValue([
      { name: 'note.md', isDirectory: false, isFile: true },
      { name: 'sub', isDirectory: true, isFile: false },
      { name: '.hidden', isDirectory: false, isFile: true },
      { name: 'pic.png', isDirectory: false, isFile: true },
    ])
    const out = await readFolder('/root')
    expect(out.map((e) => e.name)).toEqual(['sub', 'note.md', 'pic.png']) // dotfile filtered, folder first
    expect(out.find((e) => e.name === 'note.md')?.kind).toBe('markdown')
    expect(folderView.entriesCache.get('/root')).toEqual(out) // cached
  })
})

describe('syncToActiveFile', () => {
  it('resets root to the file parent when outside current subtree', async () => {
    readDirMock.mockResolvedValue([])
    folderView.rootDir = '/other'
    await syncToActiveFile('/a/b/c.md')
    expect(folderView.rootDir).toBe('/a/b')
  })
  it('keeps root when the file is within the current subtree', async () => {
    readDirMock.mockResolvedValue([])
    folderView.rootDir = '/a'
    await syncToActiveFile('/a/b/c.md')
    expect(folderView.rootDir).toBe('/a')
  })
  it('ignores null (untitled) files', async () => {
    folderView.rootDir = '/a'
    await syncToActiveFile(null)
    expect(folderView.rootDir).toBe('/a')
  })
})

describe('toggleExpanded', () => {
  it('adds then removes a path', async () => {
    readDirMock.mockResolvedValue([])
    await toggleExpanded('/a/sub')
    expect(folderView.expanded.has('/a/sub')).toBe(true)
    await toggleExpanded('/a/sub')
    expect(folderView.expanded.has('/a/sub')).toBe(false)
  })
})

describe('persistence', () => {
  it('hydrates visible+width from the store', async () => {
    storeGet.mockImplementation(async (k: string) =>
      k === 'folderView.visible' ? true : k === 'folderView.width' ? 300 : undefined)
    await loadFolderViewState()
    expect(folderView.visible).toBe(true)
    expect(folderView.width).toBe(300)
  })
  it('setVisible writes through to the store', async () => {
    await setVisible(true)
    expect(folderView.visible).toBe(true)
    expect(storeSet).toHaveBeenCalledWith('folderView.visible', true)
    expect(storeSave).toHaveBeenCalled()
  })
  it('setWidth clamps to [160, 480] and persists', async () => {
    await setWidth(9999)
    expect(folderView.width).toBe(480)
    expect(storeSet).toHaveBeenCalledWith('folderView.width', 480)
  })
})

describe('parentDir', () => {
  it('returns parent of a file path', () => {
    expect(parentDir('/a/b/c.md')).toBe('/a/b')
  })
  it('returns parent of a directory path (no trailing slash)', () => {
    expect(parentDir('/a/b')).toBe('/a')
  })
  it('strips a trailing slash before computing', () => {
    expect(parentDir('/a/b/')).toBe('/a')
  })
  it('returns "/" when parent is root', () => {
    expect(parentDir('/a')).toBe('/')
  })
  it('returns "/" for root itself', () => {
    expect(parentDir('/')).toBe('/')
  })
})

describe('isWithinDir', () => {
  it('true for a direct child file', () => {
    expect(isWithinDir('/a/b/c.md', '/a/b')).toBe(true)
  })
  it('true for a nested descendant', () => {
    expect(isWithinDir('/a/b/deep/c.md', '/a/b')).toBe(true)
  })
  it('false for a sibling directory', () => {
    expect(isWithinDir('/a/bb/c.md', '/a/b')).toBe(false)
  })
  it('tolerates a trailing slash on dir', () => {
    expect(isWithinDir('/a/b/c.md', '/a/b/')).toBe(true)
  })
  it('false when file is the dir itself', () => {
    expect(isWithinDir('/a/b', '/a/b')).toBe(false)
  })
})

describe('sortEntries', () => {
  it('puts folders before files, each name-sorted case-insensitively', () => {
    const input: FolderEntry[] = [
      { name: 'zebra.md', path: '/x/zebra.md', isDir: false, kind: 'markdown' },
      { name: 'Apple', path: '/x/Apple', isDir: true, kind: null },
      { name: 'banana.md', path: '/x/banana.md', isDir: false, kind: 'markdown' },
      { name: 'apricot', path: '/x/apricot', isDir: true, kind: null },
    ]
    const out = sortEntries(input).map((e) => e.name)
    expect(out).toEqual(['Apple', 'apricot', 'banana.md', 'zebra.md'])
  })
})
