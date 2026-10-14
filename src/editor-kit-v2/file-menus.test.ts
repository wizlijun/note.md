/** @vitest-environment happy-dom */
import { afterEach, expect, it } from 'vitest'
import { TextSelection } from 'prosemirror-state'
import { tick } from 'svelte'
import { mountFileEditor, type FileMountSession } from './file-main'
import { BrowserMediaResolver } from '@moraya/core/adapters/browser-media-resolver'
const sessions: FileMountSession[] = []
afterEach(async () => { for (const s of sessions.splice(0)) await s.owner.close(); document.body.replaceChildren() })
async function open(allowed = true) {
  const target = document.createElement('div'); document.body.append(target)
  const s = await mountFileEditor(target, { file: { documentId: 'a', authority: 'S', raw: '/' }, adapters: { mediaResolver: new BrowserMediaResolver() }, policy: { acceptRawChange: (before, after) => before === after || allowed } }, { styles: 'host' })
  sessions.push(s); s.view.dispatch(s.view.state.tr.setSelection(TextSelection.create(s.view.state.doc, 2))); s.menus.openSlash(); await tick(); return s
}
it('executes a real atomic slash command with one history event', async () => {
  const s = await open()
  const row = [...document.querySelectorAll<HTMLElement>('.menu-row')].find(row => row.textContent?.includes('Heading 1'))!
  row.click(); await tick(); expect(s.owner.snapshot().raw).toBe('# ')
  expect(s.owner.undo()).toBe(true); expect(s.owner.snapshot().raw).toBe('/')
})
it('policy rejection retains slash and menu; a stale popup cannot dispatch', async () => {
  const s = await open(false), before = s.owner.snapshot()
  document.querySelectorAll<HTMLElement>('.menu-row')[3].click(); await tick()
  expect(s.owner.snapshot()).toEqual(before); expect(document.querySelector('.slash-menu')).not.toBeNull()
  s.view.dispatch(s.view.state.tr.setSelection(TextSelection.create(s.view.state.doc, 1)))
  document.querySelectorAll<HTMLElement>('.menu-row')[3].click(); await tick()
  expect(s.owner.snapshot()).toEqual(before)
})
