// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'
import KickoffConsent from './KickoffConsent.svelte'
import type { KickoffPreview } from '../lib/kickoff/client'
import { setLocale } from '../lib/strings'

let component: ReturnType<typeof mount> | null = null
const preview: KickoffPreview = {
  id: 'preview-1', taskId: 'task-1', providerId: 'codex', providerName: 'Codex', recipient: 'OpenAI',
  vaultRoot: '/Users/owner/<vault>', taskPath: 'inbox/tasks/task.md', needsConsent: true,
  dataSources: [{ id: 'diary', kind: 'vault', label: 'Diary notes', paths: ['diary/*.md'], enabled: true }],
}
afterEach(() => { if (component) unmount(component); component = null; document.body.innerHTML = '' })
it('discloses live research scope, recipient, agent boundaries and first-use setup', () => {
  setLocale('en')
  const onConfirm = vi.fn()
  component = mount(KickoffConsent, { target: document.body, props: { preview, onConfirm, onCancel: vi.fn(), onChoose: vi.fn() } })
  flushSync()
  expect(document.body.textContent).toContain('external service')
  expect(document.querySelector('[data-recipient]')?.textContent).toBe('Agent: Codex · Recipient: OpenAI')
  expect(document.querySelector('[data-vault]')?.textContent).toBe('/Users/owner/<vault>')
  expect(document.querySelector('vault')).toBeNull()
  expect(document.querySelector('[data-task]')?.textContent).toBe('inbox/tasks/task.md')
  expect(document.body.textContent).toContain('notemd search CLI')
  expect(document.body.textContent).toContain('harness web search')
  expect(document.body.textContent).toContain('recent related articles')
  expect(document.body.textContent).toContain('must not modify Vault content, send messages, or execute the task')
  expect(document.body.textContent).toContain('NEXT validates the result')
  expect(document.body.textContent).toContain('not a frozen file snapshot')
  expect(document.body.textContent).not.toContain('Files included')
  expect(document.body.textContent).toContain('next-task-kickoff-v3/')
  expect(onConfirm).not.toHaveBeenCalled()
  document.querySelector<HTMLButtonElement>('[data-consent-confirm]')!.click()
  expect(onConfirm).toHaveBeenCalledOnce()
})
it('supports cancellation and restores focus without sending', () => {
  setLocale('en')
  const trigger = document.createElement('button'); document.body.append(trigger); trigger.focus()
  const onConfirm = vi.fn(), onCancel = vi.fn()
  component = mount(KickoffConsent, { target: document.body, props: { preview, onConfirm, onCancel, onChoose: vi.fn(), returnFocus: trigger } })
  flushSync()
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', cancelable: true }))
  expect(document.querySelector('[role="dialog"]')?.contains(document.activeElement)).toBe(true)
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))
  expect(onCancel).toHaveBeenCalledOnce()
  expect(onConfirm).not.toHaveBeenCalled()
  unmount(component!); component = null
  expect(document.activeElement).toBe(trigger)
})
