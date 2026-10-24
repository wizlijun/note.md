// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Schema } from 'prosemirror-model'
import { EditorState } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { createResourceActions, findRichResource } from './resource-actions'

const mocks = vi.hoisted(() => ({
  exists: vi.fn(), readFile: vi.fn(), writeText: vi.fn(), save: vi.fn(), invoke: vi.fn(),
  showError: vi.fn(), copyImage: vi.fn(), fetch: vi.fn(), writeImage: vi.fn(),
}))
vi.mock('@tauri-apps/plugin-fs', () => ({ exists: mocks.exists, readFile: mocks.readFile }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: mocks.save }))
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({ writeText: mocks.writeText, writeImage: mocks.writeImage }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: mocks.fetch }))
vi.mock('../dialogs', () => ({ showError: mocks.showError }))
vi.mock('../copy-image', () => ({ copyImageToClipboard: mocks.copyImage }))

beforeEach(() => { vi.resetAllMocks() })
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('resource actions', () => {
  it.each([
    ['../附件/报告%20副本%2520.pdf', { baseDir: '/资料/100%20/笔记' }, '/资料/100%20/附件/报告 副本%20.pdf', '报告 副本%20.pdf'],
    ['C:\\资料\\报告%20副本.pdf', {}, 'C:/资料/报告 副本.pdf', '报告 副本.pdf'],
    ['file:///C:/资料/报告%2520.pdf', {}, 'C:/资料/报告%20.pdf', '报告%20.pdf'],
  ])('copies decoded filename and real absolute path: %s', async (src, context, path, name) => {
    mocks.exists.mockResolvedValue(true)
    const actions = createResourceActions({ src }, context)
    await actions.run('copyFileName')
    expect(mocks.writeText).toHaveBeenLastCalledWith(name)
    await actions.run('copyFilePath')
    expect(mocks.exists).toHaveBeenCalledWith(path)
    expect(mocks.readFile).not.toHaveBeenCalled()
    expect(mocks.writeText).toHaveBeenLastCalledWith(path)
  })

  it('uses the same vault-first fallback as rendering and preserves original bytes', async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0x00, 0x80, 0xff, 0xd9])
    mocks.readFile.mockImplementation(async (path: string) => {
      if (path === '/vault/Users/me/照片.jpg') throw new Error('not found')
      return bytes
    })
    mocks.exists.mockImplementation(async (path: string) => path === '/Users/me/照片.jpg')
    mocks.save.mockResolvedValue('/Downloads/照片.jpg')
    const actions = createResourceActions({ src: '/Users/me/照片.jpg' }, { vaultRoot: '/vault' })
    await actions.run('copyFilePath')
    expect(mocks.writeText).toHaveBeenLastCalledWith('/Users/me/照片.jpg')
    expect(mocks.exists.mock.calls).toEqual([['/vault/Users/me/照片.jpg'], ['/Users/me/照片.jpg']])
    await actions.run('saveResourceAs')
    expect(mocks.invoke).toHaveBeenCalledWith('write_file_binary', {
      path: '/Downloads/照片.jpg', base64Data: '/9gAgP/Z',
    })
    expect(mocks.copyImage).not.toHaveBeenCalled()
  })

  it('prefers an existing vault resource over the filesystem fallback', async () => {
    mocks.exists.mockResolvedValue(true)
    await createResourceActions({ src: '/附件/a.pdf' }, { vaultRoot: '/vault' }).run('copyFilePath')
    expect(mocks.exists).toHaveBeenCalledTimes(1)
    expect(mocks.writeText).toHaveBeenCalledWith('/vault/附件/a.pdf')
  })

  it('cancelling Save As neither reads nor writes the file', async () => {
    mocks.save.mockResolvedValue(null)
    await createResourceActions({ src: 'a.zip' }, { baseDir: '/vault' }).run('saveResourceAs')
    expect(mocks.readFile).not.toHaveBeenCalled()
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it('reports missing files without copying a guessed path', async () => {
    mocks.exists.mockResolvedValue(false)
    const actions = createResourceActions({ src: '/a.pdf' }, { vaultRoot: '/vault' })
    await expect(actions.run('copyFilePath')).resolves.toBeUndefined()
    expect(mocks.showError).toHaveBeenCalledWith('Error: File not found: /a.pdf')
    expect(mocks.writeText).not.toHaveBeenCalled()
  })

  it('reports write failure without rejecting the menu action', async () => {
    mocks.readFile.mockResolvedValue(new Uint8Array([1]))
    mocks.save.mockResolvedValue('/Downloads/a.pdf')
    mocks.invoke.mockRejectedValue(new Error('disk full'))
    await expect(createResourceActions({ src: '/a.pdf' }, {}).run('saveResourceAs')).resolves.toBeUndefined()
    expect(mocks.showError).toHaveBeenCalledWith('Error: disk full')
  })

  it('keeps bitmap copying distinct from filename and path copying', async () => {
    const image = document.createElement('img')
    const actions = createResourceActions({ src: 'a.png', image }, { baseDir: '/vault' })
    expect(actions.canRun('copyImage')).toBe(true)
    await actions.run('copyImage')
    expect(mocks.copyImage).toHaveBeenCalledWith(image)
    expect(mocks.writeText).not.toHaveBeenCalled()
    expect(mocks.readFile).not.toHaveBeenCalled()
    mocks.copyImage.mockRejectedValue(new Error('clipboard unavailable'))
    await actions.run('copyImage')
    expect(mocks.showError).toHaveBeenCalledWith('Error: clipboard unavailable')
  })

  it('downloads remote bytes through native HTTP and decodes the URL filename', async () => {
    const src = 'https://example.com/%E6%8A%A5%E5%91%8A%20v2.pdf?token=123#page=2'
    const actions = createResourceActions({ src }, {})
    expect(actions.canRun('copyFilePath')).toBe(false)
    expect(actions.canRun('copyImage')).toBe(false)
    expect(actions.canRun('bold')).toBe(false)
    await actions.run('copyFileName')
    expect(mocks.writeText).toHaveBeenLastCalledWith('报告 v2.pdf')
    await actions.run('copyResourceLink')
    expect(mocks.writeText).toHaveBeenLastCalledWith(src)
    mocks.save.mockResolvedValue('/Downloads/report.pdf')
    mocks.fetch.mockResolvedValue(new Response(new Uint8Array([0, 255, 12])))
    await actions.run('saveResourceAs')
    expect(mocks.fetch).toHaveBeenCalledWith(src)
    expect(mocks.save).toHaveBeenCalledWith({ defaultPath: '报告 v2.pdf' })
    expect(mocks.invoke).toHaveBeenCalledWith('write_file_binary', { path: '/Downloads/report.pdf', base64Data: 'AP8M' })
  })

  it('does not save an HTTP error response as the attachment', async () => {
    mocks.save.mockResolvedValue('/Downloads/a.pdf')
    mocks.fetch.mockResolvedValue(new Response('not found', { status: 404 }))
    await createResourceActions({ src: 'https://example.com/a.pdf' }, {}).run('saveResourceAs')
    expect(mocks.invoke).not.toHaveBeenCalled()
    expect(mocks.showError).toHaveBeenCalledWith(expect.stringContaining('404'))
  })

  it('downloads protocol-relative remote attachments over HTTPS', async () => {
    mocks.save.mockResolvedValue('/Downloads/a.pdf')
    mocks.fetch.mockResolvedValue(new Response(new Uint8Array([1])))
    const actions = createResourceActions({ src: '//cdn.example.com/a.pdf' }, {})
    expect(actions.canRun('saveResourceAs')).toBe(true)
    expect(actions.canRun('copyFilePath')).toBe(false)
    await actions.run('saveResourceAs')
    expect(mocks.fetch).toHaveBeenCalledWith('https://cdn.example.com/a.pdf')
  })

  it.each([
    ['data:image/gif;base64,R0lGODlh', 'download.gif'],
    ['blob:http://localhost/image-identifier', 'download.bin'],
  ])('supports embedded URLs without inventing an absolute path: %s', async (src, name) => {
    const browserFetch = vi.fn().mockResolvedValue(new Response(new Uint8Array([71, 73, 70])))
    vi.stubGlobal('fetch', browserFetch)
    mocks.save.mockResolvedValue('/Downloads/' + name)
    const actions = createResourceActions({ src }, {})
    expect(actions.canRun('copyFilePath')).toBe(false)
    await actions.run('saveResourceAs')
    expect(mocks.save).toHaveBeenCalledWith({ defaultPath: name })
    expect(browserFetch).toHaveBeenCalledWith(src)
    expect(mocks.fetch).not.toHaveBeenCalled()
    expect(mocks.invoke).toHaveBeenCalledWith('write_file_binary', { path: '/Downloads/' + name, base64Data: 'R0lG' })
  })

  it('unresolved relative files retain the filename but cannot claim an absolute path', async () => {
    const actions = createResourceActions({ src: '附件/a.pdf' }, {})
    expect(actions.canRun('copyFilePath')).toBe(false)
    expect(actions.canRun('saveResourceAs')).toBe(false)
    await actions.run('copyFileName')
    expect(mocks.writeText).toHaveBeenCalledWith('a.pdf')
  })
})

