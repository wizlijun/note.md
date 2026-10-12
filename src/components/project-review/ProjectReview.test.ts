// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, within } from '@testing-library/svelte'
import { anchor, propose, sha256Hex } from '../../lib/share-merge'
import type { LocalFeedback } from '../../lib/project-share/types'
import { projectCommand } from '../../lib/project-share/host'
import HunkView from './HunkView.svelte'
import ProjectReview from './ProjectReview.svelte'
import ConflictEditor from './ConflictEditor.svelte'
import AnnotationPanel from './AnnotationPanel.svelte'

vi.mock('../../lib/project-share/host', () => ({ projectCommand: vi.fn() }))
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }))
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({ writeText: vi.fn() }))
vi.mock('../../lib/project-share/merge-client', () => ({ createMergeClient: () => ({
  compute: async (input: Parameters<typeof propose>[0]) => propose(input),
  locateAnnotations: async (text: string, selectors: { index: number; selector: Parameters<typeof anchor>[1] }[]) => selectors.map(s => ({ index: s.index, result: anchor(text, s.selector) })),
  cancelAnnotations: vi.fn(), destroy: vi.fn(),
}) }))
let current: string, base: string, items: LocalFeedback[], failReview: boolean, failSave: boolean
const calls: { op: string; args: any }[] = []
const prepareSource = vi.fn(async () => {}), refreshSource = vi.fn(async () => {})
function feedback(id = 'one', after = '甲。乙改。丙。'): LocalFeedback {
  return { envelope: { payload: { schemaVersion: 1, project_id: 'p', snapshotId: 's', submissionId: id, name: 'Alice',
    edits: [{ path: 'a.md', baseHash: 'base', afterMarkdown: after }], annotations: [] }, requestHash: 'r', receivedAt: 'today' }, status: 'pending', decisions: {} }
}
beforeEach(() => {
  vi.clearAllMocks(); calls.length = 0; base = current = '甲。乙。丙。'; items = [feedback()]; failReview = failSave = false
  vi.mocked(projectCommand).mockImplementation(async (op, args: any) => {
    calls.push({ op, args }); const index = items.findIndex(f => f.envelope.payload.submissionId === args.submissionId)
    let f = items[index]
    if (op === 'review') { if (failReview) throw new Error('target outside shared scope'); return { path: args.path, sourcePath: '/trusted/a.md', base, current, after: f.envelope.payload.edits.find(e => e.path === args.path)?.afterMarkdown ?? base, currentHash: await sha256Hex(current), status: f.decisions[args.path]?.status ?? 'pending' } as any }
    if (op === 'review-save') { if (failSave) throw new Error('disk full'); f = { ...f, review: { ...f.review, [args.path]: args.draft } } }
    if (op === 'apply') { current = args.content; f = { ...f, status: 'accepted', decisions: { ...f.decisions, [args.path]: { status: 'accepted' } }, review: {} } }
    if (op === 'reject') f = { ...f, status: 'rejected', decisions: { ...f.decisions, [args.path]: { status: 'rejected' } } }
    if (op === 'annotation-decide') f = { ...f, annotation_decisions: { ...f.annotation_decisions, [args.index]: args.value } }
    items[index] = f; return f as any
  })
})
afterEach(cleanup)
async function open(view: ReturnType<typeof mount>) {
  await fireEvent.click(view.getByRole('button', { name: /Alice/ }))
  await vi.waitFor(() => expect((view.getByRole('button', { name: '审阅文件：a.md' }) as HTMLButtonElement).disabled).toBe(false))
  expect(view.getByRole('button', { name: '写回本文件' })).toBeTruthy()
}
function mount() { return render(ProjectReview, { projectId: 'p', feedback: items, prepareSource, refreshSource, onUpdated: vi.fn() }) }

