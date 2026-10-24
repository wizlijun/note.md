// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import FolderView from './FolderView.svelte'
import { i18n } from '../lib/i18n/store.svelte'

const mocked = vi.hoisted(() => {
  const entries = [
    { name: 'first.md', path: '/vault/first.md', kind: 'markdown', isDir: false, hasNote: true, notePath: '/vault/first.note.md' },
    { name: 'second.png', path: '/vault/second.png', kind: 'image', isDir: false },
    { name: 'folder', path: '/vault/folder', kind: null, isDir: true },
  ]
  return {
    entries,
    ask: vi.fn(async () => false),
    remove: vi.fn(async (_path: string) => {}),
    refresh: vi.fn(async () => {}),
    showError: vi.fn(),
  }
})
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: mocked.ask }))
vi.mock('../lib/tabs.svelte', () => ({ openFile: vi.fn(), updateTabPath: vi.fn(), deleteFileFromFolder: mocked.remove }))
vi.mock('../lib/dialogs', () => ({ showError: mocked.showError }))
vi.mock('../lib/outline/rename-pair', () => ({ planRename: vi.fn(), executeRename: vi.fn() }))
vi.mock('../lib/side-panel/registry.svelte', () => ({
  setSideVisible: vi.fn(), sideShownViews: () => [], sideActiveView: () => null, setActiveView: vi.fn(),
}))
vi.mock('../lib/folder-view.svelte', () => ({
  folderView: {
    rootDir: '/vault', filter: '', viewMode: 'all', hideFolders: false, sort: 'edited',
    entriesCache: new Map([['/vault', mocked.entries]]), expanded: new Set(), titleCache: new Map(),
  },
  parentDir: () => '/', refreshAll: mocked.refresh,
  setRootDir: vi.fn(), syncToActiveFile: vi.fn(), suppressFollowFor: vi.fn(), watchRoot: vi.fn(),
  setFilter: vi.fn(), clearFilter: vi.fn(), revealInFinder: vi.fn(), setSort: vi.fn(),
  setViewMode: vi.fn(), setHideFolders: vi.fn(), togglePin: vi.fn(), toggleExpanded: vi.fn(), ensureTitle: vi.fn(),
  filterByViewMode: (entries: unknown[]) => entries, applyHideFolders: (entries: unknown[]) => entries,
  displayNameFor: (entry: { name: string }) => entry.name,
}))

let component: ReturnType<typeof mount>
async function openMenu(name = 'first.md') {
  document.querySelector<HTMLButtonElement>(`button.node[title="${name}"]`)!.dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 80 }),
  )
  await tick()
}
function deleteButton() {
  return [...document.querySelectorAll<HTMLButtonElement>('.node-ctx-menu button')]
    .find(button => button.textContent?.trim() === '删除…')!
}
async function settle() {
  await vi.waitFor(() => expect(mocked.refresh).toHaveBeenCalledOnce())
  await tick()
}

beforeEach(() => {
  vi.resetAllMocks()
  mocked.ask.mockResolvedValue(false)
  mocked.remove.mockResolvedValue(undefined)
  mocked.refresh.mockResolvedValue(undefined)
  i18n.locale = 'zh'
  component = mount(FolderView, { target: document.body, props: { tab: null } })
})
afterEach(async () => {
  await unmount(component)
  document.body.innerHTML = ''
  i18n.locale = 'en'
})

describe('FolderView delete context menu', () => {
  it('uses the global menu styles and cancels without deleting or refreshing', async () => {
    await openMenu()
    expect(deleteButton().matches('.menu-panel .menu-row')).toBe(true)
    deleteButton().click()
    await tick()
    expect(document.querySelector('.node-ctx-menu')).toBeNull()
    expect(mocked.ask).toHaveBeenCalledWith(
      '此操作将永久删除该文件，无法撤销。伴生笔记将保留。\n\n/vault/first.md',
      { title: '删除“first.md”？', kind: 'warning', okLabel: '删除', cancelLabel: '取消' },
    )
    expect(mocked.remove).not.toHaveBeenCalled()
    expect(mocked.refresh).not.toHaveBeenCalled()
  })

  it('only deletes the confirmed file, keeps its companion, and refreshes the tree', async () => {
    mocked.ask.mockResolvedValue(true)
    await openMenu()
    deleteButton().click()
    await settle()
    expect(mocked.remove.mock.calls).toEqual([['/vault/first.md']])
  })

  it('does not offer recursive folder deletion', async () => {
    await openMenu('folder')
    expect(deleteButton()).toBeUndefined()
  })

  it('supports non-Markdown files', async () => {
    mocked.ask.mockResolvedValue(true)
    await openMenu('second.png')
    deleteButton().click()
    await settle()
    expect(mocked.remove).toHaveBeenCalledWith('/vault/second.png')
  })

  it('keeps the confirmation target stable and prevents overlapping deletion prompts', async () => {
    let confirm!: (value: boolean) => void
    mocked.ask.mockImplementationOnce(() => new Promise(resolve => { confirm = resolve }))
    await openMenu()
    deleteButton().click()
    await tick()
    expect(mocked.remove).not.toHaveBeenCalled()
    await openMenu('second.png')
    expect(deleteButton().disabled).toBe(true)
    deleteButton().click()
    expect(mocked.ask).toHaveBeenCalledOnce()
    confirm(true)
    await settle()
    expect(mocked.remove.mock.calls).toEqual([['/vault/first.md']])
  })

  it('reports a deletion failure and allows retry without pretending the tree changed', async () => {
    mocked.ask.mockResolvedValue(true)
    mocked.remove.mockRejectedValueOnce(new Error('permission denied'))
    await openMenu()
    deleteButton().click()
    await vi.waitFor(() => expect(mocked.showError).toHaveBeenCalledWith('Error: permission denied'))
    expect(mocked.refresh).not.toHaveBeenCalled()
    await openMenu()
    expect(deleteButton().disabled).toBe(false)
    deleteButton().click()
    await settle()
    expect(mocked.remove).toHaveBeenCalledTimes(2)
  })

  it('does not delete if the native confirmation cannot be shown', async () => {
    mocked.ask.mockRejectedValueOnce(new Error('dialog unavailable'))
    await openMenu()
    deleteButton().click()
    await vi.waitFor(() => expect(mocked.showError).toHaveBeenCalledWith('Error: dialog unavailable'))
    expect(mocked.remove).not.toHaveBeenCalled()
  })
})
