import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openFileViewPage } from './file-view-pages'
import { teardownIndex } from '../outline/backlinks-io.svelte'
import { createIndex } from '../outline/backlinks'
import { sotvaultStore } from '../sotvault.svelte'
import { outlineDirs } from '../outline/dirs.svelte'
import { outline } from '../outline/store.svelte'
import { setBlockedWikilinks } from '../wikilink/blocklist'

const io = vi.hoisted(() => ({
  openFile: vi.fn(), exists: vi.fn(), writeTextFile: vi.fn(), buildFolderIndex: vi.fn(), ready: vi.fn(),
}))
vi.mock('../tabs.svelte', () => ({ openFile: io.openFile }))
vi.mock('../wikilink/blocklist-io.svelte', () => ({ whenWikilinkBlocklistReady: io.ready }))
vi.mock('../okf/identity', () => ({ humanActor: async () => 'human:test' }))
vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: io.exists, writeTextFile: io.writeTextFile,
  mkdir: vi.fn(async () => {}), watchImmediate: vi.fn(async () => () => {}),
}))
vi.mock('../outline/backlinks', async (original) => ({
  ...await original<typeof import('../outline/backlinks')>(), buildFolderIndex: io.buildFolderIndex,
}))

describe('file-view page navigation uses host wiki rules', () => {
  const source = '/vault/indexes/资料.index.md'
  const vaultIndex = () => createIndex({ root: '/vault', dirs: ['我的百科', '我的日记'] })
  beforeEach(() => {
    vi.resetAllMocks()
    sotvaultStore.vaultRoot = '/vault'
    outline.docPath = null
    outlineDirs.wikipage = '我的百科'
    outlineDirs.dailynote = '我的日记'
    setBlockedWikilinks([])
    io.exists.mockResolvedValue(false)
    io.openFile.mockResolvedValue(undefined)
    io.writeTextFile.mockResolvedValue(undefined)
    io.ready.mockResolvedValue(undefined)
    io.buildFolderIndex.mockResolvedValue(vaultIndex())
  })
  afterEach(() => {
    teardownIndex()
    sotvaultStore.vaultRoot = null
    outlineDirs.wikipage = 'wikipage'
    outlineDirs.dailynote = 'dailynote'
    setBlockedWikilinks([])
  })

  it('resolves an existing page in the Vault without writing the source or page', async () => {
    const index = vaultIndex()
    index.filePages.set('/vault/我的百科/开发.note.md', '开发')
    io.buildFolderIndex.mockResolvedValue(index)
    await openFileViewPage(source, '开发', () => true)
    expect(io.buildFolderIndex).toHaveBeenCalledWith('/vault', ['我的百科', '我的日记'], expect.any(Function))
    expect(io.openFile).toHaveBeenCalledWith('/vault/我的百科/开发.note.md')
    expect(io.writeTextFile).not.toHaveBeenCalled()
  })

  it('creates only a missing wiki page using the configured directory and standard metadata', async () => {
    await openFileViewPage(source, '主题/设计', () => true)
    expect(io.writeTextFile).toHaveBeenCalledOnce()
    expect(io.writeTextFile).toHaveBeenCalledWith('/vault/我的百科/主题-设计.note.md', expect.stringContaining('title: 主题/设计'))
    expect(io.writeTextFile.mock.calls[0][1]).toContain('human:test')
    expect(io.openFile).toHaveBeenCalledWith('/vault/我的百科/主题-设计.note.md')
    expect(io.writeTextFile.mock.calls.some(([path]) => path === source)).toBe(false)
  })

  it('routes a date page to the configured daily-note directory', async () => {
    await openFileViewPage(source, '2026-09-10', () => true)
    expect(io.openFile).toHaveBeenCalledWith('/vault/我的日记/2026/2026-09-10.note.md')
    expect(io.writeTextFile).toHaveBeenCalledWith('/vault/我的日记/2026/2026-09-10.note.md', expect.any(String))
  })

  it('honors blocklist data loaded before navigation', async () => {
    io.ready.mockImplementation(async () => { setBlockedWikilinks(['开发']) })
    await expect(openFileViewPage(source, '开发', () => true)).rejects.toThrow('blocklist')
    expect(io.buildFolderIndex).not.toHaveBeenCalled()
    expect(io.openFile).not.toHaveBeenCalled()
    expect(io.writeTextFile).not.toHaveBeenCalled()
  })

  it.each([null, '/different-vault'])('rejects a missing or different current Vault: %s', async (root) => {
    sotvaultStore.vaultRoot = root
    await expect(openFileViewPage(source, '开发', () => true)).rejects.toThrow('current Vault')
    expect(io.ready).not.toHaveBeenCalled()
    expect(io.writeTextFile).not.toHaveBeenCalled()
  })

  it('cancels before navigation if the Vault changes while building the index', async () => {
    io.buildFolderIndex.mockImplementation(async () => { sotvaultStore.vaultRoot = '/different'; return createIndex() })
    await expect(openFileViewPage(source, '开发', () => true)).rejects.toThrow('current Vault')
    expect(io.openFile).not.toHaveBeenCalled()
    expect(io.writeTextFile).not.toHaveBeenCalled()
  })

  it('rejects an index replaced by another folder before navigation', async () => {
    io.buildFolderIndex.mockResolvedValue(createIndex({ root: '/outside', dirs: [] }))
    await expect(openFileViewPage(source, '开发', () => true)).rejects.toThrow('page index changed')
    expect(io.openFile).not.toHaveBeenCalled()
    expect(io.writeTextFile).not.toHaveBeenCalled()
  })

  it('cancels before navigation if the file view changed while loading blocklist', async () => {
    let current = true
    io.ready.mockImplementation(async () => { current = false })
    await expect(openFileViewPage(source, '开发', () => current)).rejects.toThrow('File view changed')
    expect(io.buildFolderIndex).not.toHaveBeenCalled()
    expect(io.writeTextFile).not.toHaveBeenCalled()
  })

  it('propagates creation failures so the plugin can show them', async () => {
    io.writeTextFile.mockRejectedValue(new Error('Disk full'))
    await expect(openFileViewPage(source, '开发', () => true)).rejects.toThrow('Disk full')
    expect(io.openFile).not.toHaveBeenCalled()
  })
})