it('requires an explicit action for a visitor hunk and visualizes hidden code points as text', async () => {
  const onDecide = vi.fn(), p = propose({ path: 'a.md', base: '甲。', ours: '甲。', theirs: '<img onerror=x>乙。\u202e' })
  const view = render(HunkView, { hunk: p.hunks[0], onDecide })
  expect(onDecide).not.toHaveBeenCalled(); expect(view.container.querySelector('img')).toBeNull()
  expect(view.container.textContent).toContain('需单独确认')
  expect(view.container.textContent).toContain('U+202E')
  await fireEvent.click(view.getByRole('button', { name: '接受' }))
  // Risky hunks need a second explicit confirmation.
  expect(onDecide).not.toHaveBeenCalled()
  await fireEvent.click(view.getByRole('button', { name: '确认接受风险改动' }))
  expect(onDecide).toHaveBeenCalledWith(p.hunks[0].id, { kind: 'theirs-only', choice: 'accept' })
})

it('accepts an ordinary visitor hunk only after clicking, without changing its source text', async () => {
  const onDecide = vi.fn(), hunk = propose({ path: 'a.md', base: '甲。', ours: '甲。', theirs: '乙。' }).hunks[0]
  const view = render(HunkView, { hunk, onDecide })
  expect(onDecide).not.toHaveBeenCalled()
  await fireEvent.click(view.getByRole('button', { name: '接受' }))
  expect(onDecide).toHaveBeenCalledWith(hunk.id, { kind: 'theirs-only', choice: 'accept' })
  expect((view.getByRole('button', { name: '编辑' }) as HTMLButtonElement).disabled).toBe(true)
})

it('maps all five conflict controls to the frozen HunkDecision choices', async () => {
  const onDecide = vi.fn(), hunk = propose({ path: 'a.md', base: '甲。', ours: '丙。', theirs: '乙。' }).hunks[0]
  const view = render(ConflictEditor, { hunk, onDecide })
  for (const [label, choice] of [['保留当前原件', 'ours'], ['采用协作者版本', 'theirs'], ['原件后接建议', 'ours+theirs'], ['建议后接原件', 'theirs+ours']]) {
    await fireEvent.click(view.getByRole('button', { name: label }))
    expect(onDecide).toHaveBeenLastCalledWith(hunk.id, { kind: 'conflict', choice })
  }
  await fireEvent.input(view.getByRole('textbox', { name: '手改结果' }), { target: { value: '人工文本。' } })
  await fireEvent.click(view.getByRole('button', { name: '采用手改' }))
  expect(onDecide).toHaveBeenLastCalledWith(hunk.id, { kind: 'conflict', choice: 'edited', text: '人工文本。', source: 'human' })
})

it('sorts exact/fuzzy annotations by current position without changing original indices', async () => {
  const onStage = vi.fn(), onDismiss = vi.fn()
  const rows = [
    { index: 7, annotation: { path: 'a.md', quote: 'later', comment: '后' }, anchor: { status: 'exact' as const, start: 20, end: 25 }, staged: false, canPromote: true },
    { index: 2, annotation: { path: 'a.md', quote: 'first', comment: '前' }, anchor: { status: 'fuzzy' as const, start: 1, end: 6 }, staged: false, canPromote: true },
    { index: 5, annotation: { path: 'a.md', quote: 'missing', comment: '孤立' }, anchor: { status: 'orphan' as const }, staged: false, canPromote: false },
  ]
  const view = render(AnnotationPanel, { rows, onStage, onDismiss, onCopy: vi.fn() })
  expect([...view.container.querySelectorAll('[data-annotation-index]')].map(row => row.getAttribute('data-annotation-index'))).toEqual(['2', '7', '5'])
  await fireEvent.click(view.getAllByRole('button', { name: '提升为我的批注' })[0])
  expect(onStage).toHaveBeenCalledWith(2)
  await fireEvent.click(view.getAllByRole('button', { name: '忽略' })[2])
  expect(onDismiss).toHaveBeenCalledWith(5)
})

