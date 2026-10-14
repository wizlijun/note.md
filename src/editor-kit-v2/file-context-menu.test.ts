/** @vitest-environment happy-dom */
import { afterEach, expect, it, vi } from 'vitest'
import { tick } from 'svelte'
import { TextSelection } from 'prosemirror-state'
import { BrowserMediaResolver } from '@moraya/core/adapters/browser-media-resolver'
import { mountFileEditor, type FileMountSession } from './file-main'
import { noteUi } from '../lib/note-anno/note-ui.svelte'
import { ownerAnnotationFloor, acceptsOwnerFloor } from '../share-editor/owner-policy'

const sessions: FileMountSession[] = []
afterEach(async () => { noteUi.edit = null; for (const f of sessions.splice(0)) await f.owner.close(); document.body.replaceChildren(); vi.restoreAllMocks() })
async function fixture(raw = 'Alpha\n\n__Keep__\n', policy = (_before: string, _after: string) => true) {
  const target = document.createElement('div'); document.body.append(target)
  const notify = vi.fn()
  const f = await mountFileEditor(target, { file: { documentId: 'a.md', authority: 'A', raw }, adapters: { mediaResolver: new BrowserMediaResolver() }, policy: { acceptRawChange: policy } }, { styles: 'host', notify })
  sessions.push(f); return { f, target, notify, raw }
}
function select(f: FileMountSession, from: number, to = from) { f.view.dispatch(f.view.state.tr.setSelection(TextSelection.create(f.view.state.doc, from, to))) }
async function open(f: FileMountSession) { f.view.dom.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })); await tick() }
function row(label: string) { return [...document.querySelectorAll<HTMLElement>('.menu-row')].find(el => el.querySelector('.ctx-label')?.textContent === label)! }
async function choose(label: string) { expect(row(label)).toBeTruthy(); row(label).click(); await tick(); await new Promise(r => setTimeout(r, 0)) }

it('real Rich context formatting shares source-preserving undo and Source output', async () => {
  const { f, raw } = await fixture(); select(f, 1, 6); await open(f)
  expect(document.querySelector('.ctx-menu.menu-panel')).not.toBeNull()
  await choose('Bold'); expect(f.owner.snapshot().raw).toBe('**Alpha**\n\n__Keep__\n')
  expect(f.owner.undo()).toBe(true); expect(f.owner.snapshot().raw).toBe(raw)
  select(f, 3); await open(f); await choose('Italic')
  expect(f.owner.snapshot().raw).toBe('*Alpha*\n\n__Keep__\n')
  expect(await f.setMode('source')).toBe(true)
  expect(document.querySelector('textarea')?.value).toBe('*Alpha*\n\n__Keep__\n')
})

it('uses real table alignment without unavailable image insertion or Trace', async () => {
  const { f } = await fixture('| A | B |\n|---|---|\n| 1 | 2 |\n')
  let pos = 0; f.view.state.doc.descendants((node, position) => { if (!pos && node.isText && node.text === '1') pos = position })
  select(f, pos); await open(f)
  expect(row('Trace source')).toBeUndefined()
  const alignment = row('Column alignment'); expect(alignment).toBeTruthy(); alignment.dispatchEvent(new MouseEvent('mouseenter')); await tick()
  await choose('Align center'); expect(f.owner.snapshot().raw).toBe('| A | B |\n| :---: | --- |\n| 1 | 2 |\n')
  await open(f); row('Insert').dispatchEvent(new MouseEvent('mouseenter')); await tick()
  expect(row('Image…')).toBeUndefined(); expect(row('Table')).toBeTruthy()
})

it.each(['baseline', 'generation', 'source-return', 'readonly-return', 'selection', 'detach-return', 'current'] as const)('delayed context paste respects %s', async change => {
  const { f, target } = await fixture('A'); select(f, 1)
  let resolve!: (text: string) => void
  vi.spyOn(navigator.clipboard, 'readText').mockImplementation(() => new Promise(r => { resolve = r }))
  await open(f); await choose('Paste'); expect(resolve).toBeTypeOf('function')
  if (change === 'baseline') f.owner.installBaseline({ documentId: 'b.md', authority: 'B', raw: 'B' })
  if (change === 'generation') f.owner.restoreContent('B')
  if (change === 'source-return') { await f.setMode('source'); await f.setMode('rich') }
  if (change === 'readonly-return') { f.owner.setReadOnly(true); f.owner.setReadOnly(false) }
  if (change === 'selection') select(f, 2)
  if (change === 'detach-return') { f.destroyView(); f.attach(target) }
  resolve('X'); await tick(); await new Promise(r => setTimeout(r, 0))
  expect(f.owner.snapshot().raw).toBe(change === 'baseline' || change === 'generation' ? 'B' : change === 'current' ? 'XA' : 'A')
})

it('clipboard denial preserves text and reports how to paste', async () => {
  const { f, raw, notify } = await fixture(); select(f, 1, 6)
  vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'))
  await open(f); await choose('Cut'); expect(f.owner.snapshot().raw).toBe(raw)
  vi.spyOn(navigator.clipboard, 'readText').mockRejectedValue(new Error('denied'))
  await open(f); await choose('Paste'); expect(f.owner.snapshot().raw).toBe(raw)
  expect(notify).toHaveBeenCalledWith('无法读取剪贴板，请使用键盘粘贴（Ctrl/⌘+V）')
})

it('cut cannot remove owner annotations and note/question use the admitted popup', async () => {
  const raw = '{==Alpha==}{>>owner<<}\n', floor = ownerAnnotationFloor(raw, raw)
  const { f } = await fixture(raw, (_before, after) => acceptsOwnerFloor(floor, after)); select(f, 1, 6)
  vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
  await open(f); await choose('Cut'); expect(f.owner.snapshot().raw).toBe(raw)
  const other = await fixture('Plain'); select(other.f, 3); const insert = vi.spyOn(other.f.annotations, 'insert')
  await open(other.f); await choose('Ask'); expect(insert).toHaveBeenCalledWith('?'); expect(noteUi.edit).not.toBeNull()
})

it('Source and read-only do not open a mutating menu; mode changes close an existing menu', async () => {
  const { f } = await fixture(); await open(f); expect(document.querySelector('.ctx-menu')).not.toBeNull()
  await f.setMode('source'); await tick(); expect(document.querySelector('.ctx-menu')).toBeNull()
  await f.setMode('rich'); f.owner.setReadOnly(true); await open(f); expect(document.querySelector('.ctx-menu')).toBeNull()
})
