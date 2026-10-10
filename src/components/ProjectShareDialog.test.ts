// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, unmount, tick } from 'svelte'
import ProjectShareDialog from './ProjectShareDialog.svelte'
import { ask, open } from '@tauri-apps/plugin-dialog'
import { pickSaveFile } from '../lib/dialogs'
import { createProject, deleteProject, cancelProjectDeletion, projectCommand, publishProject } from '../lib/project-share/host'
import type { ProjectSummary } from '../lib/project-share/types'
import { openSettings, uiState } from '../lib/ui-state.svelte'

const h = vi.hoisted(() => ({
  tabs: [] as { id: string; filePath: string; kind?: string; title?: string }[],
  dirty: new Set<string>(),
  saved: [] as string[],
  current: 'disk version',
  reviewCalls: 0,
  failOpen: false,
  listed: [] as ProjectSummary[],
  identities: {} as Record<string, typeof info & { url?: string; publishedSnapshotId?: string }>,
  warnings: false,
  realScan: false,
  unsafe: false,
  beforeDelete: null as (() => void) | null,
  saveDelay: null as (() => Promise<void>) | null,
}))
const info = { project_id: 'p', sourceRoot: '/canonical', mirrorRoot: '/vault/Sync/p', entry: 'main.md', files: ['main.md'] }
const feedback = { envelope: { payload: { project_id: 'p', snapshotId: 's', submissionId: 'f', edits: [{ path: 'main.md', baseHash: 'base', afterMarkdown: 'visitor' }], annotations: [], name: 'Alice' }, receivedAt: 'today' }, status: 'pending', decisions: {} }
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), ask: vi.fn() }))
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({ writeText: vi.fn() }))
vi.mock('../lib/ui/modal-focus', () => ({ modalFocus: () => ({ destroy() {} }) }))
vi.mock('../lib/dialogs', () => ({ pickSaveFile: vi.fn() }))
vi.mock('../lib/ui-state.svelte', async () => {
  const actual = await vi.importActual<typeof import('../lib/ui-state.svelte')>('../lib/ui-state.svelte')
  return { ...actual, openSettings: vi.fn(actual.openSettings) }
})
vi.mock('../lib/vault-settings.svelte', () => ({ loadVaultSettings: vi.fn(), vaultSettings: {} }))
vi.mock('../lib/tabs.svelte', () => ({
  tabs: h.tabs,
  activeTab: () => h.tabs[0],
  isDirty: (id: string) => h.dirty.has(id),
  saveTab: async (id: string) => { await h.saveDelay?.(); h.saved.push(id); h.dirty.delete(id); if (id === 'source') h.current = 'latest editor version' },
  saveAs: async (id: string, path: string) => { const tab = h.tabs.find(item => item.id === id); if (tab) tab.filePath = path; h.saved.push(id); h.dirty.delete(id) },
  closeTab: vi.fn(async (id: string) => { if (h.dirty.has(id)) return false; const index = h.tabs.findIndex(tab => tab.id === id); if (index >= 0) h.tabs.splice(index, 1); return true }),
  reloadTabFromDisk: vi.fn(),
}))
vi.mock('../lib/sotvault.svelte', () => ({
  refreshSotvault: vi.fn(),
  sotvaultStore: { records: [{ project_id: 'p', source_path: '/canonical/main.md', vault_path: '/vault/Sync/p/main.md' }] },
}))
vi.mock('../lib/project-share/references', async () => {
  const actual = await vi.importActual<typeof import('../lib/project-share/references')>('../lib/project-share/references')
  return {
    scanProject: async (...args: Parameters<typeof actual.scanProject>) => h.realScan ? actual.scanProject(...args) : ({ files: [{ path: 'main.md', markdown: '# main', hash: 'h', bytes: 6 }], issues: h.warnings || h.unsafe ? [{ kind: 'missing', from: 'main.md', target: 'report-img/a.png', message: '资源不存在，将不包含', severity: h.unsafe ? 'error' : 'warning' }] : [] }),
    isBlockingReferenceIssue: actual.isBlockingReferenceIssue,
  }
})
vi.mock('../lib/project-share/host', () => ({
  projectIdentities: async () => h.identities,
  listProjects: async () => h.listed,
  createProject: vi.fn(async (path: string) => { const created = { ...info, project_id: 'new', sourceRoot: path.slice(0, path.lastIndexOf('/')), entry: path.slice(path.lastIndexOf('/') + 1) }; h.listed = [...h.listed, created]; return created }),
  deleteProject: vi.fn(async (id: string, beforeDelete?: () => Promise<void>) => { h.beforeDelete?.(); await beforeDelete?.(); h.listed = h.listed.filter(item => item.project_id !== id) }),
  cancelProjectDeletion: vi.fn(async (id: string) => { h.listed = h.listed.map(project => project.project_id === id ? { ...project, deleting: false } : project) }),
  projectCommand: vi.fn(async (op: string, args: { project_id?: string }) => {
    if (op === 'open') throw new Error('open must not change the entry')
    if (op === 'get') return { ...(h.listed.find(item => item.project_id === args.project_id) ?? info), sourceAvailable: !h.failOpen }
    if (op === 'snapshot-get') return { schemaVersion: 1, project_id: 'p', snapshotId: 's', entry: 'main.md', files: [{ path: 'main.md', markdown: 'old entry', hash: 'base', bytes: 9 }] }
    if (op === 'read') {
      if ((args as { path?: string }).path === 'main.md') return { path: 'main.md', markdown: '# Strategy\n' + Array.from({ length: 5 }, (_, index) => `![Report ${index}](report-img/${index}.png)`).join('\n'), hash: 'h', bytes: 200 }
      throw new Error('NOT_FOUND: target image')
    }
    if (op === 'list') return ['main.md', 'private.md']
    if (op === 'inbox') return [feedback]
    if (op === 'review') { h.reviewCalls++; return { path: 'main.md', sourcePath: '/canonical/main.md', base: 'base', current: h.current, after: 'visitor', currentHash: h.current, status: 'pending' } }
    throw new Error(`unexpected op ${op}`)
  }),
  publishProject: vi.fn(), collaborationLink: vi.fn(),
  pullProjectFeedback: async () => [feedback], stopProjectShare: vi.fn(), rememberProjectLocation: vi.fn(),
}))

