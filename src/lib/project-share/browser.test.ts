// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Marked } from 'marked'
import { buildProjectBundle } from './bundle'
import { projectShareBrowser } from './browser'
import type { ProjectSnapshot } from './types'

const snapshot: ProjectSnapshot = { schemaVersion: 1, project_id: 'project_1', snapshotId: 'snapshot_1', entry: 'README.md', files: [
  { path: 'README.md', hash: 'a'.repeat(64), bytes: 20, markdown: '# 方案\n\n[调研](docs/research.md#调查)\n\n[[ Research |说明 ]]\n\n原始内容\n\n<script>window.pwned=true</script>' },
  { path: 'docs/research.md', hash: 'b'.repeat(64), bytes: 10, markdown: '# 调查\n\n[返回](../README.md)' },
  { path: 'Research.md', hash: 'c'.repeat(64), bytes: 5, markdown: '# Research' },
] }
let values: Map<string, any>
function fakeDatabase(delay = 0, fail = false) {
  vi.stubGlobal('indexedDB', { open: () => {
    const op: any = { result: { transaction: () => {
      const tx: any = { objectStore: () => ({
        get: (key: string) => { const result = { result: structuredClone(values.get(key)) }; setTimeout(() => tx.oncomplete?.(), 0); return result },
        put: (value: any, key: string) => { values.set(key, structuredClone(value)); setTimeout(() => tx.oncomplete?.(), 0); return {} },
      }) }
      return tx
    } } }
    setTimeout(() => { if(fail) { op.error = new Error('storage unavailable'); op.onerror?.() } else op.onsuccess?.() }, delay)
    return op
  } })
}
const $ = (id: string) => document.getElementById(id)!
const status = () => $('status').textContent!
const input = (value: string) => { ($('editor') as HTMLTextAreaElement).value = value; $('editor').dispatchEvent(new Event('input')) }
const click = (id: string) => $(''+id).click()

beforeEach(() => {
  values = new Map()
  vi.unstubAllGlobals()
  history.replaceState(null, '', '/#feedback=visitor-token')
  const html = buildProjectBundle(snapshot, 'https://share.test/feedback/project_1')
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>'))
  fakeDatabase()
})

describe('browser project collaboration', () => {
  it('waits for stored drafts before enabling edits and retains token across early navigation', async () => {
    values.set('project_1:snapshot_1', { drafts: { 'README.md': 'saved draft' }, annotations: [], pending: null })
    fakeDatabase(25)
    const loading = projectShareBrowser(new Marked())
    expect(($('edit') as HTMLButtonElement).disabled).toBe(true)
    ;($('files').children[1] as HTMLButtonElement).click()
    await loading
    expect(values.get('project_1:token')).toBe('visitor-token')
    expect(($('edit') as HTMLButtonElement).disabled).toBe(false)
    ;($('files').children[0] as HTMLButtonElement).click()
    await vi.waitFor(() => expect(($('editor') as HTMLTextAreaElement).value).toBe('saved draft'))
    expect((window as any).pwned).toBeUndefined()
  })
  it('allows an oversized candidate to be reduced and freezes only a sendable packet', async () => {
    const send = vi.fn(async (_url: string, _init: RequestInit) => Response.json({}))
    vi.stubGlobal('fetch', send)
    await projectShareBrowser(new Marked())
    click('edit'); input('x'.repeat(5 * 1024 * 1024)); click('submit')
    expect(status()).toContain('超过 5 MiB')
    expect(send).not.toHaveBeenCalled()
    input('中文修改🧪'); click('submit')
    await vi.waitFor(() => expect(status()).toContain('已送达'))
    expect(JSON.parse(send.mock.calls[0][1].body as string).edits[0].afterMarkdown).toBe('中文修改🧪')
  })
  it('retries identical bytes after an unknown result, then creates a new submission for newer edits', async () => {
    const bodies: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      bodies.push(init.body)
      if(bodies.length === 1) throw new Error('offline')
      return Response.json({})
    }))
    await projectShareBrowser(new Marked())
    click('edit'); input('first change'); click('submit')
    await vi.waitFor(() => expect(status()).toContain('结果未知'))
    input('second change'); click('submit')
    await vi.waitFor(() => expect(status()).toContain('已送达'))
    expect(bodies[1]).toBe(bodies[0])
    click('submit')
    await vi.waitFor(() => expect(bodies).toHaveLength(3))
    expect(JSON.parse(bodies[2]).submissionId).not.toBe(JSON.parse(bodies[0]).submissionId)
    expect(JSON.parse(bodies[2]).edits[0].afterMarkdown).toBe('second change')
  })
  it('takes annotations from the published baseline while preserving newer drafts', async () => {
    await projectShareBrowser(new Marked())
    const prompt = vi.fn(() => '评论')
    vi.stubGlobal('prompt', prompt)
    click('edit'); input('new draft')
    click('annotate')
    expect(status()).toContain('查看发布原文')
    expect(prompt).not.toHaveBeenCalled()
    click('baseline')
    const range = document.createRange()
    range.selectNodeContents($('document').querySelector('h1')!)
    const selection = window.getSelection()!
    selection.removeAllRanges(); selection.addRange(range)
    click('annotate')
    await vi.waitFor(() => expect(status()).toContain('标注已保存'))
    expect(values.get('project_1:snapshot_1').annotations).toEqual([{ path: 'README.md', quote: '方案', comment: '评论' }])
    expect(values.get('project_1:snapshot_1').drafts['README.md']).toBe('new draft')
  })
  it('keeps an exportable editor when storage is unavailable', async () => {
    fakeDatabase(0, true)
    await projectShareBrowser(new Marked())
    expect(status()).toContain('本地存储不可用')
    expect(($('edit') as HTMLButtonElement).disabled).toBe(false)
    click('edit'); input('unsaved')
    await vi.waitFor(() => expect(status()).toContain('未保存'))
    expect(($('submit') as HTMLButtonElement).disabled).toBe(true)
    expect(($('editor') as HTMLTextAreaElement).value).toBe('unsaved')
  })
})
