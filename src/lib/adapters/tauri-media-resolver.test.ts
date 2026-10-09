// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DOMSerializer } from 'prosemirror-model'
import { createSchema, parseMarkdown, setDocumentBaseDir } from '@moraya/core'
import { TauriMediaResolver } from './tauri-media-resolver'

const { readFile } = vi.hoisted(() => ({ readFile: vi.fn() }))
vi.mock('@tauri-apps/plugin-fs', () => ({ readFile }))

const SRC = '/ssot/web/The%20Angel%20VC/2014-10-05-five-ways-to-build-a-100-million-business/chart.png'
const PATH = '/ssot/web/The Angel VC/2014-10-05-five-ways-to-build-a-100-million-business/chart.png'
let serial = 0
let vault: string

beforeEach(() => {
  vault = `/vault-${++serial}`
  readFile.mockReset().mockResolvedValue(new Uint8Array([1, 2, 3]))
  setDocumentBaseDir(`${vault}/notes`)
})

function render(markdown: string, resolver = new TauriMediaResolver(() => ({ vaultRoot: vault, baseDir: `${vault}/notes` }))) {
  const schema = createSchema({ mediaResolver: resolver })
  const doc = parseMarkdown(markdown, schema)
  const host = document.createElement('div')
  host.append(DOMSerializer.fromSchema(schema).serializeFragment(doc.content))
  return host
}

describe('rich media — vault-first local resources', () => {
  it('renders the reported angle-bracket Markdown image from the vault', async () => {
    const host = render(`![](<${SRC}>)`)
    await vi.waitFor(() => expect(host.querySelector('img')?.getAttribute('src')).toMatch(/^blob:/))
    expect(readFile.mock.calls.map(([path]) => path)).toEqual([vault + PATH])
  })

  it('falls back to the full path when the vault resource cannot be read', async () => {
    readFile.mockImplementation(async (path) => {
      if (path === vault + PATH) throw new Error('not found')
      return new Uint8Array([1])
    })
    const host = render(`![](<${SRC}>)`)
    await vi.waitFor(() => expect(host.querySelector('img')?.getAttribute('src')).toMatch(/^blob:/))
    expect(readFile.mock.calls.map(([path]) => path)).toEqual([vault + PATH, PATH])
  })

  it.each([
    ['<img src="/assets/hello%20world.png?v=1#part">', 'img', '/assets/hello world.png'],
    ['<video src="/assets/hello%20world.mp4?v=1#t=2" controls></video>', 'video', '/assets/hello world.mp4'],
    ['<audio src="/assets/hello%20world.mp3" controls></audio>', 'audio', '/assets/hello world.mp3'],
    ['<video controls><source src="/assets/hello%20world.webm"></video>', 'source', '/assets/hello world.webm'],
  ])('resolves HTML media consistently: %s', async (html, selector, path) => {
    const host = render(html)
    await vi.waitFor(() => expect(host.querySelector(selector)?.getAttribute('src')).toMatch(/^blob:/))
    expect(readFile).toHaveBeenCalledWith(vault + path)
  })

  it('loads local video posters as images', async () => {
    const host = render('<video poster="/assets/cover%20photo.png" controls></video>')
    await vi.waitFor(() => expect(host.querySelector('video')?.getAttribute('poster')).toMatch(/^blob:/))
    expect(readFile).toHaveBeenCalledWith(`${vault}/assets/cover photo.png`)
  })

  it('does not decode the document filesystem directory or double-decode filenames', async () => {
    const resolver = new TauriMediaResolver(() => ({ vaultRoot: vault, baseDir: `${vault}/literal%20` }))
    const host = render('![](./part%2520%23one%3F.png?view=1#section)', resolver)
    await vi.waitFor(() => expect(host.querySelector('img')?.getAttribute('src')).toMatch(/^blob:/))
    expect(readFile).toHaveBeenCalledWith(`${vault}/literal%20/part%20#one?.png`)
  })

  it('keeps explicit file URLs outside vault-first resolution', async () => {
    const host = render('<img src="file:///tmp/explicit%20image.png">')
    await vi.waitFor(() => expect(host.querySelector('img')?.getAttribute('src')).toMatch(/^blob:/))
    expect(readFile.mock.calls.map(([path]) => path)).toEqual(['/tmp/explicit image.png'])
  })

  it('uses the owning document after another editor changes the global base directory', async () => {
    let baseDir = `${vault}/one`
    const resolver = new TauriMediaResolver(() => ({ vaultRoot: vault, baseDir }))
    setDocumentBaseDir('/other-vault/two')
    render('![](./one.png)', resolver)
    await vi.waitFor(() => expect(readFile).toHaveBeenCalledWith(`${vault}/one/one.png`))
    baseDir = `${vault}/renamed`
    render('![](./two.png)', resolver)
    await vi.waitFor(() => expect(readFile).toHaveBeenCalledWith(`${vault}/renamed/two.png`))
  })

  it('does not reuse a blob from another vault for the same root-relative URL', async () => {
    const first = render('![](/same.png)')
    await vi.waitFor(() => expect(first.querySelector('img')?.getAttribute('src')).toMatch(/^blob:/))
    vault += '-other'
    const second = render('![](/same.png)')
    await vi.waitFor(() => expect(second.querySelector('img')?.getAttribute('src')).toMatch(/^blob:/))
    expect(second.querySelector('img')?.getAttribute('src')).not.toBe(first.querySelector('img')?.getAttribute('src'))
    expect(readFile).toHaveBeenCalledTimes(2)
  })

  it('leaves remote and data images untouched', () => {
    const host = render('![](https://example.com/a%20b.png)\n\n![](data:image/png;base64,YQ==)')
    expect(host.querySelector('img')?.getAttribute('src')).toBe('https://example.com/a%20b.png')
    expect(readFile).not.toHaveBeenCalled()
  })
})
