import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, unmount } from 'svelte'
import App from './App.svelte'
import type { Dictionary, Snapshot } from './lib/types'

const dictionary: Dictionary = {
  schema: 'notemd.conversation-dictionary.v1', dictionary_id: 'dict_1', revision: 1,
  updated_at: '2026-09-20T00:00:00Z', subject_id: 'human:bruce', scope: 'user_communications',
  domains: [], entries: [], rules: [],
}

function snapshot(): Snapshot {
  return {
    settings: { schema: 'notemd.conversation-dictionary-settings.v1', dictionary_path: 'ssot/meetings/conversation-dictionary.yml' },
    status: { status: 'ready' }, dictionary: structuredClone(dictionary), candidates: [],
    formal_name_migration: { required: false, expected_revision: 1, expected_sha256: 'a'.repeat(64), entries: [], issues: [] },
    agent_integration: { status: 'ready', agents_path: 'AGENTS.md', agents_ready: true, skill_path: '.agents/skills/build-conversation-dictionary', skill_ready: true },
    example: { schema: 'notemd.conversation-dictionary-example.v1', example_only: true, description: 'Teaching example', domain: { id: 'example_product_conversation', name: '示例：产品沟通' }, entry: { id: 'example_notemd', kind: 'product', label: 'note.md', forms: ['note.md', 'NoteMD', '小记'] }, rule: { domain_id: 'example_product_conversation', observed: 'note MD', action: 'replace', target: { entry_id: 'example_notemd', text: 'note.md' }, application: 'suggest', enabled: false } },
    batches: [{
      run_id: '853f8a64-51d4-4dc8-8a97-8bd6d98784a3', dataset_sha256: 'a'.repeat(64), imported_at: '2026-09-20T00:00:00Z',
      dataset: { state: 'completed', coverage: { discovered: 2, processed: 2, excluded: 0, unknown_scope: 0, failed: 0, pending: 0, chunks_planned: 2, chunks_processed: 2 }, conflicts: [], unresolved: [], proposals: [
        { id: 'p_domain', kind: 'create_domain', depends_on: [], value: { name: '产品团队', description: '产品沟通' }, evidence_ids: [], reason: '' },
        { id: 'p_entry', kind: 'create_entry', depends_on: [], value: { kind: 'person', label: '伟滔', forms: ['伟滔'], description: '' }, evidence_ids: ['ev_1'], reason: '两份沟通指向相同写法' },
        { id: 'p_rule', kind: 'create_rule', depends_on: ['p_domain', 'p_entry'], value: { domain_ref: { proposal_id: 'p_domain' }, observed: '伟涛', action: 'replace', target: { entry_ref: { proposal_id: 'p_entry' }, text: '伟滔' }, application: 'suggest' }, evidence_ids: ['ev_1', 'ev_2'], reason: '疑似 ASR 误识别' },
      ] },
      proposal_states: { p_domain: { revision: 1, status: 'pending' }, p_entry: { revision: 1, status: 'pending' }, p_rule: { revision: 1, status: 'pending' } },
    }],
  } as Snapshot
}

let mounted: ReturnType<typeof mount> | undefined
afterEach(() => { if (mounted) unmount(mounted); mounted = undefined; document.body.innerHTML = ''; vi.restoreAllMocks() })

async function openTab(host: HTMLElement, label: string) {
  let button: HTMLButtonElement | undefined
  await vi.waitFor(() => {
    button = [...host.querySelectorAll<HTMLButtonElement>('.tabs button')].find((item) => item.textContent?.includes(label))
    expect(button).toBeDefined()
  })
  button!.click()
}

