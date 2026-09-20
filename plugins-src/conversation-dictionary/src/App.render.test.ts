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

describe('Conversation Dictionary window', () => {
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
    await vi.waitFor(() => expect([...host.querySelectorAll<HTMLInputElement>('input')].some((input) => input.value === '伟涛')).toBe(true))
    expect(host.textContent).toContain('产品团队 · p_domain')
    expect(host.textContent).toContain('伟滔 · p_entry')
    const evidenceButton = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('查看证据'))!
    evidenceButton.click()
    await vi.waitFor(() => expect(host.textContent).toContain('请伟涛负责发布。'))
    expect(request).toHaveBeenCalledWith('plugin.batch_evidence', expect.objectContaining({ proposal_id: 'p_entry' }))
    const selectAll = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('全选'))!
    const invert = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('反选'))!
    const approve = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('审批通过并写入正式词典'))!
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
    await vi.waitFor(() => expect(host.textContent).toContain('仍有需要单独处理的项目'))
    const checkboxes = host.querySelectorAll<HTMLInputElement>('input[type=checkbox]')
    const approve = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('审批通过并写入正式词典'))!
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
    await vi.waitFor(() => expect(host.textContent).toContain('词典需要检查'))
    expect(host.textContent).not.toContain('创建词典')
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
    await vi.waitFor(() => expect(host.textContent).toContain('统一输出正式名'))
    expect(host.textContent).toContain('新正式名')
    expect(host.textContent).not.toContain('旧草稿名 · p_entry')
  })
})
