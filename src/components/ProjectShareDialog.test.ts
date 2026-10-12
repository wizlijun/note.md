// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, unmount, tick } from 'svelte'
import ProjectShareDialog from './ProjectShareDialog.svelte'
import { ask, open } from '@tauri-apps/plugin-dialog'
import { pickSaveFile } from '../lib/dialogs'
import { createProject, deleteProject, cancelProjectDeletion, projectCommand, publishProject } from '../lib/project-share/host'
import type { ProjectIdentity, ProjectPublishProgress } from '../lib/project-share/host'
import type { ProjectSummary } from '../lib/project-share/types'
import { openSettings, uiState } from '../lib/ui-state.svelte'
import { reloadTabFromDisk } from '../lib/tabs.svelte'

const h = vi.hoisted(() => ({
  tabs: [] as { id: string; filePath: string; kind?: string; title?: string; currentContent?: string; initialContent?: string; externalState?: string; externalBannerDismissed?: boolean }[],
  dirty: new Set<string>(),
  saved: [] as string[],
  current: 'disk version',
  reviewCalls: 0,
  failOpen: false,
  listed: [] as ProjectSummary[],
  identities: {} as Record<string, Partial<ProjectIdentity>>,
  warnings: false,
  realScan: false,
  unsafe: false,
  beforeDelete: null as (() => void) | null,
  saveDelay: null as (() => Promise<void>) | null,
  applyDirty: [] as string[],
  locateDelay: null as (() => Promise<void>) | null,
  cancelAnnotations: vi.fn(),
  reviewSaveDelay: null as (() => Promise<void>) | null,
}))
const info = { project_id: 'p', sourceRoot: '/canonical', mirrorRoot: '/vault/Sync/p', entry: 'main.md', files: ['main.md'] }
const feedback = { envelope: { payload: { project_id: 'p', snapshotId: 's', submissionId: 'f', edits: [{ path: 'main.md', baseHash: 'base', afterMarkdown: 'visitor' }], annotations: [], name: 'Alice' }, receivedAt: 'today' }, status: 'pending', decisions: {} }
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), ask: vi.fn() }))
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({ writeText: vi.fn() }))
vi.mock('../lib/project-share/merge-client', async () => {
  const { propose, anchor } = await import('../lib/share-merge')
  return { createMergeClient: () => ({
    compute: async (input: Parameters<typeof propose>[0]) => propose(input),
    locateAnnotations: async (text: string, selectors: { index: number; selector: Parameters<typeof anchor>[1] }[]) => {
      await h.locateDelay?.()
      return selectors.map(s => ({ index: s.index, result: anchor(text, s.selector) }))
    },
    cancelAnnotations: h.cancelAnnotations, destroy: vi.fn(),
  }) }
})
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
    if (op === 'review-save') { await h.reviewSaveDelay?.(); return { ...feedback, review: { [(args as any).path]: (args as any).draft } } }
    if (op === 'apply') { for (const id of h.applyDirty) h.dirty.add(id); return { ...feedback, status: 'accepted', decisions: { 'main.md': { status: 'accepted' } } } }
    if (op === 'reject') return { ...feedback, status: 'rejected', decisions: { 'main.md': { status: 'rejected' } } }
    if (op === 'review') { h.reviewCalls++; return { path: 'main.md', sourcePath: '/canonical/main.md', base: 'base', current: h.current, after: 'visitor', currentHash: h.current, status: 'pending' } }
    throw new Error(`unexpected op ${op}`)
  }),
  publishProject: vi.fn(), collaborationLink: vi.fn(),
  pullProjectFeedback: async () => [feedback], stopProjectShare: vi.fn(), rememberProjectLocation: vi.fn(),
}))

