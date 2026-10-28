// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'
import KickoffSheet from './KickoffSheet.svelte'
import KickoffConsent from './KickoffConsent.svelte'
import payload from '../lib/kickoff/__fixtures__/payload.json'
import { buildKickoffDocument, parseKickoffDocument, withAnswers, type KickoffDoc } from '../lib/kickoff/document'
import type { KickoffPayload } from '../lib/kickoff/payload'
import { setLocale } from '../lib/strings'
const components: ReturnType<typeof mount>[] = []
afterEach(() => {
  components.splice(0).forEach((component) => unmount(component))
  document.body.innerHTML = ''
})
const doc = { metadata: { created: '2026-10-27T10:00:00Z' }, kickoff: { run_id: 'run1', harness: 'Codex', duration_seconds: 62, payload: { ...payload, context: [{ claim: 'A guess', kind: 'inference', unverified: true, source_ids: ['s1'] }] }, answers: [], prior_answers: [] } } as unknown as KickoffDoc
function render(resultDoc = doc) {
  setLocale('en')
  const props = { title: 'Ship', result: { path: 'inbox/tasks/test.kickoff.md', doc: resultDoc }, stale: true, saving: false, onSave: vi.fn(async () => {}), onRegenerate: vi.fn(), onOpen: vi.fn(), onClose: vi.fn() }
  components.push(mount(KickoffSheet, { target: document.body, props }))
  flushSync()
  return props
}
describe('KickoffSheet', () => {
  it('serializes answers selected in the real UI with the established human:owner actor', async () => {
    setLocale('en')
    const raw = await buildKickoffDocument({
      payload: payload as KickoffPayload, taskPath: 'inbox/tasks/test-task.md', taskTitle: 'Ship',
      runId: 'run1', endedAt: '2026-10-27T10:00:00Z', durationSeconds: 62, providerId: 'codex',
    })
    const document = parseKickoffDocument(raw)!
    let serialized = ''
    components.push(mount(KickoffSheet, { target: window.document.body, props: {
      title: 'Ship', result: { path: 'inbox/tasks/test-task.kickoff.md', doc: document },
      onSave: async (answers) => { serialized = (await withAnswers(document, answers, '2026-10-27T10:01:00Z')).content },
      onRegenerate: vi.fn(), onOpen: vi.fn(), onClose: vi.fn(),
    } }))
    flushSync()
    window.document.querySelector<HTMLInputElement>('input[value="a"]')!.click()
    flushSync()
    const save = [...window.document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Save answers only')!
    save.click()
    await vi.waitFor(() => expect(serialized).not.toBe(''))
    expect(parseKickoffDocument(serialized)!.kickoff.answers[0].by).toBe('human:owner')
  })
  it('renders ordered sections, stale banner and evidence labels', () => {
    render()
    expect([...document.querySelectorAll('h3')].map((h) => h.textContent)).toEqual(['✦ Summary', '✦ Your answers', '✦ Known context', '✦ Suggestions', '✦ Not found'])
    expect(document.body.textContent).toContain('older version')
    expect(document.body.textContent).toContain('Inference')
    expect(document.body.textContent).toContain('Source missing')
    expect(document.body.textContent).toContain('1:02')
    expect(document.querySelector<HTMLButtonElement>('[data-kickoff-place]')?.disabled).toBe(true)
  })
  it('shows the real web host and complete destination independently of the source title', () => {
    const resource = 'https://research.example/article?topic=next'
    const props = render({ ...doc, kickoff: { ...doc.kickoff, payload: { ...doc.kickoff.payload,
      sources: [{ ...doc.kickoff.payload.sources[0], title: '<b>Official source</b>', resource }],
    } } })
    const source = document.querySelector<HTMLButtonElement>('[data-source="s1"]')!
    expect(source.textContent).toContain('research.example')
    expect(source.title).toContain(resource)
    expect(source.querySelector('b')).toBeNull()
    source.click()
    expect(props.onOpen).toHaveBeenCalledWith(resource)
  })
  it.each(['javascript:alert(1)', 'https://user:secret@example.com/a', '//example.com/a'])('disables an unsafe persisted source: %s', (resource) => {
    const props = render({ ...doc, kickoff: { ...doc.kickoff, payload: { ...doc.kickoff.payload,
      sources: [{ ...doc.kickoff.payload.sources[0], resource }],
    } } })
    const source = document.querySelector<HTMLButtonElement>('[data-source="s1"]')!
    expect(source.disabled).toBe(true)
    source.click()
    expect(props.onOpen).not.toHaveBeenCalled()
  })
  it('collects mutually exclusive selected and free text answers and opens sources', async () => {
    const props = render()
    document.querySelector<HTMLInputElement>('input[value="a"]')!.click()
    flushSync()
    expect(document.querySelector<HTMLButtonElement>('[data-kickoff-place]')?.disabled).toBe(false)
    document.querySelector<HTMLButtonElement>('[data-source="s1"]')!.click()
    expect(props.onOpen).toHaveBeenCalledWith('diary/release.note.md')
    const other = document.querySelector<HTMLInputElement>('input[value="other"]')!
    other.click()
    const field = document.querySelector<HTMLInputElement>('[data-free-text="q1"]')!
    field.value = 'My next step'
    field.dispatchEvent(new InputEvent('input', { bubbles: true }))
    flushSync()
    document.querySelector<HTMLButtonElement>('[data-kickoff-place]')!.click()
    expect(props.onSave).toHaveBeenCalledWith([expect.objectContaining({ question_id: 'q1', option_id: null, answer: 'My next step' })], true)
  })
})
describe('KickoffConsent', () => {
  it('cancel does not trigger confirmation or any write', () => {
    setLocale('en')
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    components.push(mount(KickoffConsent, { target: document.body, props: { onConfirm, onCancel, onChoose: vi.fn(), preview: { id: 'p1', taskId: 't1', providerId: 'codex', providerName: 'Codex', recipient: 'OpenAI', vaultRoot: '/vault', taskPath: 'task.md', needsConsent: true, dataSources: [] } } }))
    flushSync()
    document.querySelector<HTMLButtonElement>('[data-consent-cancel]')!.click()
    expect(onConfirm).not.toHaveBeenCalled()
    expect(onCancel).toHaveBeenCalledOnce()
    document.querySelector<HTMLButtonElement>('[data-consent-confirm]')!.click()
    expect(onConfirm).toHaveBeenCalledOnce()
  })
})
