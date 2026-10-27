// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'
import KickoffButton from './KickoffButton.svelte'
import type { ButtonStateInput } from '../lib/kickoff/button-state'
import { setLocale } from '../lib/strings'

const components: ReturnType<typeof mount>[] = []
afterEach(() => {
  components.splice(0).forEach((component) => unmount(component))
  document.body.innerHTML = ''
  vi.useRealTimers()
})
const run = { run_id: 'run-1', harness: 'codex', requested_at: '2026-10-27T10:00:00Z', task_path: 'inbox/tasks/test-task.md', based_on: 'hash', state: 'running' as const, failure: null }
function render(input: ButtonStateInput, now = () => Date.parse('2026-10-27T10:02:03Z')) {
  setLocale('en')
  components.push(mount(KickoffButton, { target: document.body, props: { itemTitle: 'Ship', input, now, onClick: vi.fn() } }))
  flushSync()
}
describe('KickoffButton', () => {
  it.each([
    [{}, 'Get me started'],
    [{ starting: true }, 'Starting'],
    [{ run }, '2:03'],
    [{ result: { based_on: 'hash' }, unread: true }, 'View kickoff'],
    [{ result: { based_on: 'hash' } }, 'View kickoff'],
    [{ result: { based_on: 'old' }, taskHash: 'new' }, 'Outdated'],
    [{ run: { ...run, state: 'failed', failure: { kind: 'error', message: 'Failed', at: '' } } }, 'Retry'],
  ] as [ButtonStateInput, string][])('renders state %#', (input, text) => {
    render(input)
    expect(document.body.textContent).toContain(text)
    expect(document.querySelector('button')?.getAttribute('aria-label')).toContain('Ship')
    if (input.starting) expect(document.querySelector('button')?.disabled).toBe(true)
    if (input.unread) expect(document.querySelector('[data-unread]')).not.toBeNull()
  })
  it('restores absolute elapsed time, ticks and stops after unmount', () => {
    vi.useFakeTimers()
    let now = Date.parse('2026-10-27T11:02:03Z')
    render({ run, status: { state: 'running', started_at: '2026-10-27T10:00:00Z', steps: 3, last: 'Reading' } }, () => now)
    expect(document.querySelector('[aria-live="off"]')?.textContent).toContain('1:02:03')
    expect(document.querySelector('button')?.title).toContain('3')
    now += 1000
    vi.advanceTimersByTime(1000)
    flushSync()
    expect(document.body.textContent).toContain('1:02:04')
    components.splice(0).forEach((component) => unmount(component))
    expect(vi.getTimerCount()).toBe(0)
  })
})