function button(text: string) {
  const candidates = [...document.querySelectorAll('button')].filter(element => !element.closest('[hidden]'))
  const found = candidates.find(element => element.textContent?.trim() === text) ?? candidates.find(element => element.textContent?.includes(text))
  if (!found) throw new Error(`Missing button ${text}`)
  return found
}
let component: ReturnType<typeof mount> | null = null
beforeEach(() => {
  localStorage.clear()
  h.locateDelay = null; feedback.envelope.payload.annotations = []
  h.tabs.splice(0, h.tabs.length, { id: 'source', filePath: '/canonical/main.md', currentContent: 'source buffer', initialContent: 'source buffer' }, { id: 'mirror', filePath: '/vault/Sync/p/main.md', currentContent: 'mirror buffer', initialContent: 'mirror buffer' }, { id: 'personal', filePath: '/canonical/private.md' })
  vi.clearAllMocks()
  h.dirty.clear(); h.saved.length = 0; h.current = 'disk version'; h.reviewCalls = 0; h.failOpen = false
  h.listed = [info]; h.identities = { p: { ...info, publishedSnapshotId: 's', url: 'https://share.example/p' } }
  h.warnings = false; h.realScan = false; h.unsafe = false; h.beforeDelete = null; h.saveDelay = null; h.applyDirty = []; h.reviewSaveDelay = null; uiState.showSettings = false
  vi.mocked(ask).mockResolvedValue(true)
  vi.mocked(pickSaveFile).mockResolvedValue(null)
})
afterEach(async () => {
  if (component) await unmount(component)
  component = null
  document.body.innerHTML = ''
})
async function openDialog(onClose = vi.fn()) {
  component = mount(ProjectShareDialog, { target: document.body, props: { onClose } })
  await vi.waitFor(() => expect(button('保存并重新扫描').disabled).toBe(false))
  return onClose
}

describe('ProjectShareDialog ZIP progress', () => {
  it('shows live ZIP phases and byte progress only for the publishing project, then clears on success', async () => {
    h.listed.push({ ...info, project_id: 'b', entry: 'other.md' })
    let report: (progress: ProjectPublishProgress) => void = () => {}
    let finish = () => {}
    vi.mocked(publishProject).mockImplementationOnce(async (_info, _files, _title, options) => {
      report = options!.onProgress!
      await new Promise<void>(resolve => { finish = resolve })
      return { info, identity: h.identities.p as ProjectIdentity }
    })
    await openDialog()
    button('更新分享').click()
    await vi.waitFor(() => expect(document.querySelector('.project-heading')?.textContent).toContain('正在准备分享…'))
    const select = document.querySelector<HTMLSelectElement>('#share-recent-project')!
    expect(select.disabled).toBe(true)
    expect(select.querySelector('option[value="b"]')?.textContent).not.toContain('ZIP')
    report({ phase: 'uploading', loaded: 1024, total: 4096 })
    await tick()
    const progress = document.querySelector<HTMLProgressElement>('.project-heading progress')!
    expect(progress.value).toBe(25)
    expect(progress.getAttribute('aria-label')).toBe('main.md 上传进度')
    expect(document.querySelector('.project-heading')?.textContent).toContain('25% · 1.0 KB / 4.0 KB')
    expect(select.querySelector('option[value="p"]')?.textContent).toContain('25%')
    report({ phase: 'uploading', artifact: 'archive', partNumber: 1, partCount: 2, loaded: 4096, total: 4096 })
    await tick()
    expect(progress.value).toBe(100)
    expect(document.querySelector('.project-heading')?.textContent).toContain('项目文件 ZIP')
    expect(document.querySelector('.project-heading')?.textContent).toContain('第 1 / 2 片')
    report({ phase: 'uploading', artifact: 'reader', partNumber: 2, partCount: 2, loaded: 3072, total: 4096 })
    await tick()
    expect(progress.value).toBe(75)
    expect(document.querySelector('.project-heading')?.textContent).toContain('阅读页')
    expect(document.querySelector('.project-heading')?.textContent).toContain('第 2 / 2 片')
    report({ phase: 'processing' })
    await tick()
    expect(document.querySelector('.project-heading')?.textContent).toContain('正在完成发布…')
    expect(document.querySelector('.project-heading progress')?.hasAttribute('value')).toBe(false)
    finish()
    await vi.waitFor(() => expect(document.querySelector('.project-heading progress')).toBeNull())
    expect(document.body.textContent).toContain('项目已发布。')
    expect(select.disabled).toBe(false)
    expect(select.querySelector('option[value="p"]')?.textContent).not.toContain('ZIP')
  })

  it('clears failed ZIP progress while preserving the error and allows a fresh retry', async () => {
    let fail: (error: Error) => void = () => {}
    vi.mocked(publishProject).mockImplementationOnce(async (_info, _files, _title, options) => {
      options?.onProgress?.({ phase: 'uploading', loaded: 2048, total: 4096 })
      await new Promise<void>((_resolve, reject) => { fail = reject })
      throw new Error('unreachable')
    })
    await openDialog()
    button('更新分享').click()
    await vi.waitFor(() => expect(document.querySelector('.project-heading')?.textContent).toContain('50%'))
    fail(new Error('ZIP upload offline'))
    await vi.waitFor(() => expect(document.querySelector('[role=alert]')?.textContent).toContain('ZIP upload offline'))
    expect(document.querySelector('.project-heading progress')).toBeNull()
    expect(document.querySelector('option[value="p"]')?.textContent).not.toContain('50%')
    expect(button('更新分享').disabled).toBe(false)
    vi.mocked(publishProject).mockResolvedValueOnce({ info, identity: h.identities.p as ProjectIdentity })
    button('更新分享').click()
    await vi.waitFor(() => expect(document.body.textContent).toContain('项目已发布。'))
    expect(document.querySelector('[role=alert]')).toBeNull()
    expect(document.querySelector('.project-heading progress')).toBeNull()
  })
})

