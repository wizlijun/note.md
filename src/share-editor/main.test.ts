/** @vitest-environment happy-dom */
import { afterEach, expect, it, vi } from 'vitest'
import { tick } from 'svelte'
import { shareEditor } from './main'
import type { ShareEditorHandleE1, ShareEditorHost } from './contract'
import type { DraftV2 } from '../lib/project-share/types'
import { sha256Sync } from '../lib/share-merge/hash'
const handles: ShareEditorHandleE1[] = []
afterEach(async () => { for (const h of handles.splice(0)) await h.destroy(); document.body.replaceChildren() })
function fixture(raw = '\uFEFF---\r\ntitle: X\r\n---\r\n\r\nHello\r\n') {
  const draft: DraftV2 = { v: 2, lineageId: 'L', snapshotId: 'S', base: { 'a.md': { markdown: raw, hash: sha256Sync(raw) } }, after: {}, annotationKinds: {} }
  const pending = vi.fn(), submit = vi.fn(async () => ({ ok: true as const })), saveDraft = vi.fn(async (d: DraftV2) => { if (d.pending) pending(); return structuredClone(d) })
  const host: ShareEditorHost = { apiVersion: 1, snapshot: { project_id: 'P', snapshotId: 'S', entry: 'a.md', files: [{ path: 'a.md', markdown: raw, hash: sha256Sync(raw) }, { path: 'b.md', markdown: 'Other', hash: sha256Sync('Other') }] }, theme: { themeId: 'frozen-custom' }, loadDraft: async () => draft, saveDraft, submit, notify: vi.fn(), openFile: vi.fn(), setFileBadges: vi.fn(), loadMermaid: vi.fn() }
  return { draft, host, submit, saveDraft, pending }
}
async function open(f = fixture()) {
  const target = document.createElement('div'); document.body.append(target)
  const handle = await shareEditor.mount(target, f.host, { path: 'a.md' }); handles.push(handle)
  await tick(); return { ...f, handle, target }
}
async function button(target: HTMLElement, text: string) { const el = [...target.querySelectorAll('button')].find(b => b.textContent === text)!; el.click(); await tick(); await new Promise(r => setTimeout(r, 0)) }
it('real mount is Rich by default; three mode cycles preserve BOM/frontmatter/raw without edits', async () => {
  const { target, handle, draft } = await open()
  expect(target.querySelector('.ProseMirror')).not.toBeNull(); expect(target.querySelector('[data-theme]')?.getAttribute('data-theme')).toBe('frozen-custom')
  expect(document.querySelector('link[href$="editor-kit-v1.css"]')).toBeNull()
  for (let i = 0; i < 3; i++) { await button(target, 'Source'); await button(target, 'Rich') }
  const result = await handle.buildSubmission({})
  expect(JSON.parse(result.body).edits).toEqual([]); expect(draft.after['a.md']).toBe(draft.base['a.md'].markdown)
  expect('rebase' in handle).toBe(false)
})
it('build and repeated preview never submit or freeze pending; flush failure does not build', async () => {
  const { handle, submit, pending, saveDraft } = await open()
  const a = await handle.buildSubmission({}), b = await handle.buildSubmission({})
  expect(a.submissionId).not.toBe(b.submissionId); expect(submit).not.toHaveBeenCalled(); expect(pending).not.toHaveBeenCalled()
  saveDraft.mockRejectedValueOnce(new Error('disk full'))
  await expect(handle.buildSubmission({})).rejects.toThrow('disk full')
  expect(submit).not.toHaveBeenCalled(); expect(pending).not.toHaveBeenCalled()
})
it('switch failure preserves the live editor and Source retry; success flushes before switching', async () => {
  const { handle, target, draft, saveDraft } = await open(fixture('A'))
  await button(target, 'Source'); const ta = target.querySelector('textarea')!; ta.value = 'B'; ta.dispatchEvent(new Event('input', { bubbles: true }))
  saveDraft.mockRejectedValueOnce(new Error('disk full'))
  await expect(handle.switchFile('b.md')).rejects.toThrow('disk full')
  expect(target.querySelector('textarea')?.value).toBe('B')
  await handle.switchFile('b.md'); expect(draft.after['a.md']).toBe('B'); expect(target.textContent).toContain('Other')
})
it('E1 real Mermaid draft stays source and does not ask host for the optional loader', async () => {
  const { target, host, handle } = await open(fixture('```mermaid\ngraph TD; A-->B\n```'))
  await new Promise(r => setTimeout(r, 220))
  expect(target.querySelector('pre')?.style.display).not.toBe('none')
  expect(host.loadMermaid).not.toHaveBeenCalled()
  expect(JSON.parse((await handle.buildSubmission({})).body).edits).toEqual([])
})
it('only navigates shared relative links and wikilinks through the host', async () => {
  const { target, host } = await open(fixture('[other](b.md) [[b]] [external](https://evil.test)'))
  target.querySelector<HTMLElement>('a[href="b.md"]')!.click()
  target.querySelector<HTMLElement>('[data-wikilink]')!.click()
  target.querySelector<HTMLElement>('a[href="https://evil.test"]')!.click()
  expect(host.openFile).toHaveBeenCalledTimes(2); expect(host.openFile).toHaveBeenLastCalledWith('b.md')
})
it('autosaves ordinary source input durably without pending or submission', async () => {
  const { target, draft, saveDraft, submit, pending } = await open(fixture('A'))
  await button(target, 'Source')
  const textarea = target.querySelector('textarea')!; textarea.value = 'Autosaved'; textarea.dispatchEvent(new Event('input', { bubbles: true }))
  await vi.waitFor(() => expect(saveDraft).toHaveBeenCalled())
  expect((await saveDraft.mock.results[0].value).after['a.md']).toBe('Autosaved')
  expect(draft.after['a.md']).toBe('Autosaved'); expect(submit).not.toHaveBeenCalled(); expect(pending).not.toHaveBeenCalled()
})
it('autosave failure retains input and the next edit can retry', async () => {
  const { target, draft, saveDraft, host } = await open(fixture('A'))
  saveDraft.mockRejectedValueOnce(new Error('disk full'))
  await button(target, 'Source'); const textarea = target.querySelector('textarea')!
  textarea.value = 'B'; textarea.dispatchEvent(new Event('input', { bubbles: true }))
  await vi.waitFor(() => expect(host.notify).toHaveBeenCalledWith('草稿保存失败，输入仍保留，请重试或导出'))
  expect(textarea.value).toBe('B'); expect(draft.after['a.md']).toBe('B')
  textarea.value = 'C'; textarea.dispatchEvent(new Event('input', { bubbles: true }))
  await vi.waitFor(() => expect(saveDraft).toHaveBeenCalledTimes(2))
  expect((await saveDraft.mock.results[1].value).after['a.md']).toBe('C')
})
it('typing during autosave schedules another save of the continuing input', async () => {
  const { target, saveDraft, submit, pending } = await open(fixture('A'))
  let release!: () => void
  saveDraft.mockImplementationOnce(async d => { const stored = structuredClone(d); await new Promise<void>(resolve => { release = resolve }); return stored })
  await button(target, 'Source'); const textarea = target.querySelector('textarea')!
  textarea.value = 'B'; textarea.dispatchEvent(new Event('input', { bubbles: true }))
  await vi.waitFor(() => expect(saveDraft).toHaveBeenCalledOnce())
  textarea.value = 'C'; textarea.dispatchEvent(new Event('input', { bubbles: true })); release()
  await vi.waitFor(() => expect(saveDraft).toHaveBeenCalledTimes(2))
  expect((await saveDraft.mock.results[1].value).after['a.md']).toBe('C')
  expect(submit).not.toHaveBeenCalled(); expect(pending).not.toHaveBeenCalled()
})