describe('findRichResource with a real ProseMirror view', () => {
  const schema = new Schema({ nodes: {
    doc: { content: 'paragraph+' },
    paragraph: { content: 'inline*', toDOM: () => ['p', 0] },
    text: { group: 'inline' },
    image: {
      inline: true, group: 'inline', atom: true, attrs: { src: {} },
      toDOM: () => ['span', { class: 'image-node' }, ['img', { src: 'blob:rendered-image' }]],
    },
  } })
  let view: EditorView
  beforeEach(() => {
    view = new EditorView(document.body, { state: EditorState.create({ schema, doc: schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text('before '), schema.node('image', { src: '附件/原图%20v2.jpg' })]),
    ]) }) })
  })
  afterEach(() => view.destroy())

  it('reads original Markdown src from the image node, including its padding and broken state', () => {
    const wrapper = view.dom.querySelector('.image-node')!
    const image = wrapper.querySelector('img')!
    expect(findRichResource(image, view)).toEqual({ src: '附件/原图%20v2.jpg', image })
    expect(findRichResource(wrapper, view)).toEqual({ src: '附件/原图%20v2.jpg', image })
    wrapper.className = 'broken-image'
    wrapper.innerHTML = '<code>broken</code>'
    expect(findRichResource(wrapper.firstElementChild, view)).toEqual({ src: '附件/原图%20v2.jpg', image: undefined })
  })

  it('uses original HTML src for image and media whose rendered src is a blob', () => {
    for (const tag of ['img', 'audio', 'video']) {
      const wrapper = document.createElement('span')
      wrapper.dataset.type = 'html-inline'
      wrapper.dataset.value = `<${tag} src="附件/原文件%20v2.${tag}"></${tag}>`
      wrapper.innerHTML = `<${tag} src="blob:rendered"></${tag}>`
      view.dom.appendChild(wrapper)
      expect(findRichResource(wrapper.firstElementChild, view)?.src).toBe(`附件/原文件%20v2.${tag}`)
    }
  })

  it('recognizes nested attachment links and data-url without resolving them against the web origin', () => {
    const anchor = document.createElement('a')
    anchor.setAttribute('href', '../files/report.pdf')
    anchor.innerHTML = '<strong>report</strong>'
    view.dom.appendChild(anchor)
    expect(findRichResource(anchor.firstElementChild, view)).toEqual({ src: '../files/report.pdf' })
    anchor.dataset.url = '附件/report.zip'
    expect(findRichResource(anchor, view)).toEqual({ src: '附件/report.zip' })
    anchor.dataset.wikilink = 'note'
    expect(findRichResource(anchor, view)).toBeNull()
  })

  it('ignores plain text, fragment navigation, and elements outside the editor', () => {
    expect(findRichResource(view.dom.querySelector('p')!.firstChild, view)).toBeNull()
    const anchor = document.createElement('a')
    anchor.href = '#section'
    view.dom.appendChild(anchor)
    expect(findRichResource(anchor, view)).toBeNull()
    const external = document.createElement('img')
    external.src = 'https://example.com/a.png'
    expect(findRichResource(external, view)).toBeNull()
  })
})