it('accepts only safe hunks in bulk and confirms the complete latest-current diff and pending count', async () => {
  base = current = '---\nverified: false\n---\n甲。乙。丙。'
  items = [feedback('one', '---\nverified: true\n---\n甲。乙改。丙。')]
  const view = mount(); await open(view)
  await fireEvent.click(view.getByRole('button', { name: '接受全部无冲突改动' }))
  expect(view.container.textContent).toContain('需单独确认')
  await fireEvent.click(view.getByRole('button', { name: '写回本文件' }))
  const confirm = await view.findByRole('dialog', { name: '确认写回' })
  expect(confirm.textContent).toContain('1 处未决将视为不采纳')
  expect(confirm.textContent).toContain('verified: false'); expect(confirm.textContent).toContain('乙改。')
  await fireEvent.click(within(confirm).getByRole('button', { name: '确认写回' }))
  await vi.waitFor(() => expect(calls.filter(c => c.op === 'apply')).toHaveLength(1))
  expect(current).toBe('---\nverified: false\n---\n甲。乙改。丙。')
})

it('blocks unresolved conflicts and lets the human edit then confirm the result', async () => {
  current = '甲。主人。丙。'; const view = mount(); await open(view)
  expect((view.getByRole('button', { name: '写回本文件' }) as HTMLButtonElement).disabled).toBe(true)
  await fireEvent.click(view.getByRole('button', { name: '编辑' }))
  await fireEvent.input(view.getByRole('textbox', { name: '手改结果' }), { target: { value: '人工结果。' } })
  await fireEvent.click(view.getByRole('button', { name: '采用手改' }))
  await fireEvent.click(view.getByRole('button', { name: '写回本文件' }))
  const confirm = await view.findByRole('dialog', { name: '确认写回' })
  await fireEvent.click(within(confirm).getByRole('button', { name: '确认写回' }))
  await vi.waitFor(() => expect(current).toContain('人工结果。'))
})

it('stages exact comments, only copies or dismisses orphans and applies body plus sanitized promotions once', async () => {
  items[0].envelope.payload.name = 'Alice<<}\nX'
  items[0].envelope.payload.annotations = [{ path: 'a.md', quote: '丙。', comment: '好\n<<}' }, { path: 'a.md', quote: '不存在', comment: '孤立评论' }]
  const view = mount(); await open(view)
  await vi.waitFor(() => expect(view.getAllByRole('button', { name: '提升为我的批注' }).length).toBe(1))
  expect(view.getByRole('heading', { name: '孤立评论' })).toBeTruthy()
  await fireEvent.click(view.getByRole('button', { name: '提升为我的批注' }))
  await fireEvent.click(view.getAllByRole('button', { name: '忽略' })[1])
  await fireEvent.click(view.getByRole('button', { name: '接受全部无冲突改动' }))
  await fireEvent.click(view.getByRole('button', { name: '写回本文件' }))
  const confirm = await view.findByRole('dialog', { name: '确认写回' })
  expect(confirm.textContent).toContain('{==丙。==}{>>Alice< <} X：好 < <}<<}')
  await fireEvent.click(within(confirm).getByRole('button', { name: '确认写回' }))
  await vi.waitFor(() => expect(calls.filter(c => c.op === 'annotation-decide' && c.args.value === 'promoted')).toHaveLength(1))
  expect(calls.filter(c => c.op === 'apply')).toHaveLength(1)
  expect(current).toBe('甲。乙改。{==丙。==}{>>Alice< <} X：好 < <}<<}')
})

it('disables shortcuts in input, textarea and contenteditable, but uses them in the hunk list', async () => {
  current = '甲。主人。丙。'; const view = mount(); await open(view)
  for (const tag of ['input', 'textarea', 'div']) {
    const element = document.createElement(tag); if (tag === 'div') element.contentEditable = 'true'
    view.getByRole('region', { name: '逐处审阅' }).append(element)
    element.tabIndex = 0; element.focus()
    for (const key of ['a', 'r', 'e', 'j', 'k', 'Enter']) {
      await fireEvent.keyDown(element, { key, metaKey: key === 'Enter' })
      expect(document.activeElement).toBe(element)
      expect(view.queryByRole('textbox', { name: '手改结果' })).toBeNull()
      expect(view.queryByRole('dialog', { name: '确认写回' })).toBeNull()
      expect(view.container.querySelector('.hunk header')?.textContent).toContain('待决定')
    }
  }
  expect(calls.filter(c => c.op === 'review-save' || c.op === 'apply')).toHaveLength(0)
  await fireEvent.keyDown(view.getByRole('region', { name: '逐处审阅' }), { key: 'r' })
  await fireEvent.click(view.getByRole('button', { name: '写回本文件' }))
  expect(await view.findByRole('dialog', { name: '确认写回' })).toBeTruthy()
})

