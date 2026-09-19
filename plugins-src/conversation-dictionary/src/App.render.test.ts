import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, unmount } from 'svelte'
import App from './App.svelte'

const dictionary = {
  schema: 'notemd.conversation-dictionary.v1', dictionary_id: 'dict_1', revision: 1,
  updated_at: '2026-09-20T00:00:00Z', subject_id: 'human:bruce', scope: 'user_communications',
  domains: [], entries: [], rules: [],
}

function snapshot() {
  return {
    settings: { schema: 'notemd.conversation-dictionary-settings.v1', dictionary_path: 'ssot/meetings/conversation-dictionary.yml' },
    status: { status: 'ready' }, dictionary, candidates: [],
    batches: [{
      run_id: '853f8a64-51d4-4dc8-8a97-8bd6d98784a3', dataset_sha256: 'a'.repeat(64), imported_at: '2026-09-20T00:00:00Z',
      dataset: { state: 'completed', coverage: { discovered: 2, processed: 2, excluded: 0, unknown_scope: 0, failed: 0, pending: 0, chunks_planned: 2, chunks_processed: 2 }, conflicts: [], unresolved: [], proposals: [
        { id: 'p_domain', kind: 'create_domain', depends_on: [], value: { name: '产品团队', description: '产品沟通' }, evidence_ids: [], reason: '' },
        { id: 'p_entry', kind: 'create_entry', depends_on: [], value: { kind: 'person', label: '伟滔', forms: ['伟滔'], description: '' }, evidence_ids: ['ev_1'], reason: '两份沟通指向相同写法' },
        { id: 'p_rule', kind: 'create_rule', depends_on: ['p_domain', 'p_entry'], value: { domain_ref: { proposal_id: 'p_domain' }, observed: '伟涛', action: 'replace', target: { entry_ref: { proposal_id: 'p_entry' }, text: '伟滔' }, application: 'suggest' }, evidence_ids: ['ev_1', 'ev_2'], reason: '疑似 ASR 误识别' },
      ] },
      proposal_states: { p_domain: { revision: 1, status: 'pending' }, p_entry: { revision: 1, status: 'pending' }, p_rule: { revision: 1, status: 'pending' } },
    }],
  }
}

let mounted: ReturnType<typeof mount> | undefined
afterEach(() => { if (mounted) unmount(mounted); mounted = undefined; document.body.innerHTML = '' })

describe('Conversation Dictionary window', () => {
  it('renders a dataset as grouped proposals and commits selected dependencies only through plugin.batch_commit', async () => {
    const request = vi.fn(async (method: string) => {
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
    const checkbox = host.querySelectorAll<HTMLInputElement>('input[type=checkbox]')[2]
    checkbox.click()
    const save = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('保存选中的更改'))!
    await vi.waitFor(() => expect(save.disabled).toBe(false))
    save.click()
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('plugin.batch_commit', expect.objectContaining({
      run_id: '853f8a64-51d4-4dc8-8a97-8bd6d98784a3',
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

  it('blocks committing a dataset that reports unresolved conflicts', async () => {
    const data = snapshot()
    data.batches[0].dataset.conflicts = [{ id: 'conflict_1', proposal_ids: ['p_rule'] }] as any
    const request = vi.fn(async (method: string) => method === 'plugin.bootstrap' ? data : {})
    window.notemd = { pluginId: 'notemd.conversation-dictionary', locale: 'zh', theme: 'light', request, onMessage: () => {} }
    const host = document.createElement('div'); document.body.append(host); mounted = mount(App, { target: host })
    await vi.waitFor(() => expect(host.textContent).toContain('仍有需要单独处理的项目'))
    const select = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('选择可处理项'))!
    select.click()
    const save = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('保存选中的更改'))!
    expect(save.disabled).toBe(true)
    expect(request.mock.calls.some(([method]) => method === 'plugin.batch_commit')).toBe(false)
  })

  it('uses the Chinese empty state and creates only through the trusted UI request', async () => {
    const empty = snapshot(); empty.dictionary = null as any; empty.batches = []
    empty.status = { status: 'not_created' }
    const request = vi.fn(async (method: string) => method === 'plugin.bootstrap' ? empty : {})
    window.notemd = { pluginId: 'notemd.conversation-dictionary', locale: 'zh-TW', theme: 'dark', request, onMessage: () => {} }
    const host = document.createElement('div'); document.body.append(host); mounted = mount(App, { target: host })
    await vi.waitFor(() => expect(host.textContent).toContain('创建你的沟通词典'))
    const subject = host.querySelector<HTMLInputElement>('input[placeholder="human:your-id"]')!
    subject.value = 'human:bruce'; subject.dispatchEvent(new InputEvent('input', { bubbles: true }))
    const button = [...host.querySelectorAll('button')].find((item) => item.textContent === '创建词典')!
    await vi.waitFor(() => expect(button.disabled).toBe(false))
    button.click()
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('plugin.create_dictionary', { subject_id: 'human:bruce' }))
  })

  it('does not offer to recreate a dictionary that failed its reviewed baseline check', async () => {
    const invalid = snapshot(); invalid.dictionary = null as any; invalid.batches = []
    invalid.status = { status: 'needs_review', error: 'dictionary changed outside the reviewed plugin transaction' } as any
    const request = vi.fn(async (method: string) => {
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
})