describe('remote image clipboard fallback', () => {
  it('decodes native HTTP bytes into an untainted bitmap and writes the image clipboard', async () => {
    const { copyImageToClipboard } = await vi.importActual<typeof import('../copy-image')>('../copy-image')
    const drawImage = vi.fn()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockImplementationOnce(() => { throw new Error('tainted canvas') })
      .mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(callback => {
      callback(new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }))
    })
    const bitmap = { width: 8, height: 8, close: vi.fn() }
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(bitmap))
    const image = document.createElement('img')
    Object.defineProperties(image, { naturalWidth: { value: 8 }, naturalHeight: { value: 8 } })
    image.src = 'https://example.com/image.jpg'
    mocks.fetch.mockResolvedValue(new Response(new Uint8Array([255, 216, 255])))
    await copyImageToClipboard(image)
    expect(mocks.fetch).toHaveBeenCalledWith(image.src)
    expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0)
    expect(mocks.writeImage).toHaveBeenCalledWith(new Uint8Array([137, 80, 78, 71]))
    expect(bitmap.close).toHaveBeenCalled()
  })

  it('uses native HTTP after a tainted canvas and reports failed HTTP responses', async () => {
    const { copyImageToClipboard } = await vi.importActual<typeof import('../copy-image')>('../copy-image')
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => { throw new Error('tainted canvas') })
    const image = document.createElement('img')
    image.src = 'https://example.com/image.jpg'
    mocks.fetch.mockResolvedValue(new Response('not found', { status: 403 }))
    await expect(copyImageToClipboard(image)).rejects.toThrow('Download failed (403)')
    expect(mocks.fetch).toHaveBeenCalledWith(image.src)
    expect(mocks.writeImage).not.toHaveBeenCalled()
  })
})