describe('ProjectShareDialog titles', () => {
  const title = () => document.querySelector<HTMLInputElement>('#share-title')!
  const theme = () => document.querySelector<HTMLInputElement>('#share-current-theme')!
  it('shows a copyable entry link while full publication is pending and preserves it after failure', async () => {
    h.identities.p = { ...info }
    let failFull: (error: Error) => void = () => {}
    vi.mocked(publishProject).mockImplementationOnce(async (_info, _files, _title, options) => {
      const identity = { ...info, baseUrl: 'https://share.example', slug: 'p', edit_token: 'edit', feedbackToken: 'feedback',
        url: 'https://share.example/p', publishedSnapshotId: 's1', pending: { phase: 'preparing' as const,
          snapshotId: 's1', entry: 'main.md', expiresInSeconds: null, publicationId: 'publication', previousPublicationId: null,
          approved: [{ path: 'main.md', hash: 'h' }], frozenTheme: { themeId: 'default', compiledCss: '' } } }
      h.identities.p = identity
      await options?.onEntryPublished?.({ info: { ...info, url: identity.url, publishedSnapshotId: 's1' }, identity })
      await new Promise<void>((_resolve, reject) => { failFull = reject })
      throw new Error('unreachable')
    })
    await openDialog()
    button('发布分享').click()
    await vi.waitFor(() => expect(document.body.textContent).toContain('入口已发布，正在同步项目'))
    expect(document.querySelector<HTMLInputElement>('#share-read-link')?.value).toBe('https://share.example/p')
    expect(button('复制阅读链接').disabled).toBe(false)
    button('复制阅读链接').click()
    await tick()
    expect(button('重试原包发布').disabled).toBe(true)
    failFull(new Error('archive offline'))
    await vi.waitFor(() => expect(document.querySelector('[role=alert]')?.textContent).toContain('完整项目尚未同步完成'))
    expect(button('复制阅读链接').disabled).toBe(false)
    expect(button('重试原包发布').disabled).toBe(false)
  })
  it('defaults the theme checkbox on and passes an unchecked choice when publishing', async () => {
    await openDialog()
    expect(theme()?.checked).toBe(true)
    theme().click()
    button('保存并重新扫描').click()
    await tick()
    await vi.waitFor(() => expect(button('保存并重新扫描').disabled).toBe(false))
    expect(theme().checked).toBe(false)
    vi.mocked(publishProject).mockResolvedValueOnce({ info, identity: { ...h.identities.p, useCurrentTheme: false } as ProjectIdentity })
    button('更新分享').click()
    await vi.waitFor(() => expect(publishProject).toHaveBeenCalledWith(expect.objectContaining(info), expect.any(Array), 'main', expect.objectContaining({ useCurrentTheme: false, onEntryPublished: expect.any(Function) })))
    await vi.waitFor(() => expect(theme().disabled).toBe(false))
    expect(theme().checked).toBe(false)
  })
  it('restores independent project theme choices', async () => {
    h.identities.p.useCurrentTheme = false
    h.listed.push({ ...info, project_id: 'b', entry: 'other.md' })
    await openDialog()
    expect(theme()?.checked).toBe(false)
    const select = document.querySelector<HTMLSelectElement>('#share-recent-project')!
    select.value = 'b'; select.dispatchEvent(new Event('change', { bubbles: true }))
    await vi.waitFor(() => expect(theme().checked).toBe(true))
    await vi.waitFor(() => expect(select.disabled).toBe(false))
    select.value = 'p'; select.dispatchEvent(new Event('change', { bubbles: true }))
    await vi.waitFor(() => expect(theme().checked).toBe(false))
  })
  it('locks the frozen pending theme choice instead of the previously published preference', async () => {
    h.identities.p.useCurrentTheme = false
    h.identities.p.pending = { snapshotId: 'frozen', entry: 'main.md', expiresInSeconds: null, useCurrentTheme: true }
    await openDialog()
    await vi.waitFor(() => expect(theme().disabled).toBe(true))
    expect(theme().checked).toBe(true)
  })
  it('defaults to the entry name, preserves editing across scans and sends the title when publishing', async () => {
    await openDialog()
    expect(title().value).toBe('main')
    title().value = 'My reader'; title().dispatchEvent(new Event('input', { bubbles: true }))
    button('保存并重新扫描').click()
    await tick()
    await vi.waitFor(() => expect(button('保存并重新扫描').disabled).toBe(false))
    expect(title().value).toBe('My reader')
    vi.mocked(publishProject).mockResolvedValueOnce({ info, identity: { ...h.identities.p, shareTitle: 'My reader' } as ProjectIdentity, warnings: ['字体将使用替代', '某图表有错误'] })
    expect(button('更新分享').disabled).toBe(false)
    button('更新分享').click()
    await tick()
    await vi.waitFor(() => expect(document.querySelector('[role=alert]')?.textContent).toBeUndefined())
    await vi.waitFor(() => expect(publishProject).toHaveBeenCalledWith(expect.objectContaining(info), expect.any(Array), 'My reader', expect.objectContaining({ useCurrentTheme: true, onEntryPublished: expect.any(Function) })))
    await vi.waitFor(() => expect(document.body.textContent).toContain('字体将使用替代'))
    expect(document.body.textContent).toContain('某图表有错误')
  })
  it('initializes independent remembered titles when changing projects', async () => {
    h.identities.p.shareTitle = 'Remembered'
    h.listed.push({ ...info, project_id: 'b', entry: 'docs/Second.MDX' })
    await openDialog()
    expect(title().value).toBe('Remembered')
    title().value = 'unsaved'; title().dispatchEvent(new Event('input', { bubbles: true }))
    const select = document.querySelector<HTMLSelectElement>('#share-recent-project')!
    select.value = 'b'; select.dispatchEvent(new Event('change', { bubbles: true }))
    await vi.waitFor(() => expect(title().value).toBe('Second'))
    select.value = 'p'; select.dispatchEvent(new Event('change', { bubbles: true }))
    await vi.waitFor(() => expect(title().value).toBe('Remembered'))
  })
  it('shows the frozen pending title read-only and updates it after an unknown upload result', async () => {
    h.identities.p.shareTitle = 'previous'
    await openDialog()
    title().value = 'new'; title().dispatchEvent(new Event('input', { bubbles: true }))
    theme().click()
    vi.mocked(publishProject).mockImplementationOnce(async () => {
      h.identities.p.pending = { snapshotId: 'frozen', entry: 'main.md', expiresInSeconds: null, shareTitle: 'new', useCurrentTheme: false }
      throw new Error('unknown upload')
    })
    expect(button('更新分享').disabled).toBe(false)
    button('更新分享').click()
    await vi.waitFor(() => expect(title().readOnly).toBe(true))
    expect(title().value).toBe('new')
    expect(theme().checked).toBe(false)
    expect(theme().disabled).toBe(true)
    expect(button('重试原包发布').disabled).toBe(false)
    await unmount(component!); component = null
    await openDialog()
    expect(title().value).toBe('new')
    expect(title().readOnly).toBe(true)
  })
})

