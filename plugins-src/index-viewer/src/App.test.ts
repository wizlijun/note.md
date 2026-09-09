import { mount, tick, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App.svelte'
import type { IndexCell, IndexDocument } from './lib/model'

const bridge = vi.hoisted(() => ({
  receive: null as null | ((value: IndexDocument) => void),
  unsubscribe: vi.fn(),
  open: vi.fn<(...args: string[]) => Promise<void>>(),
  cover: vi.fn<(...args: string[]) => Promise<string>>(),
  language: 'zh',
}))
vi.mock('./lib/bridge', () => ({
  locale: () => bridge.language,
  onDocument: (callback: (value: IndexDocument) => void) => { bridge.receive = callback; return bridge.unsubscribe },
  openLink: bridge.open,
  loadCover: bridge.cover,
}))
function cell(text: string, href?: string): IndexCell { return { text, links: href ? [{ text, href, start: 0, end: text.length }] : [], images: [] } }
function fixture(overrides: Partial<IndexDocument> = {}): IndexDocument {
  return { uri: '/vault/library.index.md', title: '项目资料', description: ['项目的阅读与开发资料。'], columns: ['文件', '状态', '项目', '补充'], view: 'table', groupBy: '状态', laneBy: '项目', rows: [
    { id: 'a', title: '设计笔记', href: './design.md', section: '文档', cells: [cell('设计笔记', './design.md'), cell('进行中'), cell('甲'), { text: '参见说明，保留备注', links: [{ text: '说明', href: './guide.md', start: 2, end: 4 }], images: [] }], cover: { alt: '设计封面', href: './cover.png' } },
    { id: 'b', title: '开发指南', href: './guide.md', section: '文档', cells: [cell('开发指南', './guide.md'), cell('完成'), cell('乙'), cell('工程')] },
    { id: 'c', title: '阅读清单', href: './reading.md', section: '阅读', cells: [cell('阅读清单', './reading.md'), cell('完成'), cell('甲'), cell('书籍')] },
  ], ...overrides }
}
function control<T extends HTMLElement>(label: string): T {
  const node = document.querySelector<T>(`[aria-label="${label}"]`)
  if (!node) throw new Error(`Missing control: ${label}`)
  return node
}
function button(text: string): HTMLButtonElement {
  const node = [...document.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === text)
  if (!node) throw new Error(`Missing button: ${text}`)
  return node
}
async function field(label: string, value: string) {
  const node = control<HTMLInputElement | HTMLSelectElement>(label)
  node.value = value
  node.dispatchEvent(new Event(node.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
  await tick()
}
function pending<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('Index viewer', () => {
  let app: ReturnType<typeof mount> | undefined
  let revoke: ReturnType<typeof vi.fn>
  beforeEach(() => {
    bridge.language = 'zh'
    bridge.receive = null
    bridge.unsubscribe.mockReset()
    bridge.open.mockReset().mockResolvedValue(undefined)
    bridge.cover.mockReset().mockResolvedValue('blob:cover')
    revoke = vi.fn()
    vi.stubGlobal('URL', Object.assign(URL, { revokeObjectURL: revoke }))
    vi.stubGlobal('IntersectionObserver', undefined)
  })
  afterEach(async () => {
    if (app) await unmount(app)
    app = undefined
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
  })
  async function start(doc = fixture()) {
    app = mount(App, { target: document.body })
    // Subscription is present synchronously, before mount effects flush.
    expect(bridge.receive).not.toBeNull()
    bridge.receive!(doc)
    await tick()
  }
  async function view(label: string) { control<HTMLButtonElement>(label).click(); await tick() }

  it('switches all four layouts using the same rows and preserves field text and links', async () => {
    await start()
    expect(document.querySelectorAll('tbody tr')).toHaveLength(3)
    expect(document.querySelector('tbody')?.textContent).toContain('参见说明，保留备注')
    for (const label of ['分组列表', '泳道看板', '封面画廊']) {
      await view(label)
      expect(document.querySelectorAll('article')).toHaveLength(3)
      expect(document.body.textContent).toContain('参见说明，保留备注')
    }
    button('说明').click()
    expect(bridge.open).toHaveBeenCalledWith('/vault/library.index.md', './guide.md')
    await view('表格')
    expect(document.querySelectorAll('tbody tr')).toHaveLength(3)
  })

  it('keeps a repeated plain label separate from its actual link', async () => {
    const doc = fixture()
    doc.rows[0].cells[3] = { text: '说明，以及说明', links: [{ text: '说明', href: './guide.md', start: 5, end: 7 }], images: [] }
    await start(doc)
    const target = document.querySelector('tbody tr td:last-child')!
    expect(target.textContent).toBe('说明，以及说明')
    expect(target.querySelectorAll('button')).toHaveLength(1)
    expect([...target.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent).join('')).toBe('说明，以及')
    target.querySelector('button')!.click()
    expect(bridge.open).toHaveBeenCalledWith('/vault/library.index.md', './guide.md')
  })

  it('groups by headings or a field, filters metadata, and renders two-dimensional lanes', async () => {
    await start()
    await view('泳道看板')
    expect(document.querySelectorAll('.board-cell')).toHaveLength(4)
    expect(control<HTMLElement>('甲 · 进行中').textContent).toContain('设计笔记')
    expect(control<HTMLElement>('乙 · 进行中').querySelector('article')).toBeNull()
    expect(control<HTMLElement>('甲 · 完成').textContent).toContain('阅读清单')
    await field('泳道字段', '')
    expect(document.querySelectorAll('.board-cell')).toHaveLength(2)
    await view('分组列表')
    await field('分组字段', '')
    expect(document.querySelectorAll('.list-group')).toHaveLength(2)
    await field('搜索索引', '书籍')
    expect(document.querySelectorAll('article')).toHaveLength(1)
    expect(document.querySelector('article')?.textContent).toContain('阅读清单')
    await field('搜索索引', '不存在')
    expect(document.body.textContent).toContain('没有匹配的文件')
  })

  it('hides table grouping controls while preserving the chosen group in other layouts', async () => {
    await start()
    expect(document.querySelector('[aria-label="分组字段"]')).toBeNull()
    await view('分组列表')
    await field('分组字段', '项目')
    await view('表格')
    expect(document.querySelector('[aria-label="分组字段"]')).toBeNull()
    await view('泳道看板')
    expect(control<HTMLSelectElement>('分组字段').value).toBe('项目')
  })

  it('keeps oversized board data accessible without rendering hundreds of empty intersections', async () => {
    const original = fixture()
    const rows = Array.from({ length: 21 }, (_, index) => ({
      ...original.rows[0], id: String(index), title: `文件 ${index}`, href: `./${index}.md`,
      cells: [cell(`文件 ${index}`, `./${index}.md`), cell(`状态 ${index}`), cell(`项目 ${index}`), cell('内容')],
    }))
    await start(fixture({ view: 'board', rows }))
    expect(document.querySelector('[role="status"]')?.textContent).toContain('分组过多')
    expect(document.querySelector('.board')).toBeNull()
    expect(control('分组字段')).toBeTruthy()
    await field('泳道字段', '')
    expect(document.querySelectorAll('.board-cell')).toHaveLength(21)
    expect(document.querySelectorAll('article')).toHaveLength(21)
    await field('泳道字段', '项目')
    await field('搜索索引', '文件 20')
    expect(document.querySelectorAll('.board-cell')).toHaveLength(1)
    expect(document.querySelector('article')?.textContent).toContain('文件 20')
    await field('搜索索引', '')
    await view('表格')
    expect(document.querySelectorAll('tbody tr')).toHaveLength(21)
  })

  it('resets transient state when another index is opened and unsubscribes on unmount', async () => {
    await start()
    await view('泳道看板')
    await field('搜索索引', '书籍')
    bridge.receive!(fixture({ uri: '/vault/other.index.md', title: '另一个索引', view: 'list', groupBy: '', laneBy: '' }))
    await tick()
    expect(document.querySelector('h1')?.textContent).toBe('另一个索引')
    expect(control<HTMLInputElement>('搜索索引').value).toBe('')
    expect(document.querySelectorAll('article')).toHaveLength(3)
    expect(control<HTMLButtonElement>('分组列表').getAttribute('aria-pressed')).toBe('true')
    button('设计笔记').click()
    expect(bridge.open).toHaveBeenCalledWith('/vault/other.index.md', './design.md')
    await unmount(app!)
    app = undefined
    expect(bridge.unsubscribe).toHaveBeenCalledOnce()
  })

  it('reports open errors and ignores an old document failure', async () => {
    await start()
    bridge.open.mockRejectedValueOnce(new Error('文件不存在'))
    button('设计笔记').click()
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('文件不存在'))
    const request = pending<void>()
    bridge.open.mockReturnValueOnce(request.promise)
    button('设计笔记').click()
    bridge.receive!(fixture({ title: '新索引' }))
    request.reject(new Error('旧错误'))
    await tick()
    await Promise.resolve()
    expect(document.querySelector('[role="alert"]')).toBeNull()
  })

  it('shows English controls and an empty table without inventing data', async () => {
    bridge.language = 'en'
    await start(fixture({ rows: [] }))
    expect(control('Search index')).toBeTruthy()
    expect(document.body.textContent).toContain('No files in this index')
  })

  it('loads visible covers lazily and releases a cover when leaving gallery', async () => {
    let intersect!: IntersectionObserverCallback
    const disconnect = vi.fn()
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: IntersectionObserverCallback) { intersect = callback }
      observe() {}
      disconnect = disconnect
    })
    await start(fixture({ view: 'gallery', rows: fixture().rows.slice(0, 1) }))
    expect(bridge.cover).not.toHaveBeenCalled()
    intersect([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver)
    await tick()
    await vi.waitFor(() => expect(document.querySelector('img')?.getAttribute('src')).toBe('blob:cover'))
    expect(bridge.cover).toHaveBeenCalledWith('/vault/library.index.md', './cover.png')
    expect(disconnect).toHaveBeenCalled()
    await view('表格')
    expect(revoke).toHaveBeenCalledWith('blob:cover')
  })

  it('releases stale cover results after a document change and after unmount', async () => {
    const first = pending<string>()
    const second = pending<string>()
    bridge.cover.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    await start(fixture({ view: 'gallery' }))
    await vi.waitFor(() => expect(bridge.cover).toHaveBeenCalledTimes(1))
    bridge.receive!(fixture({ uri: '/vault/new.index.md', view: 'gallery' }))
    await tick()
    await vi.waitFor(() => expect(bridge.cover).toHaveBeenCalledTimes(2))
    first.resolve('blob:old')
    await vi.waitFor(() => expect(revoke).toHaveBeenCalledWith('blob:old'))
    expect(document.querySelector('img')).toBeNull()
    await unmount(app!)
    app = undefined
    second.resolve('blob:after-unmount')
    await vi.waitFor(() => expect(revoke).toHaveBeenCalledWith('blob:after-unmount'))
  })

  it('shows a placeholder for missing, rejected, and undecodable covers', async () => {
    bridge.cover.mockRejectedValueOnce(new Error('missing image'))
    await start(fixture({ view: 'gallery' }))
    await vi.waitFor(() => expect(document.body.textContent).toContain('封面无法加载'))
    expect(document.body.textContent).toContain('暂无封面')
    bridge.receive!(fixture({ uri: '/vault/new.index.md', view: 'gallery' }))
    await vi.waitFor(() => expect(document.querySelector('img')).not.toBeNull())
    document.querySelector('img')!.dispatchEvent(new Event('error'))
    await tick()
    expect(document.querySelector('img')).toBeNull()
    expect(document.body.textContent).toContain('封面无法加载')
    await unmount(app!)
    app = undefined
    expect(revoke).toHaveBeenCalledWith('blob:cover')
  })
})
