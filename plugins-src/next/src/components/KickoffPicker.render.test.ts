// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'
import KickoffPicker from './KickoffPicker.svelte'
import { KICKOFF_SAFETY_REASON } from '../lib/kickoff/client'
import { parseDataSources } from '../lib/kickoff/template'
import { setLocale } from '../lib/strings'
let component: ReturnType<typeof mount> | null = null
afterEach(() => { if (component) unmount(component); component = null; document.body.innerHTML = '' })
it('shows disabled provider reasons and skill-declared data sources in canonical popup', () => {
  setLocale('en')
  const onSelect = vi.fn()
  component = mount(KickoffPicker, { target: document.body, props: {
    options: [{ id: 'codex', name: 'Codex', harness: { harness: 'Codex', ok: false, version: '1.2', default_model: 'gpt', hint: `Original hint; ${KICKOFF_SAFETY_REASON}`, warning: 'Rate limit' } }],
    selected: 'codex', dataSources: [{ id: 'tasks', kind: 'vault', label: 'Task files', paths: [], enabled: true }, { id: 'mail', kind: 'mail', label: 'Email', paths: [], enabled: false }], onSelect, onClose: vi.fn(),
  } })
  flushSync()
  const option = document.querySelector<HTMLButtonElement>('.menu-panel .menu-row')!
  expect(option.disabled).toBe(true)
  expect(option.textContent).toContain('Original hint')
  expect(option.textContent).toContain('Update this agent plugin to support read-only kickoff')
  expect(option.textContent).toContain('Rate limit')
  expect(document.querySelector('.menu-panel')?.textContent).toContain('Task files')
  expect(document.querySelector('.menu-panel')?.textContent).toContain('Not enabled')
  option.click()
  expect(onSelect).not.toHaveBeenCalled()
})

it('shows the task-only fallback when the skill cannot be parsed', () => {
  setLocale('en')
  component = mount(KickoffPicker, { target: document.body, props: {
    options: [], selected: '', dataSources: parseDataSources('---\ndata_sources: invalid\n---\n'), onSelect: vi.fn(), onClose: vi.fn(),
  } })
  flushSync()
  expect(document.body.textContent).toContain('The procedure could not be parsed. Only the task file will be read.')
  expect(document.body.textContent).toContain('Task file')
  expect(document.body.textContent).not.toContain('Task file and its sources')
})

it.each([
  [['Claude Code', 'Codex', 'DeepSeek'], 'multiple installed providers'],
  [['Codex'], 'Codex only'],
  [['DeepSeek'], 'DeepSeek only'],
  [[], 'no installed plugins'],
] as [string[], string][])('renders only the installed provider list: %j (%s)', (names) => {
  setLocale('en')
  component = mount(KickoffPicker, { target: document.body, props: {
    options: names.map((name) => ({ id: name.toLowerCase(), name, harness: { harness: name, ok: false, hint: KICKOFF_SAFETY_REASON } })),
    selected: names[0]?.toLowerCase() ?? '', dataSources: [], onSelect: vi.fn(), onClose: vi.fn(),
  } })
  flushSync()
  const rows = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
  expect(rows.map((row) => row.querySelector('.nm')?.textContent)).toEqual(names)
  expect(rows.every((row) => row.disabled)).toBe(true)
  if (!names.length) expect(document.body.textContent).toContain('No available agent plugin')
})