describe('ProjectShareDialog editor buffers', () => {
  async function readyReview() {
    const closed = await openDialog(); button('反馈收件箱').click()
    await vi.waitFor(() => expect(button('Alice').disabled).toBe(false)); button('Alice').click()
    await vi.waitFor(() => expect(button('接受全部无冲突改动').disabled).toBe(false))
    return closed
  }
  it.each(['source', 'mirror'])('preserves a %s buffer dirtied after apply and only reloads other clean buffers with expected content', async dirtyId => {
    await readyReview(); h.applyDirty = [dirtyId]
    button('接受').click(); await tick()
    await vi.waitFor(() => expect(button('写回本文件').disabled).toBe(false)); button('写回本文件').click()
    await vi.waitFor(() => expect(document.querySelector('[aria-labelledby="review-confirm-title"]')).not.toBeNull())
    button('确认写回').click()
    await vi.waitFor(() => expect(reloadTabFromDisk).toHaveBeenCalledTimes(1))
    const dirty = h.tabs.find(tab => tab.id === dirtyId)!, clean = h.tabs.find(tab => tab.id === (dirtyId === 'source' ? 'mirror' : 'source'))!
    expect(reloadTabFromDisk).toHaveBeenCalledWith(clean.filePath, { expectedContent: clean.currentContent })
    expect(dirty.externalState).toBe('changed'); expect(dirty.externalBannerDismissed).toBe(false)
    expect(h.dirty.has(dirtyId)).toBe(true)
    expect(document.body.textContent).toContain('保留了未保存的原件或镜像修改')
  })
  it('waits for review-save before closing', async () => {
    const closed = await readyReview(); button('接受').click()
    let release!: () => void
    h.reviewSaveDelay = () => new Promise(resolve => { release = resolve })
    button('完成').click()
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    expect(closed).not.toHaveBeenCalled()
    h.reviewSaveDelay = null; release()
    await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce())
    expect(projectCommand).toHaveBeenCalledWith('review-save', expect.objectContaining({ project_id: 'p', submissionId: 'f' }))
  })
  it('keeps the dialog open after a save error, then closes only after a successful retry', async () => {
    const closed = await readyReview(); button('接受').click()
    h.reviewSaveDelay = async () => { throw new Error('disk full') }
    button('完成').click()
    await vi.waitFor(() => expect(document.body.textContent).toContain('disk full'))
    expect(closed).not.toHaveBeenCalled(); expect(button('完成').disabled).toBe(false)
    h.reviewSaveDelay = null; button('完成').click()
    await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce())
  })
  it('separates sharing from feedback and preserves review text when navigating', async () => {
    await openDialog()
    expect(button('分享内容').getAttribute('aria-current')).toBe('page')
    expect(document.querySelector('footer button.primary')?.textContent).toBe('更新分享')
    expect(document.querySelector('section[hidden]')?.textContent).toContain('Alice')
    button('反馈收件箱').click()
    await vi.waitFor(() => expect(button('Alice').disabled).toBe(false))
    expect(button('反馈收件箱').getAttribute('aria-current')).toBe('page')
    expect(document.querySelector('footer button.primary')).toBeNull()
    button('Alice').click()
    await vi.waitFor(() => expect(button('审阅文件').disabled).toBe(false))
    await vi.waitFor(() => expect(button('编辑').disabled).toBe(false))
    button('编辑').click()
    await vi.waitFor(() => expect(document.querySelector('textarea')).not.toBeNull())
    const editor = document.querySelector('textarea')!
    editor.value = 'my merged text'
    editor.dispatchEvent(new Event('input', { bubbles: true }))
    button('采用手改').click()
    button('分享内容').click()
    await vi.waitFor(() => expect(button('分享内容').getAttribute('aria-current')).toBe('page'))
    expect(document.querySelector('section[hidden] textarea')).not.toBeNull()
    button('反馈收件箱').click()
    await vi.waitFor(() => expect(document.querySelector('textarea')?.value).toBe('my merged text'))
  })

  it('restores feedback management after a published entry disappears without enabling a new publish', async () => {
    h.failOpen = true
    component = mount(ProjectShareDialog, { target: document.body, props: { onClose: vi.fn() } })
    await vi.waitFor(() => expect(button('反馈收件箱').disabled).toBe(false))
    button('反馈收件箱').click()
    await vi.waitFor(() => expect(button('Alice').disabled).toBe(false))
    await vi.waitFor(() => expect(button('分享内容').disabled).toBe(false))
    button('分享内容').click()
    await vi.waitFor(() => expect(button('停止分享').disabled).toBe(false))
    expect(button('更新分享').disabled).toBe(true)
    button('反馈收件箱').click()
    await vi.waitFor(() => expect(button('Alice').disabled).toBe(false))
    button('Alice').click()
    await vi.waitFor(() => expect(button('审阅文件').disabled).toBe(false))
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
    h.dirty.add('source')
    button('Alice').click()
    await vi.waitFor(() => expect(button('审阅文件').disabled).toBe(false))
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
    await vi.waitFor(() => expect(openSettings).toHaveBeenCalledWith('share'))
    await tick()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    uiState.showSettings = false
    await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>('#share-entry')?.value).toBe('main.md'))
    expect(button('更新分享').disabled).toBe(false)
    expect(createProject).not.toHaveBeenCalled()
  })
})