function button(text: string) {
  const found = [...document.querySelectorAll('button')].find(element => element.textContent?.includes(text))
  if (!found) throw new Error(`Missing button ${text}`)
  return found
}
let component: ReturnType<typeof mount> | null = null
beforeEach(() => {
  localStorage.clear()
  h.tabs.splice(0, h.tabs.length, { id: 'source', filePath: '/canonical/main.md' }, { id: 'mirror', filePath: '/vault/Sync/p/main.md' }, { id: 'personal', filePath: '/canonical/private.md' })
  vi.clearAllMocks()
  h.dirty.clear(); h.saved.length = 0; h.current = 'disk version'; h.reviewCalls = 0; h.failOpen = false
  h.listed = [info]; h.identities = { p: { ...info, publishedSnapshotId: 's', url: 'https://share.example/p' } }
  h.warnings = false; h.realScan = false; h.unsafe = false; h.beforeDelete = null; h.saveDelay = null; uiState.showSettings = false
  vi.mocked(ask).mockResolvedValue(true)
  vi.mocked(pickSaveFile).mockResolvedValue(null)
})
afterEach(async () => {
  if (component) await unmount(component)
  component = null
  document.body.innerHTML = ''
})
async function openDialog() {
  component = mount(ProjectShareDialog, { target: document.body, props: { onClose: vi.fn() } })
  await vi.waitFor(() => expect(button('保存并重新扫描').disabled).toBe(false))
}

