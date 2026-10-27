// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'
import KickoffProgress from './KickoffProgress.svelte'
import { CATALOGS, setLocale, t, type MessageKey } from '../lib/strings'
const mounted: ReturnType<typeof mount>[] = []
afterEach(() => { mounted.splice(0).forEach((component) => unmount(component)); document.body.innerHTML = '' })
const kinds = ['agent-missing', 'start-error', 'timeout', 'error', 'cancelled', 'skipped', 'lost', 'missing-result', 'invalid-output', 'task-changed', 'provider-unavailable', 'consent-required', 'unsupported', 'ineligible', 'already-running', 'capacity', 'io-error', 'conflict']
describe('Kickoff failure details', () => {
  it.each(kinds)('localizes %s and offers appropriate recovery with old result', (kind) => {
    setLocale('en')
    const onPrevious = vi.fn()
    mounted.push(mount(KickoffProgress, { target: document.body, props: {
      title: 'Ship', input: { run: { run_id: 'r1', harness: 'codex', task_path: 'inbox/tasks/a-task.md', based_on: 'hash', requested_at: '', state: 'failed', failure: { kind, message: 'Diagnostic', warning: 'Credentials expired', rawSnippet: 'a'.repeat(3000), at: '' } } },
      hasPrevious: true, onClose: vi.fn(), onRetry: vi.fn(), onChoose: vi.fn(), onPrevious,
    } }))
    flushSync()
    expect(document.body.textContent).toContain(CATALOGS.en[`kickoff.failure.${kind}` as MessageKey])
    expect(document.body.textContent).toContain('Credentials expired')
    expect(new TextEncoder().encode(document.querySelector('pre')!.textContent!).length).toBe(2048)
    const labels = [...document.querySelectorAll('button')].map((button) => button.textContent)
    expect(labels.includes(t('kickoff.retry'))).toBe(kind !== 'task-changed')
    const previous = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === t('kickoff.oldResult'))!
    previous.click()
    expect(onPrevious).toHaveBeenCalledOnce()
  })
})
