/** @vitest-environment happy-dom */
import { afterEach, expect, it, vi } from 'vitest'
import { bundleMediaResolver, shareMediaPlugin, sharedPath } from './media'
import { mountFileEditor } from '../editor-kit-v2/file-main'
import type { FileMountSession } from '../editor-kit-v2/file-main'
const data = 'data:image/png;base64,iVBORw0KGgo='
const files = [{ path: 'img.png', dataUrl: data }, { path: 'remote.png', dataUrl: 'https://evil.test/a.png' }]
const sessions: FileMountSession[] = []
afterEach(async () => { for (const s of sessions.splice(0)) await s.owner.close(); vi.restoreAllMocks(); document.body.replaceChildren() })
it('only resolves approved shared raster data and rejects escapes/schemes', async () => {
  const resolver = bundleMediaResolver(files, 'docs/a.md')
  expect(await resolver.loadLocalImage('../img.png')).toBe(data)
  expect(await resolver.loadLocalImage('/ignored', { src: '../img.png', baseDir: '/arbitrary' })).toBe(data)
  for (const src of ['../../img.png', 'https://evil.test/img.png', '//evil.test/img.png', 'file:///img.png', '../remote.png', '../missing.png', '%2fimg.png']) expect(await resolver.loadLocalImage(src)).toBe('')
  expect(await resolver.loadRemoteMedia('https://evil.test')).toBe('')
  expect(sharedPath('../a.md', 'docs/b.md')).toBe('a.md')
})
it('real mount overrides remote image and HTML media before DOM assignment', async () => {
  const raw = '![ok](img.png)\n\n![remote](https://evil.test/a.png) ![relative](//evil.test/b.png) ![file](file:///private/a.png) ![missing](missing.png)\n\ninline <img src="https://evil.test/c.png" srcset="https://evil.test/d.png 2x"> <video src="https://evil.test/v.mp4" poster="https://evil.test/p.png"></video> <audio src="https://evil.test/a.mp3"><source src="https://evil.test/s.mp3"></audio>'
  const assigned: string[] = [], src = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')!
  vi.spyOn(HTMLImageElement.prototype, 'src', 'set').mockImplementation(function (this: HTMLImageElement, value: string) { assigned.push(value); src.set!.call(this, value) })
  const target = document.createElement('div'); document.body.append(target)
  const resolver = bundleMediaResolver(files, 'a.md')
  const session = await mountFileEditor(target, { file: { documentId: 'a', authority: 'a', raw }, adapters: { mediaResolver: resolver } }, { styles: 'host', plugins: [shareMediaPlugin(resolver, vi.fn())] })
  sessions.push(session); await Promise.resolve()
  expect(assigned).toEqual([data]); expect(target.querySelector('video,audio,source,[srcset],[poster]')).toBeNull()
  expect(session.owner.snapshot().raw).toBe(raw); expect(session.owner.canUndo()).toBe(false)
  expect(await session.setMode('source')).toBe(true); expect(await session.setMode('rich')).toBe(true)
  expect(session.owner.snapshot().raw).toBe(raw)
})
it('actual DOM paste/drop block attachments before core paste and keep ordinary text', async () => {
  const target = document.createElement('div'); document.body.append(target)
  const resolver = bundleMediaResolver(files, 'a.md'), notify = vi.fn()
  const session = await mountFileEditor(target, { file: { documentId: 'a', authority: 'a', raw: 'A' }, adapters: { mediaResolver: resolver } }, { styles: 'host', plugins: [shareMediaPlugin(resolver, notify)] })
  sessions.push(session)
  for (const kind of ['paste', 'drop']) {
    const event = new Event(kind, { bubbles: true, cancelable: true })
    Object.defineProperty(event, kind === 'paste' ? 'clipboardData' : 'dataTransfer', { value: { files: [new File(['x'], 'image.png', { type: 'image/png' })], items: [], getData: () => 'BAD' } })
    session.view.dom.dispatchEvent(event); expect(event.defaultPrevented).toBe(true)
  }
  expect(session.owner.snapshot().raw).toBe('A'); expect(notify).toHaveBeenCalledTimes(2)
  const paste = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(paste, 'clipboardData', { value: { files: [], items: [], getData: (type: string) => type === 'text/plain' ? 'plain' : '' } })
  session.view.dom.dispatchEvent(paste)
  expect(session.owner.snapshot().raw).toContain('plain')
})