describe('ProjectShareDialog editor buffers', () => {
  it('separates sharing from feedback and preserves review text when navigating', async () => {
    await openDialog()
    expect(button('分享内容').getAttribute('aria-current')).toBe('page')
    expect(document.querySelector('footer button.primary')?.textContent).toBe('更新分享')
    expect(document.body.textContent).not.toContain('Alice')
    button('反馈收件箱').click()
    await vi.waitFor(() => expect(button('Alice').disabled).toBe(false))
    expect(button('反馈收件箱').getAttribute('aria-current')).toBe('page')
    expect(document.querySelector('footer button.primary')).toBeNull()
    button('Alice').click()
    await vi.waitFor(() => expect(button('审阅文件').disabled).toBe(false))
    button('审阅文件').click()
    await vi.waitFor(() => expect(document.querySelector('textarea')).not.toBeNull())
    const editor = document.querySelector('textarea')!
    editor.value = 'my merged text'
    editor.dispatchEvent(new Event('input', { bubbles: true }))
    button('分享内容').click()
    await vi.waitFor(() => expect(document.querySelector('textarea')).toBeNull())
    button('反馈收件箱').click()
    await vi.waitFor(() => expect(document.querySelector('textarea')?.value).toBe('my merged text'))
  })

  it('restores feedback management after a published entry disappears without enabling a new publish', async () => {
    h.failOpen = true
    component = mount(ProjectShareDialog, { target: document.body, props: { onClose: vi.fn() } })
    await vi.waitFor(() => expect(button('反馈收件箱').disabled).toBe(false))
    button('反馈收件箱').click()
    await vi.waitFor(() => expect(button('Alice').disabled).toBe(false))
    button('分享内容').click()
    await vi.waitFor(() => expect(button('停止分享').disabled).toBe(false))
    expect(button('更新分享').disabled).toBe(true)
    button('反馈收件箱').click()
    await vi.waitFor(() => expect(button('Alice').disabled).toBe(false))
    button('Alice').click()
    await vi.waitFor(() => expect(button('审阅文件').disabled).toBe(false))
    button('审阅文件').click()
    await vi.waitFor(() => expect(document.body.textContent).toContain('文件审阅：main.md'))
  })
  it('flushes and saves only approved sources and their mirrors, preserving unrelated personal drafts', async () => {
    await openDialog()
    h.dirty.add('mirror'); h.dirty.add('personal')
    const flush = (event: Event) => { if ((event as CustomEvent).detail?.tabId === 'source') h.dirty.add('source') }
    window.addEventListener('notemd:flush-doc', flush)
    try {
      button('保存并重新扫描').click()
      await vi.waitFor(() => expect(h.saved).toEqual(['mirror', 'source']))
      await vi.waitFor(() => expect(button('保存并重新扫描').disabled).toBe(false))
      expect(h.dirty.has('personal')).toBe(true)
    } finally { window.removeEventListener('notemd:flush-doc', flush) }
  })
  it('saves the reviewed source before showing its current text, then reads it again', async () => {
    await openDialog()
    button('反馈收件箱').click()
    await vi.waitFor(() => expect(button('Alice').disabled).toBe(false))
    button('Alice').click()
    await vi.waitFor(() => expect(button('审阅文件').disabled).toBe(false))
    h.dirty.add('source')
    button('审阅文件').click()
    await vi.waitFor(() => expect(document.body.textContent).toContain('文件审阅：main.md'))
    expect(h.saved).toEqual(['source'])
    expect(h.reviewCalls).toBe(2)
    expect(document.body.textContent).toContain('latest editor version')
  })
})

