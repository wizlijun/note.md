import { describe, it, expect } from 'vitest'
import {
  parentDir, isWithinDir, sortEntries,
  makeFilterMatcher, computeFilterVisibility, type FolderEntry,
  pairNoteEntries, parsePinned, applyNotesOnly,
} from './folder-view.svelte'
import { vi, beforeEach } from 'vitest'
import { SvelteMap, SvelteSet } from 'svelte/reactivity'

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
const isPluginEnabledMock = vi.fn((..._args: unknown[]) => true)
vi.mock('./settings.svelte', () => ({
  isPluginEnabled: (...args: unknown[]) => isPluginEnabledMock(...args),
}))

import {
  folderView,
  readFolder,
  syncToActiveFile,
  toggleExpanded,
  loadFolderViewState,
  setVisible,
  setWidth,
  PLUGIN_ID,
} from './folder-view.svelte'

beforeEach(() => {
  readDirMock.mockReset()
  storeGet.mockReset(); storeSet.mockReset(); storeSave.mockReset()
  isPluginEnabledMock.mockReset(); isPluginEnabledMock.mockReturnValue(true)
  folderView.enabled = true
  folderView.visible = false
  folderView.width = 240
  folderView.rootDir = null
  folderView.filter = ''
  folderView.filterVisible = new SvelteSet()
  folderView.expanded = new SvelteSet()
  folderView.entriesCache = new SvelteMap()
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
  it('hydrates enabled from isPluginEnabled(folder-view)', async () => {
    storeGet.mockResolvedValue(undefined)
    isPluginEnabledMock.mockReturnValue(false)
    await loadFolderViewState()
    expect(isPluginEnabledMock).toHaveBeenCalledWith(PLUGIN_ID)
    expect(folderView.enabled).toBe(false)
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

describe('makeFilterMatcher', () => {
  it('returns null for empty or blank queries (match everything)', () => {
    expect(makeFilterMatcher('')).toBeNull()
    expect(makeFilterMatcher('   ')).toBeNull()
  })
  it('matches case-insensitively as a regex', () => {
    const m = makeFilterMatcher('READ')!
    expect(m('readme.md')).toBe(true)
    expect(m('notes.md')).toBe(false)
  })
  it('supports regex syntax', () => {
    const m = makeFilterMatcher('^a.*\\.md$')!
    expect(m('apple.md')).toBe(true)
    expect(m('banana.md')).toBe(false)
    expect(m('apple.txt')).toBe(false)
  })
  it('falls back to substring match on an invalid regex', () => {
    const m = makeFilterMatcher('a(')! // unbalanced group
    expect(m('data(1).md')).toBe(true)
    expect(m('nope.md')).toBe(false)
  })
})

describe('computeFilterVisibility', () => {
  // /r ├ docs ├ deep ├ target.md
  //    │      └ guide.md
  //    └ readme.md
  const cache = new Map<string, FolderEntry[]>([
    ['/r', [
      { name: 'docs', path: '/r/docs', isDir: true, kind: null },
      { name: 'readme.md', path: '/r/readme.md', isDir: false, kind: 'markdown' },
    ]],
    ['/r/docs', [
      { name: 'deep', path: '/r/docs/deep', isDir: true, kind: null },
      { name: 'guide.md', path: '/r/docs/guide.md', isDir: false, kind: 'markdown' },
    ]],
    ['/r/docs/deep', [
      { name: 'target.md', path: '/r/docs/deep/target.md', isDir: false, kind: 'markdown' },
    ]],
  ])

  it('returns null for an empty query (show everything)', () => {
    expect(computeFilterVisibility('/r', cache, '')).toBeNull()
  })

  it('reveals a deep file match and every ancestor folder', () => {
    const vis = computeFilterVisibility('/r', cache, 'target')!
    expect([...vis].sort()).toEqual(
      ['/r/docs', '/r/docs/deep', '/r/docs/deep/target.md'].sort(),
    )
    expect(vis.has('/r/readme.md')).toBe(false)
    expect(vis.has('/r/docs/guide.md')).toBe(false)
  })

  it('includes the whole subtree when a folder name matches', () => {
    const vis = computeFilterVisibility('/r', cache, 'docs')!
    expect(vis.has('/r/docs')).toBe(true)
    expect(vis.has('/r/docs/deep')).toBe(true)
    expect(vis.has('/r/docs/deep/target.md')).toBe(true)
    expect(vis.has('/r/docs/guide.md')).toBe(true)
    expect(vis.has('/r/readme.md')).toBe(false)
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

function ent(name: string, over: Partial<FolderEntry> = {}): FolderEntry {
  return { name, path: '/d/' + name, isDir: false, kind: 'markdown', ...over }
}

describe('sortEntries sort keys + pinning', () => {
  it('name: folders first then name asc', () => {
    const input = [ent('b.md'), ent('dir', { isDir: true, kind: null }), ent('a.md')]
    expect(sortEntries(input, 'name', []).map((e) => e.name)).toEqual(['dir', 'a.md', 'b.md'])
  })
  it('edited: mtime desc, tie→name', () => {
    const input = [ent('a.md', { mtime: 10 }), ent('b.md', { mtime: 30 }), ent('c.md', { mtime: 30 })]
    expect(sortEntries(input, 'edited', []).map((e) => e.name)).toEqual(['b.md', 'c.md', 'a.md'])
  })
  it('created: birthtime desc', () => {
    const input = [ent('a.md', { birthtime: 5 }), ent('b.md', { birthtime: 50 })]
    expect(sortEntries(input, 'created', []).map((e) => e.name)).toEqual(['b.md', 'a.md'])
  })
  it('pinned group first in array order, rest sorted; missing pins ignored', () => {
    const input = [ent('a.md', { mtime: 1 }), ent('b.md', { mtime: 9 }), ent('c.md', { mtime: 5 })]
    const out = sortEntries(input, 'edited', ['c.md', 'ghost.md', 'a.md']).map((e) => e.name)
    expect(out).toEqual(['c.md', 'a.md', 'b.md'])
  })
})

describe('parsePinned', () => {
  it('parses a valid pinned array of strings', () => {
    expect(parsePinned('{"pinned":["a.md","dir"]}')).toEqual(['a.md', 'dir'])
  })
  it('bad json / missing / non-array / non-strings → []', () => {
    expect(parsePinned('not json')).toEqual([])
    expect(parsePinned('{}')).toEqual([])
    expect(parsePinned('{"pinned":"x"}')).toEqual([])
    expect(parsePinned('{"pinned":[1,"ok",null]}')).toEqual(['ok'])
  })
})

describe('applyNotesOnly', () => {
  const rows: FolderEntry[] = [
    { name: 'dir', path: '/d/dir', isDir: true, kind: null },
    { name: 'has.md', path: '/d/has.md', isDir: false, kind: 'markdown', hasNote: true, notePath: '/d/has.note.md' },
    { name: 'plain.md', path: '/d/plain.md', isDir: false, kind: 'markdown' },
    { name: 'solo.note.md', path: '/d/solo.note.md', isDir: false, kind: 'markdown', isOutlineNote: true },
  ]
  it('false → unchanged', () => {
    expect(applyNotesOnly(rows, false)).toHaveLength(4)
  })
  it('true → keep folders + hasNote only', () => {
    expect(applyNotesOnly(rows, true).map((e) => e.name)).toEqual(['dir', 'has.md'])
  })
})

function f(name: string, isDir = false): FolderEntry {
  return { name, path: `/r/${name}`, isDir, kind: isDir ? null : 'markdown' }
}

describe('pairNoteEntries', () => {
  it('hides companion .note.md and marks its main file', () => {
    const out = pairNoteEntries([f('a.md'), f('a.note.md'), f('b.md')])
    expect(out.map(e => e.name)).toEqual(['a.md', 'b.md'])
    const a = out.find(e => e.name === 'a.md')!
    expect(a.hasNote).toBe(true)
    expect(a.notePath).toBe('/r/a.note.md')
    expect(out.find(e => e.name === 'b.md')!.hasNote).toBeUndefined()
  })
  it('legacy .notes.md pairs too', () => {
    const out = pairNoteEntries([f('a.md'), f('a.notes.md')])
    expect(out.map(e => e.name)).toEqual(['a.md'])
    expect(out[0].notePath).toBe('/r/a.notes.md')
  })
  it('standalone .note.md stays with isOutlineNote flag', () => {
    const out = pairNoteEntries([f('wiki.note.md')])
    expect(out).toHaveLength(1)
    expect(out[0].isOutlineNote).toBe(true)
  })
  it('directories and non-md untouched', () => {
    const out = pairNoteEntries([f('sub', true), f('x.png')])
    expect(out).toHaveLength(2)
  })
})
