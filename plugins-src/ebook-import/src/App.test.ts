import { mount, tick, unmount } from 'svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from './App.svelte'
import type { NotemdBridge } from './lib/bridge'
import type { RawBook } from './lib/library'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('import queue retry', () => {
  let app: ReturnType<typeof mount> | undefined

  afterEach(async () => {
    if (app) await unmount(app)
    app = undefined
    document.body.innerHTML = ''
    localStorage.clear()
  })

  async function importFixture(start: (attempt: number, params: any) => Promise<{ job_id: number }>, books: RawBook[] = []) {
    let push: ((payload: unknown) => void) | undefined
    let attempt = 0
    const request = vi.fn(async (method: string, params?: any) => {
      if (method === 'plugin.detect_env') return { ready: true, settings: { provider: 'wechat' } }
      if (method === 'plugin.library_list') return { books }
      if (method === 'plugin.topic_state') return {
        revision: 'r1',
        catalog: { schema_version: 1, topics: [{
          id: 'communication', label: '沟通与表达', description: 'Communication books',
          index_file: 'communication.index.md', vocabulary: ['communication'],
        }] },
        counts: {}, unclassified_books: [], unknown_topic_books: [],
      }
      if (method === 'plugin.import_start') return start(++attempt, params)
      return {}
    })
    window.notemd = {
      pluginId: 'notemd.ebook-import', locale: 'zh', theme: 'light', request,
      onMessage: (callback) => { push = callback },
    } satisfies NotemdBridge
    app = mount(App, { target: document.body })
    await vi.waitFor(() => expect(document.querySelector('.topic-bar')?.textContent).toContain('沟通与表达'))
    return {
      request,
      sendEvent: (payload: unknown) => push?.(payload),
      starts: () => request.mock.calls.filter(([method]) => method === 'plugin.import_start'),
    }
  }

  async function addClassifiedBook(sendEvent: (payload: unknown) => void, path: string) {
    sendEvent({ type: 'drag-drop', phase: 'drop', paths: [path] })
    await tick()
    const row = [...document.querySelectorAll<HTMLElement>('.queue .row')].find(
      (candidate) => candidate.querySelector('.name')?.getAttribute('title') === path,
    )!
    const topic = row.querySelector<HTMLSelectElement>('.topic-select')!
    topic.value = 'communication'
    topic.dispatchEvent(new Event('change', { bubbles: true }))
    await tick()
    return row
  }

  function retryButton(row: HTMLElement) {
    const button = [...row.querySelectorAll<HTMLButtonElement>('button')].find(
      (candidate) => candidate.textContent?.trim() === '重试',
    )
    expect(button).toBeDefined()
    return button!
  }

  it.each(['OCR incomplete: failed pages: [20]', 'cancelled'])(
    'retries the existing %s row with its original options and ignores stale job failures',
    async (error) => {
      const retryStart = deferred<{ job_id: number }>()
      const { request, sendEvent, starts } = await importFixture(async (attempt) =>
        attempt === 1 ? { job_id: 30 } : retryStart.promise,
      )
      const path = '/tmp/Truth and Beauty - Aesthetics and Motivations in Science.pdf'
      const row = await addClassifiedBook(sendEvent, path)
      const reason = row.querySelector<HTMLTextAreaElement>('textarea')!
      reason.value = '张老师推荐：“读读这本”\n当时在讨论科学与美。'
      reason.dispatchEvent(new Event('input', { bubbles: true }))
      await tick()
      const ocr = document.querySelector<HTMLInputElement>('.ocr input[type="checkbox"]')!
      ocr.click()
      await tick()
      document.querySelector<HTMLButtonElement>('.queue button.start')!.click()
      await vi.waitFor(() => expect(starts()).toHaveLength(1))
      expect(starts()[0][1]).toEqual({ path, topic_id: 'communication', reading_reason: reason.value, ocr: true, provider: 'wechat' })
      expect(reason.disabled).toBe(true)
      await tick()
      sendEvent({ type: 'job', job_id: 30, event: 'log', line: 'Saved OCR page 19 of 188' })
      sendEvent({ type: 'job', job_id: 30, event: 'progress', stage: 'ocr', page: 19, total: 188 })
      sendEvent({ type: 'job', job_id: 30, event: 'failed', error })
      await tick()
      expect(row.querySelector('.badge')?.textContent).toContain(error === 'cancelled' ? '已取消' : '失败')
      row.querySelector<HTMLButtonElement>('.chevron')!.click()
      await tick()
      expect(row.querySelector('.log')?.textContent).toContain('Saved OCR page 19 of 188')

      // Preferences can change between attempts; retry must retain this book's original choices.
      const provider = document.querySelector<HTMLSelectElement>('.ocr select')!
      provider.value = 'baidu'
      provider.dispatchEvent(new Event('change', { bubbles: true }))
      ocr.click()
      await tick()
      const retry = retryButton(row)
      retry.click()
      retry.click()
      await vi.waitFor(() => expect(starts()).toHaveLength(2))
      expect(starts()[1][1]).toEqual(starts()[0][1])
      expect(reason.disabled).toBe(true)
      expect(reason.value).toBe('张老师推荐：“读读这本”\n当时在讨论科学与美。')
      expect(request.mock.calls.some(([method]) => method === 'host.dialog.open')).toBe(false)
      expect(document.querySelectorAll('.queue .row')).toHaveLength(1)
      expect(document.querySelector('.queue .row')).toBe(row)
      expect(row.querySelector('.badge')?.classList.contains('running')).toBe(true)
      expect(row.querySelector('.badge')?.textContent).toContain('19/188')
      expect(row.querySelector('.log')?.textContent).toContain('Saved OCR page 19 of 188')

      sendEvent({ type: 'job', job_id: 30, event: 'failed', error: 'late failure from old attempt' })
      await tick()
      expect(row.querySelector('.badge')?.classList.contains('running')).toBe(true)
      expect(row.textContent).not.toContain('late failure from old attempt')
      expect(starts()).toHaveLength(2)
      retryStart.resolve({ job_id: 31 })
      await tick()
      sendEvent({ type: 'job', job_id: 31, event: 'done', dest_rel: 'ebooks/Truth and Beauty' })
      await vi.waitFor(() => expect(row.querySelector('.badge')?.classList.contains('done')).toBe(true))
      expect(document.querySelectorAll('.queue .row')).toHaveLength(1)
      expect(document.querySelector('.queue .row')).toBe(row)
      expect(row.querySelector('.dest')?.textContent).toBe('ebooks/Truth and Beauty')
      expect(row.querySelector('.log')?.textContent).toContain('Saved OCR page 19 of 188')
    },
  )

  it('submits separate multiline reading reasons and omits blank optional input', async () => {
    const { sendEvent, starts } = await importFixture(async (attempt) => ({ job_id: 29 + attempt }))
    const first = await addClassifiedBook(sendEvent, '/tmp/First.epub')
    const second = await addClassifiedBook(sendEvent, '/tmp/Second.epub')
    const third = await addClassifiedBook(sendEvent, '/tmp/Third.epub')
    const reasons = ['朋友：推荐第一本\n情景：午餐讨论', '读书会推荐第二本', '   \n  ']
    for (const [index, row] of [first, second, third].entries()) {
      const textarea = row.querySelector<HTMLTextAreaElement>('textarea')!
      expect(textarea.getAttribute('placeholder')).toContain('谁推荐')
      textarea.value = reasons[index]
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    }
    await tick()
    document.querySelector<HTMLButtonElement>('.queue button.start')!.click()
    await vi.waitFor(() => expect(starts()).toHaveLength(1))
    expect(starts()[0][1].reading_reason).toBe(reasons[0])
    expect(first.querySelector('textarea')!.disabled).toBe(true)
    expect(second.querySelector('textarea')!.disabled).toBe(false)
    sendEvent({ type: 'job', job_id: 30, event: 'done', dest_rel: 'ebooks/First' })
    await vi.waitFor(() => expect(starts()).toHaveLength(2))
    expect(starts()[1][1].reading_reason).toBe(reasons[1])
    expect(second.querySelector('textarea')!.disabled).toBe(true)
    sendEvent({ type: 'job', job_id: 31, event: 'done', dest_rel: 'ebooks/Second' })
    await vi.waitFor(() => expect(starts()).toHaveLength(3))
    expect(starts()[2][1]).not.toHaveProperty('reading_reason')
  })

  it('shows saved reading context as expandable text and leaves old or blank books unchanged', async () => {
    const reason = '李老师推荐：“理解系统”\n当时讨论设计。<script>unsafe()</script>'
    await importFixture(async () => ({ job_id: 30 }), [
      { rel: 'ebooks/New', name: 'New', month: '2026-10', summaries: [], reading_reason: reason },
      { rel: 'ebooks/Old', name: 'Old', month: '2026-10', summaries: [] },
      { rel: 'ebooks/Blank', name: 'Blank', month: '2026-10', summaries: [], reading_reason: ' \n ' },
      { rel: 'ebooks/Null', name: 'Null', month: '2026-10', summaries: [], reading_reason: null },
    ])
    await vi.waitFor(() => expect(document.querySelectorAll('.library .row')).toHaveLength(4))
    const details = document.querySelectorAll<HTMLDetailsElement>('.library details.reading-reason')
    expect(details).toHaveLength(1)
    expect(details[0].open).toBe(false)
    expect(details[0].querySelector('summary')!.textContent).toBe('阅读原因')
    details[0].querySelector('summary')!.click()
    expect(details[0].open).toBe(true)
    expect(details[0].querySelector('p')!.textContent).toBe(reason)
    expect(details[0].querySelector('script')).toBeNull()
  })

  it('queues a retry behind another running import without launching a concurrent job', async () => {
    const { sendEvent, starts } = await importFixture(async (attempt) => ({ job_id: 29 + attempt }))
    const first = await addClassifiedBook(sendEvent, '/tmp/First.pdf')
    await addClassifiedBook(sendEvent, '/tmp/Second.pdf')
    document.querySelector<HTMLButtonElement>('.queue button.start')!.click()
    await vi.waitFor(() => expect(starts()).toHaveLength(1))
    await tick()
    sendEvent({ type: 'job', job_id: 30, event: 'failed', error: 'OCR incomplete' })
    await vi.waitFor(() => expect(starts()).toHaveLength(2))
    await tick()
    retryButton(first).click()
    await tick()
    expect(starts()).toHaveLength(2)
    expect(first.querySelector('.badge')?.classList.contains('pending')).toBe(true)
    sendEvent({ type: 'job', job_id: 31, event: 'done', dest_rel: 'ebooks/Second' })
    await vi.waitFor(() => expect(starts()).toHaveLength(3))
    expect(starts()[2][1]).toEqual(starts()[0][1])
    expect(document.querySelectorAll('.queue .row')).toHaveLength(2)
    expect(first.querySelector('.badge')?.classList.contains('running')).toBe(true)
  })
})

