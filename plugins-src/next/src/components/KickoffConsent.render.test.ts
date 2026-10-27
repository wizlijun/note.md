// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'
import KickoffConsent from './KickoffConsent.svelte'
import type { KickoffPreview } from '../lib/kickoff/client'
import { setLocale } from '../lib/strings'

let component: ReturnType<typeof mount> | null = null
const preview: KickoffPreview = {
  id: 'preview-1', taskId: 'task-1', providerId: 'codex', providerName: 'Codex', recipient: 'OpenAI',
  files: [{ path: 'task.md', bytes: 100 }, { path: 'diary/<budget>.md', bytes: 200 }], bytes: 500,
  gaps: ['A background file was omitted'], needsConsent: true,
  dataSources: [{ id: 'diary', kind: 'vault', label: 'Diary notes', paths: ['diary/*.md'], enabled: true }],
}
afterEach(() => { if (component) unmount(component); component = null; document.body.innerHTML = '' })
it('discloses the recipient, files, byte counts, instructions, omissions and first-use setup', () => {
  setLocale('en')
  const onConfirm = vi.fn()
  component = mount(KickoffConsent, { target: document.body, props: { preview, onConfirm, onCancel: vi.fn(), onChoose: vi.fn() } })
  flushSync()
  expect(document.body.textContent).toContain('external service')
  expect(document.querySelector('[data-recipient]')?.textContent).toBe('Agent: Codex · Recipient: OpenAI')
  expect(document.body.textContent).toContain('diary/<budget>.md')
  expect(document.querySelector('budget')).toBeNull()
  expect(document.body.textContent).toContain('200 B')
  expect(document.body.textContent).toContain('Snapshot: 500 bytes')
  expect(document.body.textContent).toContain('skill instructions are also sent')
  expect(document.body.textContent).toContain('A background file was omitted')
  expect(document.body.textContent).toContain('skills/task-kickoff/SKILL.md')
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
