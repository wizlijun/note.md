/** @vitest-environment happy-dom */
import { afterEach, expect, it, vi } from 'vitest'
import { tick } from 'svelte'
import { shareEditor } from './main'
import * as fileMount from '../editor-kit-v2/file-main'
import type { ShareEditorHandleE1, ShareEditorHost } from './contract'
import type { DraftV2 } from '../lib/project-share/types'
import { sha256Sync } from '../lib/share-merge/hash'
const handles: ShareEditorHandleE1[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const h of handles.splice(0)) await h.destroy(); document.body.replaceChildren() })
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
async function button(target: HTMLElement, text: string) { const el = [...target.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') ?? b.textContent) === text)!; el.click(); await tick(); await new Promise(r => setTimeout(r, 0)) }
async function clickNote(target: HTMLElement, kind: 'range' | 'point', note: string) {
  const badge = target.querySelector<HTMLElement>(`${kind === 'range' ? '.note-badge' : '.moraya-note-anchor'}[data-note="${note}"]`)!
  badge.click(); await tick()
  const textarea = target.querySelector<HTMLTextAreaElement>('.note-edit textarea')!
  expect(textarea.value).toBe(note)
  return textarea
}
async function saveNote(textarea: HTMLTextAreaElement, text: string) {
  textarea.value = text; textarea.dispatchEvent(new Event('input', { bubbles: true }))
  textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await tick()
}
it.each(['range', 'point'] as const)('adjacent %s badge edits and deletes only the clicked annotation with shared undo/redo', async kind => {
  const raw = '{==Text==}{>>RANGE<<}{>>POINT<<}', f = fixture('Text')
  f.draft.after['a.md'] = raw
  const { target, handle, draft, submit, pending } = await open(f)
  const note = kind === 'range' ? 'RANGE' : 'POINT'
  const changed = kind === 'range' ? '{==Text==}{>>CHANGED<<}{>>POINT<<}' : '{==Text==}{>>RANGE<<}{>>CHANGED<<}'
  const removed = kind === 'range' ? 'Text{>>POINT<<}' : '{==Text==}{>>RANGE<<}'
  async function expectRaw(expected: string) { await handle.buildSubmission({}); expect(draft.after['a.md']).toBe(expected) }
  await saveNote(await clickNote(target, kind, note), 'CHANGED')
  await expectRaw(changed)
  await button(target, '撤销'); await expectRaw(raw)
  await button(target, '重做'); await expectRaw(changed)
  await clickNote(target, kind, 'CHANGED')
  target.querySelector<HTMLButtonElement>('.note-edit .del')!.click(); await tick()
  await expectRaw(removed)
  await button(target, '撤销'); await expectRaw(changed)
  await button(target, '重做'); await expectRaw(removed)
  expect(submit).not.toHaveBeenCalled(); expect(pending).not.toHaveBeenCalled()
})
it.each(['range', 'point'] as const)('adjacent owner %s badge cannot bypass owner floor by editing or deleting', async kind => {
  const raw = '{==Text==}{>>RANGE<<}{>>POINT<<}', { target, host, draft } = await open(fixture(raw))
  const note = kind === 'range' ? 'RANGE' : 'POINT'
  const textarea = await clickNote(target, kind, note)
  await saveNote(textarea, 'CHANGED')
  expect(target.querySelector('.note-edit [role="status"]')).not.toBeNull()
  expect(target.querySelector<HTMLTextAreaElement>('.note-edit textarea')?.value).toBe('CHANGED')
  expect(draft.after['a.md'] ?? draft.base['a.md'].markdown).toBe(raw)
  target.querySelector<HTMLButtonElement>('.note-edit .del')!.click(); await tick()
  expect(target.querySelector('.note-edit')).not.toBeNull()
  expect(host.notify).toHaveBeenCalledWith('分享者批注需保留；请添加自己的批注')
  await saveNote(textarea, note)
  expect(target.querySelector('.note-edit')).toBeNull()
  await button(target, '撤销'); await button(target, '重做')
  await button(target, '源码')
  expect(target.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe(raw)
})
it('real mount is Rich by default; three mode cycles preserve BOM/frontmatter/raw without edits', async () => {
  const { target, handle, draft } = await open()
  expect(target.querySelector('.ProseMirror')).not.toBeNull(); expect(target.querySelector('[data-theme]')?.getAttribute('data-theme')).toBe('frozen-custom')
  expect(document.querySelector('link[href$="editor-kit-v1.css"]')).toBeNull()
  for (let i = 0; i < 3; i++) { await button(target, '源码'); await button(target, '富文本') }
  const result = await handle.buildSubmission({})
  expect(JSON.parse(result.body).edits).toEqual([]); expect(draft.after['a.md']).toBe(draft.base['a.md'].markdown)
  expect('rebase' in handle).toBe(true)
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
  await button(target, '源码'); const ta = target.querySelector('textarea')!; ta.value = 'B'; ta.dispatchEvent(new Event('input', { bubbles: true }))
  saveDraft.mockRejectedValueOnce(new Error('disk full'))
  await expect(handle.switchFile('b.md')).rejects.toThrow('disk full')
  expect(target.querySelector('textarea')?.value).toBe('B')
  await handle.switchFile('b.md'); expect(draft.after['a.md']).toBe('B'); expect(target.textContent).toContain('Other')
})
it('E3 Mermaid load failure retains editable source and asks host for the optional loader', async () => {
  const { target, host, handle } = await open(fixture('```mermaid\ngraph TD; A-->B\n```'))
  await new Promise(r => setTimeout(r, 220))
  expect(target.querySelector('pre')?.style.display).not.toBe('none')
  expect(host.loadMermaid).toHaveBeenCalledTimes(1)
  expect(JSON.parse((await handle.buildSubmission({})).body).edits).toEqual([])
})

function rebaseFixture() {
  const f = fixture('甲。\n\n乙。\n')
  f.draft.after['a.md'] = '甲！\n\n乙。\n'
  f.host.snapshot.snapshotId = 'S2'
  f.host.snapshot.files[0] = { path: 'a.md', markdown: '甲。\n\n乙！\n{>>新主人<<}', hash: sha256Sync('甲。\n\n乙！\n{>>新主人<<}') }
  let live = f.draft, durable = structuredClone(live)
  f.host.saveDraft = vi.fn(async value => { if (value !== live) throw Error('stale'); durable = structuredClone(value); return durable })
  f.host.transitionDraft = vi.fn(async (expected, next) => { if (expected !== live) throw Error('stale'); durable = structuredClone(next); live = next; return structuredClone(durable) })
  return { ...f, live: () => live, durable: () => durable }
}
it('real rebase UI installs new authority/floor and explicit undo restores old raw/base/sid', async () => {
  const f = rebaseFixture(), { target, handle } = await open(f)
  const old = structuredClone(f.draft), pending = handle.rebase(f.host.snapshot, f.draft)
  await vi.waitFor(() => expect(target.querySelector('[aria-label="在新版本上继续"]')).not.toBeNull())
  await button(target, '完成迁移'); expect((await pending).status).toBe('applied')
  const built = JSON.parse((await handle.buildSubmission({})).body)
  expect(built).toMatchObject({ snapshotId: 'S2', rebasedFrom: 'S' })
  expect(f.live().after['a.md']).toBe('甲！\n\n乙！\n{>>新主人<<}')
  const note = await clickNote(target, 'point', '新主人')
  await saveNote(note, '删除新主人'); expect(f.live().after['a.md']).toContain('{>>新主人<<}')
  await saveNote(note, '新主人')
  await button(target, '撤销 rebase'); await vi.waitFor(() => expect(f.live().snapshotId).toBe('S'))
  expect(f.live().base).toEqual(old.base); expect(f.live().after).toEqual(old.after)
  await button(target, '源码'); const restored = target.querySelector('textarea')!
  restored.value = '撤销后可以编辑'; restored.dispatchEvent(new Event('input', { bubbles: true })); await handle.buildSubmission({})
  expect(f.live().after['a.md']).toBe('撤销后可以编辑')
})
it('checks the frozen transition receipt while a later description edit updates the live aggregate', async () => {
  const f = rebaseFixture(), transition = f.host.transitionDraft!
  f.host.transitionDraft = async (...args) => {
    const durable = await transition(...args)
    args[1].message = 'queued description'
    return durable
  }
  const { target, handle } = await open(f), pending = handle.rebase(f.host.snapshot, f.draft)
  await vi.waitFor(() => expect(target.querySelector('[aria-label="在新版本上继续"]')).not.toBeNull())
  await button(target, '完成迁移')
  expect((await pending).status).toBe('applied')
  expect(f.live()).toMatchObject({ snapshotId: 'S2', message: 'queued description', previous: { snapshotId: 'S' } })
})
it('cancel leaves aggregate byte-identical and pending never opens a rebase panel', async () => {
  const f = rebaseFixture(), { target, handle } = await open(f)
  await handle.buildSubmission({}); const old = structuredClone(f.draft)
  const pending = handle.rebase(f.host.snapshot, f.draft)
  await vi.waitFor(() => expect(target.querySelector('[aria-label="在新版本上继续"]')).not.toBeNull())
  await button(target, '取消'); expect(await pending).toEqual({ status: 'cancelled' }); expect(f.live()).toEqual(old)
  f.draft.pending = { submissionId: 'pending', body: '{}' }
  await expect(handle.rebase(f.host.snapshot, f.draft)).rejects.toThrow('冻结')
})
it('install failure durably restores old aggregate and retains a recoverable candidate', async () => {
  const mount = fileMount.mountFileEditor
  let fail = true
  vi.spyOn(fileMount, 'mountFileEditor').mockImplementation(async (...args) => {
    const mounted = await mount(...args), install = mounted.owner.installBaseline
    mounted.owner.installBaseline = (...args) => fail ? { ok: false, reason: 'injected-install-failure' } : install(...args)
    return mounted
  })
  const f = rebaseFixture(), { target, handle } = await open(f), pending = handle.rebase(f.host.snapshot, f.draft)
  await vi.waitFor(() => expect(target.querySelector('[aria-label="在新版本上继续"]')).not.toBeNull())
  await button(target, '完成迁移'); await vi.waitFor(() => expect(target.textContent).toContain('injected-install-failure'))
  expect(f.durable().snapshotId).toBe('S'); expect(f.durable().rebaseRecovery?.candidate.snapshotId).toBe('S2')
  expect(target.querySelector('.ProseMirror')?.textContent).toContain('甲！')
  fail = false; await button(target, '完成迁移'); await pending; await vi.waitFor(() => expect(f.live().snapshotId).toBe('S2'))
  expect(f.live().rebaseRecovery).toBeUndefined(); expect(f.live().previous?.snapshotId).toBe('S')
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
  await button(target, '源码')
  const textarea = target.querySelector('textarea')!; textarea.value = 'Autosaved'; textarea.dispatchEvent(new Event('input', { bubbles: true }))
  await vi.waitFor(() => expect(saveDraft).toHaveBeenCalled())
  expect((await saveDraft.mock.results[0].value).after['a.md']).toBe('Autosaved')
  expect(draft.after['a.md']).toBe('Autosaved'); expect(submit).not.toHaveBeenCalled(); expect(pending).not.toHaveBeenCalled()
})
it('autosave failure retains input and the next edit can retry', async () => {
  const { target, draft, saveDraft, host } = await open(fixture('A'))
  saveDraft.mockRejectedValueOnce(new Error('disk full'))
  await button(target, '源码'); const textarea = target.querySelector('textarea')!
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
  await button(target, '源码'); const textarea = target.querySelector('textarea')!
  textarea.value = 'B'; textarea.dispatchEvent(new Event('input', { bubbles: true }))
  await vi.waitFor(() => expect(saveDraft).toHaveBeenCalledOnce())
  textarea.value = 'C'; textarea.dispatchEvent(new Event('input', { bubbles: true })); release()
  await vi.waitFor(() => expect(saveDraft).toHaveBeenCalledTimes(2))
  expect((await saveDraft.mock.results[1].value).after['a.md']).toBe('C')
  expect(submit).not.toHaveBeenCalled(); expect(pending).not.toHaveBeenCalled()
})
it('My changes reverts only one current hunk through shared history and decorates actual bindings',async()=> {
 const f=fixture('第一句。\n\n第二句。\n');f.draft.after['a.md']='第一句！\n\n第二句！\n'
 const {target,handle,draft}=await open(f)
 await button(target,'我的修改')
 const actions=target.querySelectorAll('aside button')
 expect(actions).toHaveLength(2)
 expect(target.querySelectorAll('[data-cdr-kind="proposal"]')).toHaveLength(2)
 ;(actions[0] as HTMLButtonElement).click();await tick()
 await handle.buildSubmission({})
 expect(draft.after['a.md']).toBe('第一句。\n\n第二句！\n')
 await button(target,'撤销');await handle.buildSubmission({})
 expect(draft.after['a.md']).toBe('第一句！\n\n第二句！\n')
})

it('build refuses an unconfirmed durable snapshot and never freezes or submits',async()=> {
 const {handle,saveDraft,submit,pending}=await open(fixture('A'))
 saveDraft.mockImplementationOnce(async d=>({...structuredClone(d),after:{'a.md':'wrong durable raw'}}))
 await expect(handle.buildSubmission({})).rejects.toThrow('file-save-not-confirmed')
 expect(submit).not.toHaveBeenCalled();expect(pending).not.toHaveBeenCalled()
})

it('failed initialization releases its real owner even when durability fails and preserves recovery', async () => {
  const f = fixture('A'), target = document.createElement('div'); document.body.append(target)
  f.host.setFileBadges = vi.fn(() => { throw Error('mount callback failed') })
  f.saveDraft.mockRejectedValue(new Error('disk full'))
  await expect(shareEditor.mount(target, f.host, { path: 'a.md' })).rejects.toMatchObject({ unsavedDraft: true })
  expect(target.querySelector('.share-editor-root')).toBeNull()
  expect(target.querySelector('.ProseMirror')).toBeNull()
  expect(f.draft.after['a.md']).toBe('A')
  expect(f.draft.editorFiles?.['a.md'].sourceHash).toBe(sha256Sync('A'))
  f.saveDraft.mockImplementation(async d => structuredClone(d)); f.host.setFileBadges = vi.fn()
  const handle = await shareEditor.mount(target, f.host, { path: 'a.md' }); handles.push(handle)
  expect(target.querySelectorAll('.ProseMirror')).toHaveLength(1)
})