describe('topic design Agent picker', () => {
  let app: ReturnType<typeof mount> | undefined

  afterEach(async () => {
    if (app) await unmount(app)
    app = undefined
    document.body.innerHTML = ''
    localStorage.clear()
  })

  it('lets topic design choose a supported Agent independently from AI reading', async () => {
    localStorage.setItem('notemd.agent.provider.ebook-import', 'notemd.claude-agent')
    const requests: Array<{ method: string; params: unknown }> = []
    const request = vi.fn(async (method: string, params?: unknown) => {
      requests.push({ method, params })
      if (method === 'host.agent.providers') {
        return {
          default: 'notemd.codex-agent',
          providers: [
            { id: 'notemd.claude-agent', name: 'Claude Agent', harness: { harness: 'Claude Code', ok: true } },
            { id: 'notemd.codex-agent', name: 'Codex Agent', harness: { harness: 'Codex', ok: true } },
            { id: 'notemd.deepseek-agent', name: 'DeepSeek Agent', harness: { harness: 'DeepSeek Harness', ok: true } },
          ],
        }
      }
      if (method === 'plugin.detect_env') return { ready: true, settings: {} }
      if (method === 'plugin.library_list') {
        return {
          books: [{ rel: 'ebooks/2026-09/Example', name: 'Example', month: '2026-09', summaries: [] }],
        }
      }
      if (method === 'plugin.topic_state') {
        return {
          revision: 'r1',
          catalog: {
            schema_version: 1,
            topics: [
              {
                id: 'general',
                label: 'General',
                description: 'General books',
                vocabulary: ['book'],
                index_file: 'general.index.md',
              },
            ],
          },
          counts: { general: 1 },
          unclassified_books: [],
          unknown_topic_books: [],
        }
      }
      if (method === 'plugin.topic_agent_start') return { job_id: 7 }
      return {}
    })
    window.notemd = {
      pluginId: 'notemd.ebook-import',
      locale: 'zh',
      theme: 'light',
      request,
      onMessage: () => {},
    } satisfies NotemdBridge

    app = mount(App, { target: document.body })
    await vi.waitFor(() => {
      expect(document.querySelector('.topic-actions button[aria-haspopup="menu"]')).not.toBeNull()
    })

    const topicPicker = document.querySelector<HTMLButtonElement>(
      '.topic-actions button[aria-haspopup="menu"]',
    )
    expect(topicPicker?.textContent).toContain('Codex')
    expect(document.querySelector('.topic-agent-status')?.textContent).toContain(
      '可能读取整个 Vault',
    )
    topicPicker?.click()
    await tick()

    const deepSeek = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
      .find((button) => button.textContent?.includes('DeepSeek'))
    expect(deepSeek).toBeDefined()
    deepSeek?.click()
    await tick()

    expect(localStorage.getItem('notemd.agent.provider.ebook-topic-design')).toBe(
      'notemd.deepseek-agent',
    )
    expect(localStorage.getItem('notemd.agent.provider.ebook-import')).toBe(
      'notemd.claude-agent',
    )

    const designButton = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === 'AI 根据书库设计主题',
    )
    expect(designButton?.disabled).toBe(false)
    designButton?.click()
    await vi.waitFor(() => {
      expect(requests).toContainEqual({
        method: 'plugin.topic_agent_start',
        params: { harness: 'notemd.deepseek-agent' },
      })
    })
  })

  it('stages AI batch classification edits and applies them once after confirmation', async () => {
    const requests: Array<{ method: string; params: any }> = []
    const rebuilding = deferred<{ ok: boolean }>()
    let push: ((payload: unknown) => void) | undefined
    const request = vi.fn(async (method: string, params?: unknown) => {
      requests.push({ method, params })
      if (method === 'host.agent.providers') {
        return {
          default: 'notemd.codex-agent',
          providers: [
            { id: 'notemd.codex-agent', name: 'Codex Agent', harness: { harness: 'Codex', ok: true } },
          ],
        }
      }
      if (method === 'plugin.detect_env') return { ready: true, settings: {} }
      if (method === 'plugin.library_list') {
        return {
          books: [
            { rel: 'ebooks/2026-09/A', name: 'Book A', month: '2026-09', summaries: [] },
            { rel: 'ebooks/2026-09/B', name: 'Book B', month: '2026-09', summaries: [] },
          ],
        }
      }
      if (method === 'plugin.topic_state') {
        return {
          revision: 'sha256:catalog',
          catalog: {
            schema_version: 1,
            topics: [
              {
                id: 'engineering',
                label: 'Engineering',
                description: 'Build systems',
                index_file: 'engineering.index.md',
                vocabulary: [
                  { term: 'architecture', description: 'system structure' },
                  { term: 'reliability', description: 'correct service' },
                ],
              },
              {
                id: 'business',
                label: 'Business',
                description: 'Build companies',
                index_file: 'business.index.md',
                vocabulary: [
                  { term: 'strategy', description: 'competitive choices' },
                  { term: 'market', description: 'buyers and sellers' },
                ],
              },
            ],
          },
          counts: {},
          unclassified_books: ['2026-09/A', '2026-09/B'],
          unknown_topic_books: [],
        }
      }
      if (method === 'plugin.topic_classification_start') return { job_id: 9, book_count: 2 }
      if (method === 'plugin.topic_classification_apply') return rebuilding.promise
      return {}
    })
    window.notemd = {
      pluginId: 'notemd.ebook-import',
      locale: 'zh',
      theme: 'light',
      request,
      onMessage: (callback) => { push = callback },
    } satisfies NotemdBridge

    app = mount(App, { target: document.body })
    const classify = await vi.waitFor(() => {
      const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
        (candidate) => candidate.textContent?.includes('AI 批量分类 2 本'),
      )
      expect(button).toBeDefined()
      return button!
    })
    classify.click()
    await vi.waitFor(() => {
      expect(requests).toContainEqual({
        method: 'plugin.topic_classification_start',
        params: { harness: 'notemd.codex-agent' },
      })
    })

    push?.({
      type: 'topic_classification',
      job_id: 9,
      event: 'done',
      proposal: {
        schema_version: 1,
        inventory_sha256: 'inventory',
        catalog_revision: 'sha256:catalog',
        assignments: [
          { book: '2026-09/A', topic_id: 'engineering' },
          { book: '2026-09/B', topic_id: 'business' },
        ],
      },
    })
    await tick()

    const selects = [...document.querySelectorAll<HTMLSelectElement>('[role="dialog"] select')]
    expect(selects).toHaveLength(2)
    selects[0].value = 'business'
    selects[0].dispatchEvent(new Event('change', { bubbles: true }))
    await tick()
    expect(requests.filter(({ method }) => method === 'plugin.topic_classification_apply')).toHaveLength(0)
    expect(requests.filter(({ method }) => method === 'plugin.topic_assign')).toHaveLength(0)

    const confirm = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
      (button) => button.textContent?.includes('确认并应用 2 本'),
    )
    expect(confirm).toBeDefined()
    const stateReads = requests.filter(({ method }) => method === 'plugin.topic_state').length
    const libraryReads = requests.filter(({ method }) => method === 'plugin.library_list').length
    confirm?.click()
    await vi.waitFor(() => {
      const applies = requests.filter(({ method }) => method === 'plugin.topic_classification_apply')
      expect(applies).toHaveLength(1)
      expect(applies[0].params.proposal.assignments).toEqual([
        { book: '2026-09/A', topic_id: 'business' },
        { book: '2026-09/B', topic_id: 'business' },
      ])
    })
    expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-busy')).toBe('true')
    expect(confirm?.disabled).toBe(true)
    expect(requests.filter(({ method }) => method === 'plugin.topic_state')).toHaveLength(stateReads)
    expect(requests.filter(({ method }) => method === 'plugin.library_list')).toHaveLength(libraryReads)
    rebuilding.resolve({ ok: true })
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull())
    expect(requests.filter(({ method }) => method === 'plugin.topic_state')).toHaveLength(stateReads + 1)
    expect(requests.filter(({ method }) => method === 'plugin.library_list')).toHaveLength(libraryReads + 1)
  })

  function topicFixture(persist: (method: string, params: any) => Promise<unknown>) {
    let push: ((payload: unknown) => void) | undefined
    const topics = ['engineering', 'business'].map((id) => ({
      id,
      label: id,
      description: `${id} books`,
      index_file: `${id}.index.md`,
      vocabulary: [
        { term: 'one', description: 'First term' },
        { term: 'two', description: 'Second term' },
      ],
    }))
    const state = { topicId: 'engineering', topics }
    const request = vi.fn(async (method: string, params?: any) => {
      if (method === 'plugin.detect_env') return { ready: true, settings: {} }
      if (method === 'plugin.library_list') return { books: [{
        rel: 'ebooks/2026-09/Example', name: 'Example', month: '2026-09', summaries: [],
        topic_id: state.topicId, topic_label: state.topicId,
      }] }
      if (method === 'plugin.topic_state') return {
        revision: 'r1', catalog: { schema_version: 1, topics: state.topics },
        counts: { [state.topicId]: 1 }, unclassified_books: [], unknown_topic_books: [],
      }
      if (['plugin.topic_assign', 'plugin.topic_save', 'plugin.book_assets_start'].includes(method)) return persist(method, params)
      if (method === 'plugin.ai_read_start') return { job_id: 10 }
      if (method === 'plugin.import_start') return { job_id: 30 }
      return {}
    })
    window.notemd = {
      pluginId: 'notemd.ebook-import', locale: 'zh', theme: 'light', request,
      onMessage: (callback) => { push = callback },
    } satisfies NotemdBridge
    app = mount(App, { target: document.body })
    return { state, request, sendEvent: (payload: unknown) => push?.(payload) }
  }

  it('keeps a successful summary available while showing an index-update warning', async () => {
    const { request, sendEvent } = topicFixture(async () => ({}))
    const read = await vi.waitFor(() => {
      const button = [...document.querySelectorAll<HTMLButtonElement>('.library button')].find(
        (candidate) => candidate.textContent?.trim() === 'AI 先读',
      )
      expect(button).toBeDefined()
      return button!
    })
    read.click()
    await tick()
    sendEvent({
      type: 'ai_read', job_id: 10, event: 'done',
      summary_rel: 'ebooks/2026-09/Example/2026-09-10-summary.md',
      index_warning: 'Cannot write engineering.index.md',
    })
    const summary = await vi.waitFor(() => {
      const button = [...document.querySelectorAll<HTMLButtonElement>('.library button')].find(
        (candidate) => candidate.textContent?.trim() === '2026-09-10 摘要',
      )
      expect(button).toBeDefined()
      return button!
    })
    expect(document.querySelector('[role="status"]')?.textContent).toContain('摘要已生成，但书籍索引更新失败')
    expect(document.querySelector('[role="status"]')?.textContent).toContain('Cannot write engineering.index.md')
    expect(document.querySelector('.library')?.textContent).not.toContain('AI 阅读失败')
    summary.click()
    await tick()
    expect(request).toHaveBeenCalledWith('host.editor.open', { path: 'ebooks/2026-09/Example/2026-09-10-summary.md' })
  })

  async function assetsButton() {
    return vi.waitFor(() => {
      const button = [...document.querySelectorAll<HTMLButtonElement>('.library button')].find(
        (candidate) => candidate.textContent?.trim() === '补全书目与封面',
      )
      expect(button).toBeDefined()
      return button!
    })
  }

  it('shows the book-assets stage during an import without reporting completion', async () => {
    const { request, sendEvent } = topicFixture(async () => ({}))
    await assetsButton()
    sendEvent({ type: 'drag-drop', phase: 'drop', paths: ['/tmp/Example.epub'] })
    await tick()
    const start = document.querySelector<HTMLButtonElement>('.queue button.start')!
    expect(start.disabled).toBe(false)
    start.click()
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('plugin.import_start', expect.any(Object)))
    sendEvent({ type: 'job', job_id: 30, event: 'progress', stage: 'book_assets' })
    await tick()
    expect(document.querySelector('.queue .stage')?.textContent).toBe('查找书目与封面中')
    expect(document.querySelector('.queue .badge')?.classList.contains('running')).toBe(true)
  })

  it('waits for a matching asset completion event and refreshes the library after the job finishes', async () => {
    const { request, sendEvent } = topicFixture(async () => ({ job_id: 21 }))
    const complete = await assetsButton()
    const libraryReads = request.mock.calls.filter(([method]) => method === 'plugin.library_list').length
    const topicReads = request.mock.calls.filter(([method]) => method === 'plugin.topic_state').length
    complete.click()
    complete.click()
    await tick()
    expect(request.mock.calls.filter(([method]) => method === 'plugin.book_assets_start')).toEqual([
      ['plugin.book_assets_start', { book: 'ebooks/2026-09/Example' }],
    ])
    expect(complete.disabled).toBe(true)
    expect(complete.textContent).toContain('正在查找')
    expect(document.querySelector<HTMLSelectElement>('.library .row select')?.disabled).toBe(false)
    expect(document.querySelector('.library')?.textContent).toContain('AI 先读')
    sendEvent({ type: 'book_assets', job_id: 20, book: 'ebooks/2026-09/Example', status: 'done', matched: true, cover: true })
    await tick()
    expect(complete.disabled).toBe(true)
    expect(request.mock.calls.filter(([method]) => method === 'plugin.library_list')).toHaveLength(libraryReads)
    sendEvent({ type: 'book_assets', job_id: 21, book: 'ebooks/2026-09/Example', status: 'done', matched: true, cover: true })
    await vi.waitFor(() => expect(complete.disabled).toBe(false))
    expect(document.querySelector('.library [role="status"]')?.textContent).toContain('书目信息与封面已更新')
    expect(request.mock.calls.filter(([method]) => method === 'plugin.library_list')).toHaveLength(libraryReads + 1)
    expect(request.mock.calls.filter(([method]) => method === 'plugin.topic_state')).toHaveLength(topicReads + 1)
  })

  it.each([
    { matched: false, cover: false, text: '未找到匹配书籍' },
    { matched: true, cover: false, text: '封面暂不可用' },
    { matched: true, cover: true, text: '书目信息与封面已更新' },
  ])('handles asset completion before its start response ($text)', async ({ matched, cover, text }) => {
    const starting = deferred<{ job_id: number }>()
    const { sendEvent } = topicFixture(() => starting.promise)
    const complete = await assetsButton()
    complete.click()
    sendEvent({ type: 'book_assets', job_id: 22, book: 'ebooks/2026-09/Example', status: 'done', matched, cover, index_warning: 'Index is read-only' })
    await tick()
    expect(complete.disabled).toBe(true)
    expect(document.querySelector('.library [role="status"]')).toBeNull()
    starting.resolve({ job_id: 22 })
    await vi.waitFor(() => expect(complete.disabled).toBe(false))
    expect(document.querySelector('.library')?.textContent).toContain(text)
    expect(document.querySelector('.library')?.textContent).toContain('Index is read-only')
  })

  it.each(['request', 'push'])('allows retry after an asset %s failure', async (failure) => {
    const { request, sendEvent } = topicFixture(async () => {
      if (failure === 'request') throw new Error('Book service unavailable')
      return { job_id: 23 }
    })
    const complete = await assetsButton()
    complete.click()
    await tick()
    if (failure === 'push') sendEvent({ type: 'book_assets', job_id: 23, book: 'ebooks/2026-09/Example', status: 'failed', error: 'Book service unavailable' })
    await vi.waitFor(() => expect(complete.disabled).toBe(false))
    expect(document.querySelector('.library [role="alert"]')?.textContent).toContain('Book service unavailable')
    expect(document.querySelector('.library')?.textContent).not.toContain('书目信息与封面已更新')
    complete.click()
    await tick()
    expect(request.mock.calls.filter(([method]) => method === 'plugin.book_assets_start')).toHaveLength(2)
  })

  it('shows a cover-download warning separately from index failures after metadata succeeds', async () => {
    const { sendEvent } = topicFixture(async () => ({ job_id: 24 }))
    const complete = await assetsButton()
    complete.click()
    await tick()
    sendEvent({
      type: 'book_assets', job_id: 24, book: 'ebooks/2026-09/Example',
      status: 'done', matched: true, cover: false, asset_warning: 'Cover service timed out',
    })
    await vi.waitFor(() => expect(complete.disabled).toBe(false))
    expect(document.querySelector('.library')?.textContent).toContain('书目信息已更新，但封面下载失败')
    expect(document.querySelector('.library')?.textContent).toContain('Cover service timed out')
    expect(document.querySelector('.library')?.textContent).not.toContain('索引刷新失败')
    expect(document.querySelector('.library [role="alert"]')).toBeNull()
  })

  it.each([true, false])('keeps a single-book topic pending until the index transaction finishes (success=%s)', async (success) => {
    const rebuilding = deferred<{ ok: boolean }>()
    const { state, request } = topicFixture(() => rebuilding.promise)
    const select = await vi.waitFor(() => {
      const element = document.querySelector<HTMLSelectElement>('.library .row select')
      expect(element?.value).toBe('engineering')
      return element!
    })
    const stateReads = request.mock.calls.filter(([method]) => method === 'plugin.topic_state').length
    const libraryReads = request.mock.calls.filter(([method]) => method === 'plugin.library_list').length
    select.value = 'business'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    // An event arriving in the same tick must not start a second transaction.
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await tick()
    expect(request.mock.calls.filter(([method]) => method === 'plugin.topic_assign')).toEqual([
      ['plugin.topic_assign', { book: 'ebooks/2026-09/Example', topic_id: 'business' }],
    ])
    expect(select.disabled).toBe(true)
    expect(select.value).toBe('business')
    expect(request.mock.calls.filter(([method]) => method === 'plugin.topic_state')).toHaveLength(stateReads)
    expect(request.mock.calls.filter(([method]) => method === 'plugin.library_list')).toHaveLength(libraryReads)
    if (success) {
      state.topicId = 'business'
      rebuilding.resolve({ ok: true })
    } else {
      rebuilding.reject(new Error('Index transaction failed'))
    }
    await vi.waitFor(() => expect(select.disabled).toBe(false))
    expect(select.value).toBe(success ? 'business' : 'engineering')
    expect(request.mock.calls.filter(([method]) => method === 'plugin.topic_state')).toHaveLength(stateReads + (success ? 1 : 0))
    expect(request.mock.calls.filter(([method]) => method === 'plugin.library_list')).toHaveLength(libraryReads + (success ? 1 : 0))
    if (!success) expect(document.body.textContent).toContain('Index transaction failed')
  })

  it('refreshes renamed categories only after saving and rebuilding their indices', async () => {
    const rebuilding = deferred<{ ok: boolean }>()
    const { state, request } = topicFixture(() => rebuilding.promise)
    await vi.waitFor(() => expect(document.querySelector('.library .row select')).not.toBeNull())
    const manage = await vi.waitFor(() => {
      const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
        (candidate) => candidate.textContent?.trim() === '管理主题',
      )
      expect(button).toBeDefined()
      return button!
    })
    manage.click()
    await tick()
    const inputs = [...document.querySelectorAll<HTMLInputElement>('[role="dialog"] input')]
    const label = inputs.find((input) => input.value === 'engineering' && !input.disabled)!
    expect(label).toBeDefined()
    label.value = '工程实践'
    label.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
    const save = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
      (button) => button.textContent?.trim() === '保存',
    )!
    expect(save?.disabled).toBe(false)
    const stateReads = request.mock.calls.filter(([method]) => method === 'plugin.topic_state').length
    const libraryReads = request.mock.calls.filter(([method]) => method === 'plugin.library_list').length
    save.click()
    await tick()
    const writes = request.mock.calls.filter(([method]) => method === 'plugin.topic_save')
    expect(writes).toHaveLength(1)
    expect(writes[0][1].catalog.topics[0].label).toBe('工程实践')
    expect(writes[0][1].expected_revision).toBe('r1')
    expect(save.disabled).toBe(true)
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    expect(request.mock.calls.filter(([method]) => method === 'plugin.topic_state')).toHaveLength(stateReads)
    expect(request.mock.calls.filter(([method]) => method === 'plugin.library_list')).toHaveLength(libraryReads)
    state.topics = writes[0][1].catalog.topics
    rebuilding.resolve({ ok: true })
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull())
    expect(request.mock.calls.filter(([method]) => method === 'plugin.topic_state')).toHaveLength(stateReads + 1)
    expect(request.mock.calls.filter(([method]) => method === 'plugin.library_list')).toHaveLength(libraryReads + 1)
    expect(document.querySelector('.library .row select')?.textContent).toContain('工程实践')
  })
})