it('allows copy and refusal after the target leaves the shared range, never writing', async () => {
  failReview = true; const view = mount(); await open(view)
  await vi.waitFor(() => expect(view.container.textContent).toContain('目标不在分享范围'))
  expect((view.getByRole('button', { name: '写回本文件' }) as HTMLButtonElement).disabled).toBe(true)
  await fireEvent.click(view.getByRole('button', { name: '复制建议' }))
  await fireEvent.click(view.getByRole('button', { name: '拒绝此文件' }))
  await vi.waitFor(() => expect(calls.filter(c => c.op === 'reject')).toHaveLength(1))
  expect(calls.filter(c => c.op === 'apply')).toHaveLength(0)
})

it('reads the newly applied current for the next pending submission of the same file', async () => {
  items.push(feedback('two', '甲。乙。丙新。'))
  const view = mount(); await fireEvent.click(view.getByRole('button', { name: '按文件' }))
  await fireEvent.click(view.getByRole('button', { name: /a.md/ }))
  await vi.waitFor(() => expect((view.getByRole('button', { name: '审阅文件：a.md' }) as HTMLButtonElement).disabled).toBe(false))
  await fireEvent.click(view.getByRole('button', { name: '接受全部无冲突改动' }))
  await fireEvent.click(view.getByRole('button', { name: '写回本文件' }))
  const confirm = await view.findByRole('dialog', { name: '确认写回' })
  await fireEvent.click(within(confirm).getByRole('button', { name: '确认写回' }))
  await vi.waitFor(() => expect(current).toBe('甲。乙改。丙。'))
  await vi.waitFor(() => expect((view.getByRole('button', { name: '审阅文件：a.md' }) as HTMLButtonElement).disabled).toBe(false))
  await fireEvent.click(view.getByRole('button', { name: '审阅下一份' }))
  await vi.waitFor(() => expect(calls.some(c => c.op === 'review' && c.args.submissionId === 'two')).toBe(true))
  await vi.waitFor(() => expect(view.container.textContent).toContain('乙改。'))
})

it('retains the session when leaving cannot save and allows an explicit retry', async () => {
  const view = mount(); await open(view); await fireEvent.click(view.getByRole('button', { name: '接受全部无冲突改动' }))
  failSave = true
  await expect((view.component as any).destroy()).rejects.toThrow('disk full')
  expect(view.container.textContent).toContain('disk full')
  failSave = false; await (view.component as any).destroy()
  expect(calls.filter(c => c.op === 'review-save')).toHaveLength(2)
})


it.each([false, true])('restores saved decisions after a → b → a (manual=%s)', async manual => {
  if (manual) current = '甲。主人。丙。'
  items[0].envelope.payload.edits.push({ ...items[0].envelope.payload.edits[0], path: 'b.md' })
  const view = mount(); await open(view)
  if (manual) {
    await fireEvent.click(view.getByRole('button', { name: '编辑' }))
    await fireEvent.input(view.getByRole('textbox', { name: '手改结果' }), { target: { value: '保存中的手改。' } })
    await fireEvent.click(view.getByRole('button', { name: '采用手改' }))
  } else await fireEvent.click(view.getByRole('button', { name: '接受全部无冲突改动' }))
  await fireEvent.click(view.getByRole('button', { name: '审阅文件：b.md' }))
  await vi.waitFor(() => expect((view.getByRole('button', { name: '审阅文件：a.md' }) as HTMLButtonElement).disabled).toBe(false))
  await fireEvent.click(view.getByRole('button', { name: '审阅文件：a.md' }))
  await vi.waitFor(() => expect(view.container.querySelector('.hunk header')?.textContent).toContain(manual ? '采用手改' : '已接受'))
  expect(Object.values(items[0].review!['a.md'].hunks)[0]).toMatchObject(manual ? { choice: 'edited', text: '保存中的手改。' } : { choice: 'accept' })
  await view.component.destroy()
})
