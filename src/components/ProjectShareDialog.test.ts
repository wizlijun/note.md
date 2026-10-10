// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, unmount } from 'svelte'
import ProjectShareDialog from './ProjectShareDialog.svelte'

const h = vi.hoisted(() => ({
  tabs: [] as { id: string; filePath: string }[],
  dirty: new Set<string>(),
  saved: [] as string[],
  current: 'disk version',
  reviewCalls: 0,
  failOpen: false,
}))
const info = { project_id: 'p', sourceRoot: '/project', mirrorRoot: '/vault/Sync/p', entry: 'main.md', files: ['main.md'] }
const feedback = { envelope: { payload: { project_id: 'p', snapshotId: 's', submissionId: 'f', edits: [{ path: 'main.md', baseHash: 'base', afterMarkdown: 'visitor' }], annotations: [], name: 'Alice' }, receivedAt: 'today' }, status: 'pending', decisions: {} }
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), ask: vi.fn() }))
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({ writeText: vi.fn() }))
vi.mock('../lib/ui/modal-focus', () => ({ modalFocus: () => ({ destroy() {} }) }))
vi.mock('../lib/vault-settings.svelte', () => ({ loadVaultSettings: vi.fn(), vaultSettings: {} }))
vi.mock('../lib/tabs.svelte', () => ({
  tabs: h.tabs,
  activeTab: () => h.tabs[0],
  isDirty: (id: string) => h.dirty.has(id),
  saveTab: async (id: string) => { h.saved.push(id); h.dirty.delete(id); if (id === 'source') h.current = 'latest editor version' },
  reloadTabFromDisk: vi.fn(),
}))
vi.mock('../lib/sotvault.svelte', () => ({
  refreshSotvault: vi.fn(),
  sotvaultStore: { records: [{ project_id: 'p', source_path: '/canonical/main.md', vault_path: '/vault/Sync/p/main.md' }] },
}))
vi.mock('../lib/project-share/references', () => ({
  scanProject: async () => ({ files: [{ path: 'main.md', markdown: '# main', hash: 'h', bytes: 6 }], issues: [] }),
}))
vi.mock('../lib/project-share/host', () => ({
  projectIdentities: async () => ({ p: { ...info, publishedSnapshotId: 's', url: 'https://share.example/p' } }),
  projectCommand: async (op: string) => {
    if (op === 'open') { if (h.failOpen) throw new Error('missing entry'); return info }
    if (op === 'snapshot-get') return { schemaVersion: 1, project_id: 'p', snapshotId: 's', entry: 'main.md', files: [{ path: 'main.md', markdown: 'old entry', hash: 'base', bytes: 9 }] }
    if (op === 'list') return ['main.md', 'private.md']
    if (op === 'inbox') return [feedback]
    if (op === 'review') { h.reviewCalls++; return { path: 'main.md', sourcePath: '/canonical/main.md', base: 'base', current: h.current, after: 'visitor', currentHash: h.current, status: 'pending' } }
    throw new Error(`unexpected op ${op}`)
  },
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
  h.tabs.splice(0, h.tabs.length, { id: 'source', filePath: '/canonical/main.md' }, { id: 'mirror', filePath: '/vault/Sync/p/main.md' }, { id: 'personal', filePath: '/project/private.md' })
  h.dirty.clear(); h.saved.length = 0; h.current = 'disk version'; h.reviewCalls = 0; h.failOpen = false
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