describe('Conversation Transcript Corrections window', () => {
  it('renders a dataset as grouped proposals and commits selected dependencies only through plugin.batch_commit', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'plugin.initialize') return { status: 'existing', dictionary_created: false }
      if (method === 'plugin.bootstrap') return snapshot()
      if (method === 'plugin.batch_commit') return { status: 'committed', revision: 2 }
      if (method === 'plugin.batch_evidence') return { evidence: [{ id: 'ev_1', source_id: 'src_1', resource: 'ssot/meetings/a/transcript.srt', excerpt: '请伟涛负责发布。', communication: { basis: { detail: '用户确认参与会议' } } }] }
      if (method === 'host.toast') return {}
      throw new Error(`unexpected ${method}`)
    })
    window.notemd = { pluginId: 'notemd.conversation-dictionary', locale: 'zh', theme: 'light', request, onMessage: () => {} }
    const host = document.createElement('div'); document.body.append(host); mounted = mount(App, { target: host })
    await openTab(host, '待确认')
    await vi.waitFor(() => expect([...host.querySelectorAll<HTMLInputElement>('input')].some((input) => input.value === '伟涛')).toBe(true))
    expect(host.textContent).toContain('产品团队 · p_domain')
    expect(host.textContent).toContain('伟滔 · p_entry')
    const evidenceButton = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('查看证据'))!
    evidenceButton.click()
    await vi.waitFor(() => expect(host.textContent).toContain('请伟涛负责发布。'))
    expect(request).toHaveBeenCalledWith('plugin.batch_evidence', expect.objectContaining({ proposal_id: 'p_entry' }))
    const selectAll = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('全选'))!
    const invert = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('反选'))!
    const approve = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('审批通过并加入勘误表'))!
    selectAll.click()
    await vi.waitFor(() => expect([...host.querySelectorAll<HTMLInputElement>('input[type=checkbox]')].every((input) => input.checked)).toBe(true))
    expect(approve.disabled).toBe(false)
    invert.click()
    await vi.waitFor(() => expect([...host.querySelectorAll<HTMLInputElement>('input[type=checkbox]')].every((input) => !input.checked)).toBe(true))
    expect(approve.disabled).toBe(true)
    const checkbox = host.querySelectorAll<HTMLInputElement>('input[type=checkbox]')[2]
    checkbox.click()
    await vi.waitFor(() => expect(approve.disabled).toBe(false))
    approve.click()
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('plugin.batch_commit', expect.objectContaining({
      run_id: '853f8a64-51d4-4dc8-8a97-8bd6d98784a3',
      expected_dictionary_revision: 1,
      expected_dictionary_sha256: 'a'.repeat(64),
      selected: expect.arrayContaining([expect.objectContaining({ id: 'p_domain' }), expect.objectContaining({ id: 'p_entry' }), expect.objectContaining({ id: 'p_rule' })]),
    })))
    expect(request.mock.calls.some(([method]) => method.includes('approve'))).toBe(false)
  })

  it('keeps edits and evidence isolated by dataset run', async () => {
    const data = snapshot()
    const second = structuredClone(data.batches[0])
    second.run_id = '11111111-2222-4333-8444-555555555555'
    second.dataset_sha256 = 'b'.repeat(64)
    second.dataset.proposals[1].value.label = '李雷'
    second.dataset.proposals[1].value.forms = ['李雷']
    second.dataset.proposals[2].value.observed = '李磊'
    second.dataset.proposals[2].value.target!.text = '李雷'
    data.batches.push(second)
    const request = vi.fn(async (method: string, params: any) => {
      if (method === 'plugin.initialize') return { status: 'existing', dictionary_created: false }
      if (method === 'plugin.bootstrap') return data
      if (method === 'plugin.batch_evidence') return { evidence: [{ id: 'ev_1', excerpt: params.run_id.startsWith('853f') ? '第一批证据' : '第二批证据' }] }
      throw new Error(`unexpected ${method}`)
    })
    window.notemd = { pluginId: 'notemd.conversation-dictionary', locale: 'zh', theme: 'light', request, onMessage: () => {} }
    const host = document.createElement('div'); document.body.append(host); mounted = mount(App, { target: host })
    await openTab(host, '待确认')
    await vi.waitFor(() => expect(host.textContent).toContain('伟滔 · p_entry'))
    const firstLabel = [...host.querySelectorAll<HTMLInputElement>('input')].find((input) => input.value === '伟滔')!
    firstLabel.value = '第一批已编辑'; firstLabel.dispatchEvent(new InputEvent('input', { bubbles: true }))
    const firstEvidence = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('查看证据'))!
    firstEvidence.click()
    await vi.waitFor(() => expect(host.textContent).toContain('第一批证据'))
    host.querySelectorAll<HTMLButtonElement>('.batch-list button')[1].click()
    await vi.waitFor(() => expect([...host.querySelectorAll<HTMLInputElement>('input')].some((input) => input.value === '李雷')).toBe(true))
    expect(host.textContent).not.toContain('第一批证据')
    const secondEvidence = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('查看证据'))!
    secondEvidence.click()
    await vi.waitFor(() => expect(host.textContent).toContain('第二批证据'))
  })

  it('blocks only selections that include proposals tied to unresolved conflicts', async () => {
    const data = snapshot()
    data.batches[0].dataset.conflicts = [{ id: 'conflict_1', proposal_ids: ['p_rule'] }] as any
    const request = vi.fn(async (method: string) => {
      if (method === 'plugin.initialize') return { status: 'existing', dictionary_created: false }
      return method === 'plugin.bootstrap' ? data : {}
    })
    window.notemd = { pluginId: 'notemd.conversation-dictionary', locale: 'zh', theme: 'light', request, onMessage: () => {} }
    const host = document.createElement('div'); document.body.append(host); mounted = mount(App, { target: host })
    await openTab(host, '待确认')
    await vi.waitFor(() => expect(host.textContent).toContain('仍有需要单独处理的项目'))
    const checkboxes = host.querySelectorAll<HTMLInputElement>('input[type=checkbox]')
    const approve = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('审批通过并加入勘误表'))!
    checkboxes[1].click()
    await vi.waitFor(() => expect(approve.disabled).toBe(false))
    checkboxes[2].click()
    await vi.waitFor(() => expect(approve.disabled).toBe(true))
    expect(host.textContent).toContain('所选内容涉及 1 个未解决冲突')
    expect(request.mock.calls.some(([method]) => method === 'plugin.batch_commit')).toBe(false)
  })

  it('shows the import timestamp as the batch title and deletes a pending batch from its context menu', async () => {
    const data = snapshot()
    const request = vi.fn(async (method: string) => {
      if (method === 'plugin.initialize') return { status: 'existing', dictionary_created: false }
      if (method === 'plugin.bootstrap') return data
      if (method === 'plugin.batch_delete') { data.batches = []; return { status: 'deleted' } }
      if (method === 'host.toast') return {}
      throw new Error(`unexpected ${method}`)
    })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    window.notemd = { pluginId: 'notemd.conversation-dictionary', locale: 'zh', theme: 'light', request, onMessage: () => {} }
    const host = document.createElement('div'); document.body.append(host); mounted = mount(App, { target: host })
    await openTab(host, '待确认')
    await vi.waitFor(() => expect(host.querySelector('.batch-list strong')?.textContent).toMatch(/^2026-09-20 \d{2}:\d{2}$/))
    const batch = host.querySelector<HTMLButtonElement>('.batch-list button')!
    expect(batch.title).toBe('853f8a64-51d4-4dc8-8a97-8bd6d98784a3')
    batch.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 50 }))
    await vi.waitFor(() => expect(document.querySelector('.menu-panel')).not.toBeNull())
    const menu = document.querySelector<HTMLElement>('.menu-panel')!
    const remove = menu.querySelector<HTMLButtonElement>('.menu-row')!
    expect(remove.textContent).toContain('删除待审数据集')
    remove.click()
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('plugin.batch_delete', { run_id: '853f8a64-51d4-4dc8-8a97-8bd6d98784a3' }))
    await vi.waitFor(() => expect(host.textContent).toContain('暂无历史整理批次'))
  })

  it('initializes automatically and shows an inactive teaching example', async () => {
    const empty = snapshot(); empty.batches = []
    const request = vi.fn(async (method: string) => {
      if (method === 'plugin.initialize') return { status: 'created', dictionary_created: true }
      return method === 'plugin.bootstrap' ? empty : {}
    })
    window.notemd = { pluginId: 'notemd.conversation-dictionary', locale: 'zh-TW', theme: 'dark', request, onMessage: () => {} }
    const host = document.createElement('div'); document.body.append(host); mounted = mount(App, { target: host })
    await openTab(host, '待确认')
    await vi.waitFor(() => expect(host.textContent).toContain('样例 · 未启用'))
    expect(host.textContent).toContain('note MD')
    expect(host.textContent).toContain('不会参与转写')
    expect(request).toHaveBeenCalledWith('plugin.initialize', {})
    expect(request.mock.calls.some(([method]) => method === 'plugin.create_dictionary')).toBe(false)
  })

  it('does not offer to recreate a dictionary that failed its reviewed baseline check', async () => {
    const invalid = snapshot(); invalid.dictionary = null as any; invalid.batches = []
    invalid.status = { status: 'needs_review', error: 'dictionary changed outside the reviewed plugin transaction' } as any
    const request = vi.fn(async (method: string) => {
      if (method === 'plugin.initialize') throw new Error('dictionary changed outside the reviewed plugin transaction')
      if (method === 'plugin.bootstrap') return invalid
      if (method === 'plugin.open_dictionary') return { path: 'ssot/meetings/conversation-dictionary.yml' }
      if (method === 'host.editor.open') return {}
      throw new Error(`unexpected ${method}`)
    })
    window.notemd = { pluginId: 'notemd.conversation-dictionary', locale: 'zh-TW', theme: 'light', request, onMessage: () => {} }
    const host = document.createElement('div'); document.body.append(host); mounted = mount(App, { target: host })
    await vi.waitFor(() => expect(host.textContent).toContain('勘误词典需要检查'))
    expect(host.textContent).not.toContain('创建词典')
  })

  it('opens on the corrections dictionary and creates a context with one compact form', async () => {
    const data = snapshot(); data.batches = []
    const request = vi.fn(async (method: string) => {
      if (method === 'plugin.initialize') return { status: 'existing', dictionary_created: false }
      if (method === 'plugin.bootstrap') return data
      if (method === 'plugin.save_correction_entry') return { status: 'committed', revision: 2, domain_id: 'd_new', entry_id: 'e_new' }
      if (method === 'host.toast') return {}
      throw new Error(`unexpected ${method}`)
    })
    window.notemd = { pluginId: 'notemd.conversation-dictionary', locale: 'zh', theme: 'light', request, onMessage: () => {} }
    const host = document.createElement('div'); document.body.append(host); mounted = mount(App, { target: host })
    await vi.waitFor(() => expect(host.querySelector<HTMLButtonElement>('.tabs button')?.textContent).toContain('勘误词典'))
    expect(host.querySelector<HTMLButtonElement>('.tabs button')?.classList.contains('active')).toBe(true)
    let createContext: HTMLButtonElement | undefined
    await vi.waitFor(() => {
      createContext = [...host.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('新增场景'))
      expect(createContext).toBeDefined()
    })
    createContext!.click()
    await vi.waitFor(() => expect(host.textContent).toContain('保存第一个词条时会同时创建场景'))
    const inputs = [...host.querySelectorAll<HTMLInputElement>('.editor-column input')]
    inputs[0].value = '产品周会'; inputs[0].dispatchEvent(new InputEvent('input', { bubbles: true }))
    inputs[1].value = 'note.md'; inputs[1].dispatchEvent(new InputEvent('input', { bubbles: true }))
    inputs[2].value = 'NoteMD，小记; NOTE MD'; inputs[2].dispatchEvent(new InputEvent('input', { bubbles: true }))
    inputs[3].value = 'note MD；脑特MD'; inputs[3].dispatchEvent(new InputEvent('input', { bubbles: true }))
    const save = [...host.querySelectorAll<HTMLButtonElement>('.editor-actions button')].find((button) => button.textContent === '保存')!
    await vi.waitFor(() => expect(save.disabled).toBe(false))
    save.click()
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('plugin.save_correction_entry', expect.objectContaining({
      domain_id: null,
      domain_name: '产品周会',
      entry_id: null,
      formal_name: 'note.md',
      aliases: ['NoteMD', '小记', 'NOTE MD'],
      mistaken_forms: ['note MD', '脑特MD'],
    })))
  })

  it('switches entries by context and can delete a shared entry', async () => {
    const data = snapshot(); data.batches = []
    data.dictionary!.domains = [
      { id: 'd_work', name: '工作会议', description: '' },
      { id: 'd_private', name: '私聊', description: '' },
    ]
    data.dictionary!.entries = [
      { id: 'e_wei', kind: 'person', label: '伟滔', forms: ['伟滔', 'Bruce'], description: '' },
      { id: 'e_note', kind: 'product', label: 'note.md', forms: ['note.md', 'NoteMD'], description: '' },
    ]
    data.dictionary!.rules = [
      { id: 'r_work', domain_id: 'd_work', observed: '伟涛', action: 'replace', target: { entry_id: 'e_wei', text: '伟滔' }, application: 'suggest', enabled: true, confirmed_by: 'human:bruce', confirmed_at: '2026-09-20T00:00:00Z' },
      { id: 'r_private', domain_id: 'd_private', observed: 'Bruce', action: 'replace', target: { entry_id: 'e_wei', text: '伟滔' }, application: 'suggest', enabled: true, confirmed_by: 'human:bruce', confirmed_at: '2026-09-20T00:00:00Z' },
      { id: 'r_note', domain_id: 'd_private', observed: 'note MD', action: 'replace', target: { entry_id: 'e_note', text: 'note.md' }, application: 'suggest', enabled: true, confirmed_by: 'human:bruce', confirmed_at: '2026-09-20T00:00:00Z' },
    ]
    const request = vi.fn(async (method: string) => {
      if (method === 'plugin.initialize') return { status: 'existing', dictionary_created: false }
      if (method === 'plugin.bootstrap') return data
      if (method === 'plugin.delete_correction_entry') return { status: 'committed', revision: 2 }
      if (method === 'host.toast') return {}
      throw new Error(`unexpected ${method}`)
    })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    window.notemd = { pluginId: 'notemd.conversation-dictionary', locale: 'zh', theme: 'light', request, onMessage: () => {} }
    const host = document.createElement('div'); document.body.append(host); mounted = mount(App, { target: host })
    await vi.waitFor(() => expect(host.textContent).toContain('工作会议'))
    expect(host.textContent).not.toContain('note.md')
    ;[...host.querySelectorAll<HTMLButtonElement>('.context-column button')].find((button) => button.textContent?.includes('私聊'))!.click()
    await vi.waitFor(() => expect(host.textContent).toContain('note.md'))
    ;[...host.querySelectorAll<HTMLButtonElement>('.entry-column button')].find((button) => button.textContent?.includes('伟滔'))!.click()
    const remove = [...host.querySelectorAll<HTMLButtonElement>('.editor-actions button')].find((button) => button.textContent?.includes('从当前场景移除'))
    expect(remove).toBeDefined()
    const deleteButton = [...host.querySelectorAll<HTMLButtonElement>('.editor-actions button')].find((button) => button.textContent?.includes('删除词条'))!
    deleteButton.click()
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('plugin.delete_correction_entry', expect.objectContaining({
      domain_id: 'd_private', entry_id: 'e_wei', delete_globally: true,
    })))
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('2 个场景'))
  })

  function publicFixture() {
    const data = snapshot(); data.batches = []
    data.dictionary!.domains = [{ id: 'd_work', name: '工作会议', description: '' }]
    data.dictionary!.entries = [
      { id: 'e_source', kind: 'person', label: '小王', forms: ['小王'], description: '' },
      { id: 'e_target', kind: 'person', label: '王明', forms: ['王明', '老王'], description: '' },
    ]
    data.dictionary!.entry_domains = { e_target: ['d_work'] }
    return data
  }

  async function mountDictionary(data: Snapshot, mutation: (method: string, params: any) => any) {
    const request = vi.fn(async (method: string, params?: any) => {
      if (method === 'plugin.initialize') return { status: 'existing', dictionary_created: false }
      if (method === 'plugin.bootstrap') return structuredClone(data)
      if (method === 'host.toast') return {}
      return mutation(method, params)
    })
    window.notemd = { pluginId: 'notemd.conversation-dictionary', locale: 'zh', theme: 'light', request, onMessage: () => {} }
    const host = document.createElement('div'); document.body.append(host); mounted = mount(App, { target: host })
    await vi.waitFor(() => expect(host.querySelector('.entry-column')?.textContent).toContain('小王'))
    return { host, request }
  }

  function pointerEvent(type: string, x: number, y: number, pointerId = 1) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y })
    Object.defineProperties(event, { pointerId: { value: pointerId }, isPrimary: { value: true } })
    return event
  }

  function prepareDrag(host: HTMLElement) {
    const source = [...host.querySelectorAll<HTMLButtonElement>('.entry-column button')].find((button) => button.textContent?.includes('小王'))!
    const target = host.querySelector<HTMLButtonElement>('[data-drop-domain="d_work"]')!
    let captured = false
    Object.defineProperties(source, {
      setPointerCapture: { value: () => { captured = true }, configurable: true },
      hasPointerCapture: { value: () => captured, configurable: true },
      releasePointerCapture: { value: () => { captured = false }, configurable: true },
    })
    if (!document.elementFromPoint) Object.defineProperty(document, 'elementFromPoint', { value: () => null, configurable: true })
    const hit = vi.spyOn(document, 'elementFromPoint').mockReturnValue(target.querySelector('strong'))
    source.dispatchEvent(pointerEvent('pointerdown', 400, 300))
    return { source, target, hit }
  }

  function dragEntry(host: HTMLElement) {
    prepareDrag(host)
    window.dispatchEvent(pointerEvent('pointermove', 100, 300))
    window.dispatchEvent(pointerEvent('pointerup', 100, 300))
  }

  it('shows rule-free entries in public and saves a formal name without inventing corrections', async () => {
    const data = publicFixture()
    const { host, request } = await mountDictionary(data, (method) => {
      if (method === 'plugin.save_correction_entry') return { domain_id: 'public', entry_id: 'e_source' }
      throw new Error(method)
    })
    expect(host.querySelector('.context-column .selected')?.textContent).toContain('public（公共）')
    expect(host.querySelector('.entry-column')?.textContent).not.toContain('王明')
    const save = [...host.querySelectorAll<HTMLButtonElement>('.editor-actions button')].find((button) => button.textContent === '保存')!
    expect(save.disabled).toBe(false); save.click()
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('plugin.save_correction_entry', expect.objectContaining({ domain_id: 'public', formal_name: '小王', aliases: [], mistaken_forms: [] })))
  })

  it('moves an unassigned entry by drag and drop and selects the persisted target context', async () => {
    const data = publicFixture()
    const { host, request } = await mountDictionary(data, (method, params) => {
      if (method === 'plugin.move_correction_entry') { data.dictionary!.entry_domains!.e_source = [params.target_domain_id]; return {} }
      throw new Error(method)
    })
    dragEntry(host)
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('plugin.move_correction_entry', expect.objectContaining({ entry_id: 'e_source', source_domain_id: 'public', target_domain_id: 'd_work', expected_revision: 1, expected_sha256: 'a'.repeat(64) })))
    await vi.waitFor(() => expect(host.querySelector('.context-column .selected')?.textContent).toContain('工作会议'))
    expect(host.querySelector('.entry-column')?.textContent).toContain('小王')
    expect(host.querySelector('.entry-column')?.textContent).toContain('王明')
  })

  it('uses pointer events without native drag events and cancels on Escape, blur, scroll or pointer cancellation', async () => {
    const { host, request } = await mountDictionary(publicFixture(), () => ({}))
    for (const type of ['escape', 'blur', 'scroll', 'pointercancel', 'lostpointercapture']) {
      const { source } = prepareDrag(host)
      expect(source.draggable).toBe(false)
      window.dispatchEvent(pointerEvent('pointermove', 100, 300))
      await vi.waitFor(() => expect(host.querySelector('.drop-target')).not.toBeNull())
      if (type === 'escape') window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      else if (type === 'pointercancel') window.dispatchEvent(pointerEvent(type, 100, 300))
      else if (type === 'lostpointercapture') source.dispatchEvent(pointerEvent(type, 100, 300))
      else window.dispatchEvent(new Event(type))
      window.dispatchEvent(pointerEvent('pointerup', 100, 300))
      await vi.waitFor(() => expect(host.querySelector('.drop-target')).toBeNull())
      vi.restoreAllMocks()
    }
    expect(request.mock.calls.some(([method]) => method === 'plugin.move_correction_entry')).toBe(false)
  })

  it('does not move on a short press, wrong pointer, same context or invalid release point', async () => {
    const { host, request } = await mountDictionary(publicFixture(), () => ({}))
    let drag = prepareDrag(host)
    window.dispatchEvent(pointerEvent('pointermove', 398, 300))
    window.dispatchEvent(pointerEvent('pointerup', 398, 300))
    expect(host.querySelector('.drop-target')).toBeNull()
    drag = prepareDrag(host)
    window.dispatchEvent(pointerEvent('pointermove', 100, 300, 2))
    window.dispatchEvent(pointerEvent('pointerup', 100, 300, 2))
    window.dispatchEvent(new Event('blur'))
    drag = prepareDrag(host)
    window.dispatchEvent(pointerEvent('pointermove', 100, 300))
    await vi.waitFor(() => expect(host.querySelector('.drop-target')).not.toBeNull())
    drag.hit.mockReturnValue(null)
    window.dispatchEvent(pointerEvent('pointerup', 900, 900))
    drag = prepareDrag(host)
    drag.hit.mockReturnValue(host.querySelector('[data-drop-domain="public"]'))
    window.dispatchEvent(pointerEvent('pointermove', 100, 300))
    window.dispatchEvent(pointerEvent('pointerup', 100, 300))
    expect(request.mock.calls.some(([method]) => method === 'plugin.move_correction_entry')).toBe(false)
  })

  it('suppresses the click generated by a drag but permits the next independent click', async () => {
    const { host } = await mountDictionary(publicFixture(), () => ({}))
    const { source, target, hit } = prepareDrag(host)
    window.dispatchEvent(pointerEvent('pointermove', 100, 300))
    hit.mockReturnValue(null)
    window.dispatchEvent(pointerEvent('pointerup', 900, 900))
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 })
    source.dispatchEvent(click)
    expect(click.defaultPrevented).toBe(true)
    target.dispatchEvent(pointerEvent('pointerdown', 100, 300))
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
    await vi.waitFor(() => expect(host.querySelector('.context-column .selected')?.textContent).toContain('工作会议'))
  })

  it('retains the source context and draft when a move conflicts', async () => {
    const data = publicFixture()
    const { host } = await mountDictionary(data, () => { throw new Error('目标场景存在冲突') })
    dragEntry(host)
    await vi.waitFor(() => expect(host.textContent).toContain('目标场景存在冲突'))
    expect(host.querySelector('.context-column .selected')?.textContent).toContain('public（公共）')
    expect(host.querySelector<HTMLInputElement>('.editor-column input')?.value).toBe('小王')
  })

  it('does not move a dirty draft when the user cancels', async () => {
    const { host, request } = await mountDictionary(publicFixture(), () => ({}))
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    const input = host.querySelector<HTMLInputElement>('.editor-column input')!
    input.value = '未保存的称呼'; input.dispatchEvent(new Event('input', { bubbles: true }))
    await vi.waitFor(() => expect(input.value).toBe('未保存的称呼'))
    dragEntry(host)
    await vi.waitFor(() => expect(window.confirm).toHaveBeenCalled())
    expect(request.mock.calls.some(([method]) => method === 'plugin.move_correction_entry')).toBe(false)
    expect(input.value).toBe('未保存的称呼')
  })

  it('offers merge after Save, searches aliases and keeps the selected target after merging', async () => {
    const data = publicFixture()
    const { host, request } = await mountDictionary(data, (method) => {
      if (method === 'plugin.merge_correction_entries') {
        data.dictionary!.entries = data.dictionary!.entries.filter((entry) => entry.id !== 'e_source')
        data.dictionary!.entry_domains!.e_target = ['public', 'd_work']
        data.dictionary!.entries[0].forms.push('小王')
        return {}
      }
      throw new Error(method)
    })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const actions = [...host.querySelectorAll<HTMLButtonElement>('.editor-actions button')]
    expect(actions[0].textContent).toBe('保存'); expect(actions[1].textContent).toBe('合并到…'); actions[1].click()
    await vi.waitFor(() => expect(host.querySelector('.merge-panel')).not.toBeNull())
    const search = host.querySelector<HTMLInputElement>('.merge-panel input')!
    search.value = '老王'; search.dispatchEvent(new Event('input', { bubbles: true }))
    await vi.waitFor(() => expect(host.querySelector('.merge-panel select')?.textContent).toContain('王明'))
    expect(host.querySelector('.merge-panel select')?.textContent).not.toContain('小王')
    const select = host.querySelector<HTMLSelectElement>('.merge-panel select')!
    select.value = 'e_target'; select.dispatchEvent(new Event('change', { bubbles: true }))
    const confirm = host.querySelector<HTMLButtonElement>('.merge-actions .primary')!
    await vi.waitFor(() => expect(confirm.disabled).toBe(false)); confirm.click()
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('plugin.merge_correction_entries', expect.objectContaining({ source_entry_id: 'e_source', target_entry_id: 'e_target', expected_revision: 1 })))
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('涉及 2 个场景'))
    await vi.waitFor(() => expect(host.querySelector<HTMLInputElement>('.editor-column input')?.value).toBe('王明'))
    expect(host.querySelector('.entry-column')?.textContent).not.toContain('小王')
  })

  it('locks editing after a committed move cannot reload and recovers to the correct entry', async () => {
    const data = publicFixture()
    let committed = false
    let failReload = true
    const request = vi.fn(async (method: string, params?: any) => {
      if (method === 'plugin.initialize') return {}
      if (method === 'plugin.bootstrap') {
        if (committed && failReload) throw new Error('network unavailable')
        return structuredClone(data)
      }
      if (method === 'plugin.move_correction_entry') {
        committed = true; data.dictionary!.entry_domains!.e_source = [params.target_domain_id]; return {}
      }
      throw new Error(method)
    })
    window.notemd = { pluginId: 'notemd.conversation-dictionary', locale: 'zh', theme: 'light', request, onMessage: () => {} }
    const host = document.createElement('div'); document.body.append(host); mounted = mount(App, { target: host })
    await vi.waitFor(() => expect(host.querySelector('.entry-column')?.textContent).toContain('小王'))
    dragEntry(host)
    await vi.waitFor(() => expect(host.textContent).toContain('更改已保存，但重新加载失败'))
    expect(host.querySelector<HTMLFieldSetElement>('.dictionary-fieldset')?.disabled).toBe(true)
    expect(host.querySelector('.context-column .selected')?.textContent).toContain('public（公共）')
    failReload = false
    ;[...host.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '重新加载')!.click()
    await vi.waitFor(() => expect(host.querySelector('.context-column .selected')?.textContent).toContain('工作会议'))
    expect(host.querySelector<HTMLFieldSetElement>('.dictionary-fieldset')?.disabled).toBe(false)
    expect(host.querySelector<HTMLInputElement>('.editor-column input')?.value).toBe('小王')
    expect(request.mock.calls.filter(([method]) => method === 'plugin.move_correction_entry')).toHaveLength(1)
  })

  it('retains the merge target and both entries after a merge conflict', async () => {
    const { host } = await mountDictionary(publicFixture(), () => { throw new Error('合并规则冲突') })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    ;[...host.querySelectorAll<HTMLButtonElement>('.editor-actions button')].find((button) => button.textContent === '合并到…')!.click()
    await vi.waitFor(() => expect(host.querySelector('.merge-panel')).not.toBeNull())
    const select = host.querySelector<HTMLSelectElement>('.merge-panel select')!
    select.value = 'e_target'; select.dispatchEvent(new Event('change', { bubbles: true }))
    const confirm = host.querySelector<HTMLButtonElement>('.merge-actions .primary')!
    await vi.waitFor(() => expect(confirm.disabled).toBe(false)); confirm.click()
    await vi.waitFor(() => expect(host.textContent).toContain('合并规则冲突'))
    expect(select.value).toBe('e_target')
    expect(host.querySelector<HTMLInputElement>('.editor-column input')?.value).toBe('小王')
    expect(host.querySelector('.merge-panel select')?.textContent).toContain('王明')
  })

  it('previews and submits one atomic formal-name migration', async () => {
    const data = snapshot()
    data.batches = []
    data.dictionary!.entries = [{ id: 'e_wei', kind: 'person', label: 'Bruce', forms: ['伟滔', 'Bruce', '滔哥'], description: '' }]
    data.dictionary!.rules = [
      { id: 'r_wei', domain_id: 'd_work', observed: '伟涛', action: 'replace', target: { entry_id: 'e_wei', text: '伟滔' }, application: 'automatic', enabled: true, confirmed_by: 'human:bruce', confirmed_at: '2026-09-20T00:00:00Z' },
      { id: 'r_duplicate', domain_id: 'd_work', observed: '伟涛', action: 'replace', target: { entry_id: 'e_wei', text: '滔哥' }, application: 'suggest', enabled: false, confirmed_by: 'human:bruce', confirmed_at: '2026-09-20T00:00:00Z' },
      { id: 'r_noop', domain_id: 'd_work', observed: 'Bruce', action: 'replace', target: { entry_id: 'e_wei', text: '伟滔' }, application: 'automatic', enabled: true, confirmed_by: 'human:bruce', confirmed_at: '2026-09-20T00:00:00Z' },
    ]
    data.formal_name_migration = {
      required: true,
      expected_revision: 1,
      expected_sha256: 'b'.repeat(64),
      entries: [{ id: 'e_wei', kind: 'person', formal_name: 'Bruce', aliases: ['伟滔', '滔哥'], formal_name_missing: false, affected_rules: [{ rule_id: 'r_wei', domain_id: 'd_work', observed: '伟涛', current_output: '伟滔', application: 'automatic', enabled: true }] }],
      issues: [{ kind: 'rule_output_is_not_formal_name' }],
    }
    const request = vi.fn(async (method: string) => {
      if (method === 'plugin.initialize') return { status: 'existing', dictionary_created: false }
      if (method === 'plugin.bootstrap') return data
      if (method === 'plugin.normalize_formal_names') return { status: 'committed', revision: 2 }
      if (method === 'host.toast') return {}
      throw new Error(`unexpected ${method}`)
    })
    window.notemd = { pluginId: 'notemd.conversation-dictionary', locale: 'zh', theme: 'light', request, onMessage: () => {} }
    const host = document.createElement('div'); document.body.append(host); mounted = mount(App, { target: host })
    await vi.waitFor(() => expect(host.textContent).toContain('确认正式名'))
    expect(host.textContent).toContain('伟滔 · 滔哥')
    expect(host.textContent).toContain('新增别称归一（只建议）')
    expect(host.textContent).toContain('移除无操作规则')
    expect(host.textContent).toContain('合并重复规则')
    const input = [...host.querySelectorAll<HTMLInputElement>('input')].find((item) => item.value === 'Bruce')!
    input.value = '伟滔'; input.dispatchEvent(new InputEvent('input', { bubbles: true }))
    const apply = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('统一为正式名'))!
    apply.click()
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('plugin.normalize_formal_names', expect.objectContaining({
      expected_revision: 1,
      expected_sha256: 'b'.repeat(64),
      formal_names: { e_wei: '伟滔' },
    })))
  })

  it('uses an accepted entry permanent id when previewing a remaining rule', async () => {
    const data = snapshot()
    data.dictionary!.entries = [{ id: 'e_saved', kind: 'person', label: '新正式名', forms: ['新正式名', '旧草稿名'], description: '' }]
    data.batches[0].dataset.proposals = data.batches[0].dataset.proposals.filter((proposal) => proposal.id !== 'p_domain')
    data.batches[0].dataset.proposals[1].depends_on = ['p_entry']
    data.batches[0].proposal_states = {
      p_entry: { revision: 2, status: 'accepted', permanent_id: 'e_saved', edited_value: { kind: 'person', label: '新正式名', forms: ['新正式名', '旧草稿名'] } },
      p_rule: { revision: 1, status: 'pending' },
    }
    const request = vi.fn(async (method: string) => {
      if (method === 'plugin.initialize') return { status: 'existing', dictionary_created: false }
      if (method === 'plugin.bootstrap') return data
      throw new Error(`unexpected ${method}`)
    })
    window.notemd = { pluginId: 'notemd.conversation-dictionary', locale: 'zh', theme: 'light', request, onMessage: () => {} }
    const host = document.createElement('div'); document.body.append(host); mounted = mount(App, { target: host })
    await openTab(host, '待确认')
    await vi.waitFor(() => expect(host.textContent).toContain('统一输出正式名'))
    expect(host.textContent).toContain('新正式名')
    expect(host.textContent).not.toContain('旧草稿名 · p_entry')
  })
})