describe('ProjectShareDialog current document and lifecycle', () => {
  async function mountCurrent() {
    component = mount(ProjectShareDialog, { target: document.body, props: { onClose: vi.fn() } })
    await tick()
    await vi.waitFor(() => expect(button('选择其他文档').disabled).toBe(false))
  }
  it('creates a saved current document directly and previews before publishing', async () => {
    h.tabs[0].filePath = '/canonical/other.md'
    h.dirty.add('source'); h.dirty.add('personal')
    await mountCurrent()
    expect(createProject).not.toHaveBeenCalled()
    button('创建项目').click()
    await vi.waitFor(() => expect(createProject).toHaveBeenCalledWith('/canonical/other.md'))
    expect(h.saved).toEqual(['source'])
    expect(h.dirty.has('personal')).toBe(true)
    expect(open).not.toHaveBeenCalled()
    expect(publishProject).not.toHaveBeenCalled()
  })
  it('does not create when saving fails and keeps the captured document error visible', async () => {
    h.tabs[0].filePath = '/canonical/other.md'; h.dirty.add('source')
    h.saveDelay = async () => { throw new Error('disk unavailable') }
    await mountCurrent(); button('创建项目').click()
    await vi.waitFor(() => expect(document.body.textContent).toContain('disk unavailable'))
    expect(createProject).not.toHaveBeenCalled()
    expect(h.dirty.has('source')).toBe(true)
  })
  it('previews five missing report images through the production scanner and enables publish', async () => {
    h.realScan = true
    await openDialog()
    expect(document.body.textContent).toContain('未包含 5 项引用')
    expect(button('更新分享').disabled).toBe(false)
    expect(document.querySelectorAll('.file-row')).toHaveLength(1)
  })
  it('does not create a project when saving an untitled document is cancelled', async () => {
    h.tabs[0].filePath = ''; h.tabs[0].kind = 'markdown'
    await mountCurrent()
    button('分享为项目').click()
    await vi.waitFor(() => expect(pickSaveFile).toHaveBeenCalled())
    expect(createProject).not.toHaveBeenCalled()
    expect(publishProject).not.toHaveBeenCalled()
  })
  it('creates with the final save-as path and keeps the clicked tab when the active tab changes', async () => {
    h.tabs[0].filePath = ''; h.tabs[0].kind = 'markdown'
    vi.mocked(pickSaveFile).mockImplementation(async () => { h.tabs.unshift({ id: 'later', filePath: '/elsewhere/later.md' }); return '/canonical/named.md' })
    await mountCurrent()
    button('分享为项目').click()
    await vi.waitFor(() => expect(createProject).toHaveBeenCalledWith('/canonical/named.md'))
    expect(h.saved).toEqual(['source'])
    expect(publishProject).not.toHaveBeenCalled()
  })
  it('lists unpublished projects by entry and restores them with get without changing entry', async () => {
    h.identities = {}
    h.listed = [info, { ...info, project_id: 'b', entry: 'second.md' }]
    await openDialog()
    const select = document.querySelector<HTMLSelectElement>('#share-recent-project')!
    expect([...select.options].map(option => option.textContent).join(' ')).toContain('second.md')
    select.value = 'b'; select.dispatchEvent(new Event('change', { bubbles: true }))
    await vi.waitFor(() => expect(projectCommand).toHaveBeenCalledWith('get', { project_id: 'b' }))
    await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>('#share-entry')?.value).toBe('second.md'))
    expect(document.querySelector('#share-entry')?.tagName).toBe('INPUT')
    expect(button('删除项目').disabled).toBe(false)
  })
  it('matches legacy nested entry by its full source path and asks to choose duplicate bindings', async () => {
    h.tabs[0].filePath = '/canonical/docs/main.md'
    h.listed = [{ ...info, entry: 'docs/main.md' }]
    await openDialog()
    expect(projectCommand).toHaveBeenCalledWith('get', { project_id: 'p' })
    expect(createProject).not.toHaveBeenCalled()
    await unmount(component!); component = null
    h.listed.push({ ...h.listed[0], project_id: 'duplicate' })
    await mountCurrent()
    expect(document.body.textContent).toContain('多个已有项目')
    expect(document.querySelector('#share-entry')).toBeNull()
    button('创建项目').click()
    await vi.waitFor(() => expect(button('创建项目').disabled).toBe(false))
    expect(createProject).not.toHaveBeenCalled()
  })
  it('opens an existing project from its mirror and never creates a new project from that mirror', async () => {
    h.tabs.unshift(h.tabs.splice(1, 1)[0])
    await openDialog()
    expect(projectCommand).toHaveBeenCalledWith('get', { project_id: 'p' })
    expect(createProject).not.toHaveBeenCalled()
  })
  it('keeps non-Markdown pages on the document picker without creating', async () => {
    h.tabs[0].filePath = '/canonical/data.csv'; h.tabs[0].kind = 'spreadsheet'
    await mountCurrent()
    expect(document.body.textContent).toContain('选择 Markdown 文档')
    expect([...document.querySelectorAll('button')].some(item => item.textContent === '创建项目')).toBe(false)
    expect(createProject).not.toHaveBeenCalled()
  })
  it('keeps a mirror without this device binding read-only', async () => {
    h.tabs.unshift(h.tabs.splice(1, 1)[0]); h.listed = []
    await mountCurrent()
    expect(document.body.textContent).toContain('没有本机项目绑定')
    expect(button('创建项目').disabled).toBe(true)
    expect(createProject).not.toHaveBeenCalled()
  })
  it('allows returning to the current document without creating another matching project', async () => {
    await openDialog()
    button('当前文档').click()
    await vi.waitFor(() => expect(button('创建项目').disabled).toBe(false))
    button('创建项目').click()
    await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>('#share-entry')?.value).toBe('main.md'))
    expect(createProject).not.toHaveBeenCalled()
  })
  it('resumes or cancels a deletion reservation while disabling publish and content changes', async () => {
    h.listed = [{ ...info, deleting: true }]
    await mountCurrent()
    expect(button('重试删除项目').disabled).toBe(false)
    expect(button('更新分享').disabled).toBe(true)
    expect(button('保存并重新扫描').disabled).toBe(true)
    button('取消删除').click()
    await vi.waitFor(() => expect(cancelProjectDeletion).toHaveBeenCalledWith('p'))
    await vi.waitFor(() => expect(button('保存并重新扫描').disabled).toBe(false))
  })
  it('allows publishing missing-reference warnings but blocks unsafe reads', async () => {
    h.warnings = true
    await openDialog()
    expect(button('更新分享').disabled).toBe(false)
    expect(document.body.textContent).toContain('未包含 1 项引用')
    await unmount(component!); component = null
    h.unsafe = true
    await openDialog()
    expect(button('更新分享').disabled).toBe(true)
  })
  it('checks mirror buffers before and after remote deletion and only closes clean mirrors', async () => {
    await openDialog()
    h.dirty.add('personal')
    button('删除项目').click()
    await vi.waitFor(() => expect(deleteProject).toHaveBeenCalledWith('p', expect.any(Function)))
    await vi.waitFor(() => expect(h.tabs.some(tab => tab.id === 'mirror')).toBe(false))
    expect(h.tabs.map(tab => tab.id)).toEqual(['source', 'personal'])
    expect(h.saved).toEqual([])
  })
  it('blocks deletion before the remote call when the mirror buffer is dirty', async () => {
    await openDialog(); h.dirty.add('mirror')
    button('删除项目').click()
    await vi.waitFor(() => expect(document.body.textContent).toContain('未保存的镜像'))
    expect(deleteProject).not.toHaveBeenCalled()
    expect(h.saved).toEqual([])
  })
  it('keeps a mirror changed during remote deletion and reports the blocked cleanup', async () => {
    await openDialog(); h.beforeDelete = () => h.dirty.add('mirror')
    button('删除项目').click()
    await vi.waitFor(() => expect(document.body.textContent).toContain('未保存的镜像'))
    expect(h.tabs.some(tab => tab.id === 'mirror')).toBe(true)
    expect(h.listed).toHaveLength(1)
  })
  it('opens share settings while retaining the preview and approved scope', async () => {
    await openDialog()
    button('分享设置').click()
    expect(openSettings).toHaveBeenCalledWith('share')
    await tick()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    uiState.showSettings = false
    await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>('#share-entry')?.value).toBe('main.md'))
    expect(button('更新分享').disabled).toBe(false)
    expect(createProject).not.toHaveBeenCalled()
  })
})