describe('ProjectShareDialog cancellable review loading', () => {
  it('closes during annotation loading and isolates late results from a reopened dialog', async () => {
    ;(feedback.envelope.payload.annotations as any[]) = [{ path: 'main.md', quote: 'disk', comment: 'old annotation' }]
    let release!: () => void
    h.locateDelay = () => new Promise<void>(resolve => { release = resolve })
    const closed = await openDialog(); button('反馈收件箱').click()
    await vi.waitFor(() => expect(button('Alice').disabled).toBe(false)); button('Alice').click()
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    expect(button('完成').disabled).toBe(false)
    expect(document.querySelector<HTMLSelectElement>('#share-recent-project')!.disabled).toBe(false)
    button('完成').click()
    await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce())
    expect(h.cancelAnnotations).toHaveBeenCalledTimes(2)
    await unmount(component!); component = null
    h.locateDelay = null
    ;(feedback.envelope.payload.annotations as any[]) = [{ path: 'main.md', quote: 'version', comment: 'new annotation' }]
    await openDialog(); button('反馈收件箱').click()
    await vi.waitFor(() => expect(button('Alice').disabled).toBe(false)); button('Alice').click()
    await vi.waitFor(() => expect(document.body.textContent).toContain('new annotation'))
    release(); await tick(); await new Promise(resolve => setTimeout(resolve, 0)); await tick()
    expect(document.body.textContent).not.toContain('old annotation')
    expect(button('完成').disabled).toBe(false)
    button('接受').click(); await tick(); button('写回本文件').click()
    await vi.waitFor(() => expect(document.querySelector('[aria-labelledby="review-confirm-title"]')).not.toBeNull())
    expect(button('完成').disabled).toBe(true)
    expect(document.querySelector<HTMLSelectElement>('#share-recent-project')!.disabled).toBe(true)
    button('取消').click()
    await vi.waitFor(() => expect(button('完成').disabled).toBe(false))
  })
})
