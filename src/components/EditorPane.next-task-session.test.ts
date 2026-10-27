// @vitest-environment happy-dom
import { afterAll, afterEach, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import EditorPane from './EditorPane.svelte'
import ModeToggle from './ModeToggle.svelte'
import { tabs, activeId, activate, isReadOnlyTab, isGuestUpdateBusy } from '../lib/tabs.svelte'
import { fileEditorSession, closeFileEditorSession } from '../lib/file-editor-sessions'
import { openPath } from '../lib/open-path'
import { activeTab, openFile } from '../lib/tabs.svelte'
import { isApplePlatformSync } from '../lib/platform-sync'

// Run the same platform admission as macOS WKWebView before editor imports.
// happy-dom still supplies the DOM; this does not emulate WebKit itself.
const originalNavigator = vi.hoisted(() => {
  const platform = Object.getOwnPropertyDescriptor(navigator, 'platform')
  const userAgent = Object.getOwnPropertyDescriptor(navigator, 'userAgent')
  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' })
  Object.defineProperty(navigator, 'userAgent', {
    configurable: true,
    value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15',
  })
  return { platform, userAgent }
})
afterAll(() => {
  for (const key of ['platform', 'userAgent'] as const) {
    const descriptor = originalNavigator[key]
    if (descriptor) Object.defineProperty(navigator, key, descriptor)
    else Reflect.deleteProperty(navigator, key)
  }
})

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null), convertFileSrc: (s: string) => s }))
vi.mock('@tauri-apps/plugin-fs', () => ({
  stat: vi.fn(async () => ({ isDirectory: false, mtime: new Date(0), size: 100 })),
  watchImmediate: vi.fn(async () => () => {}),
  exists: vi.fn(async () => false),
}))
vi.mock('../lib/fs', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/fs')>(),
  readMd: vi.fn(async () => raw),
  statFile: vi.fn(async () => ({ mtime: 0, size: 100 })),
}))
vi.mock('../lib/settings.svelte', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/settings.svelte')>(),
  getRecentMode: vi.fn(() => 'rich'),
  setRecentMode: vi.fn(async () => {}),
  pushRecentFile: vi.fn(async () => {}),
}))
vi.mock('../lib/outline/migrate', () => ({ migrateLegacyCompanion: vi.fn(async () => {}) }))
vi.mock('@tauri-apps/plugin-os', () => ({ platform: () => 'macos', type: () => 'macos' }))
vi.mock('@tauri-apps/api/webview', () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => vi.fn() }) }))
vi.mock('../lib/note-anno/answers-store.svelte', () => ({ answersStore: { version: 0 }, loadAnswersFor: vi.fn(), answeredMap: () => new Map() }))
vi.mock('./ExternalChangeBanner.svelte', () => ({ default: () => ({}) }))
vi.mock('./SyncOriginBanner.svelte', () => ({ default: () => ({}) }))
vi.mock('./MirrorSiblingsBanner.svelte', () => ({ default: () => ({}) }))
vi.mock('./SyncToVaultBanner.svelte', () => ({ default: () => ({}) }))
let component: ReturnType<typeof mount> | undefined
let toggle: ReturnType<typeof mount> | undefined
const raw = `---
type: Task
title: 确认审计时间线
description: >-
  确认审计的日期和准备材料，供今晚沟通。
created: 2026-10-27T13:37:00+08:00
task:
  version: 1
  id: 00000000-0000-4000-8000-000000000001
  project: 审计
  due: 2026-10-27T20:00:00+08:00
  done_when: 已确认时间线
  dedupe_key: audit-confirm
generated:
  by: agent:test
  at: 2026-10-27T13:37:00+08:00
sources:
  - markdown: /logs/person-a/day.md#L100
    id: source-a
  - markdown: /logs/person-b/day.md#L120
    id: source-b
  - markdown: /emails/account/inbox/thread.md#L3
    id: source-c
tags:
  - task
  - audit
---
确认审计进展以及时间线，整理沟通材料。[^sourcea]

确认待准备材料，补充需要协调的事项。[^sourceb]

完成标准为获得明确日期与负责人。

[^sourcea]: [沟通记录](/logs/person-a/day.md)，10:00:00–10:20:00。
[^sourceb]: [沟通记录](/logs/person-b/day.md)，11:00:00–11:20:00。
`
afterEach(async () => {
  if (toggle) await unmount(toggle)
  if (component) await unmount(component)
  for (const tab of tabs) await closeFileEditorSession(tab.id)
  tabs.splice(0)
  activeId.value = null
  document.body.replaceChildren()
  vi.restoreAllMocks()
})
it('keeps a Task editable across Source/Rich changes and remounts on the Mac platform branch', async () => {
  expect(isApplePlatformSync()).toBe(true)
  tabs.push({ id: 'next-task-anonymous', filePath: '/vault/inbox/tasks/a-task.md', title: 'a-task.md', kind: 'markdown', mode: 'rich', initialContent: raw, currentContent: raw, externalState: 'fresh', externalBannerDismissed: false, lastKnownMtime: 0, lastKnownHash: '' })
  activeId.value = tabs[0].id
  toggle = mount(ModeToggle, { target: document.body, props: { get tab() { return tabs.find(tab => tab.id === activeId.value)! } } })
  component = mount(EditorPane, { target: document.body, props: { get tab() { return tabs.find(tab => tab.id === activeId.value)! } } })
  await vi.waitFor(() => expect(fileEditorSession(tabs[0].id)).toBeDefined())
  const session = fileEditorSession(tabs[0].id)!
  expect(isReadOnlyTab(tabs[0])).toBe(false)
  expect(isGuestUpdateBusy(tabs[0].filePath)).toBe(false)
  document.querySelectorAll<HTMLButtonElement>('[role=tab]')[1].click()
  await vi.waitFor(() => expect(tabs[0].mode).toBe('source'))
  await tick()
  expect(tabs[0].mode).toBe('source')
  await vi.waitFor(() => expect(document.querySelector('textarea')).not.toBeNull())
  const source = document.querySelector<HTMLTextAreaElement>('textarea')!
  expect(source.value).toBe(raw)
  source.value = raw + '\nSource 编辑。\n'
  source.dispatchEvent(new Event('input', { bubbles: true }))
  expect(session.owner.snapshot().raw).toBe(source.value)
  document.querySelectorAll<HTMLButtonElement>('[role=tab]')[0].click()
  await vi.waitFor(() => expect(tabs[0].mode).toBe('rich'))
  await tick()
  expect(tabs[0].mode).toBe('rich')
  const position = session.view.state.doc.child(0).nodeSize + 1
  session.view.dispatch(session.view.state.tr.insertText('测试', position))
  await tick()
  expect(session.owner.snapshot().raw).toContain('测试')
  expect(session.owner.snapshot().raw.length).toBeGreaterThan(raw.length)
  tabs.push({ ...tabs[0], id: 'other', filePath: '/vault/other.md', title: 'other.md', initialContent: 'other', currentContent: 'other' })
  await activate('other')
  await tick()
  await vi.waitFor(() => expect(fileEditorSession('other')).toBeDefined())
  await activate(tabs[0].id)
  await tick()
  await vi.waitFor(() => expect(session.view.dom.isConnected).toBe(true))
  document.querySelectorAll<HTMLButtonElement>('[role=tab]')[1].click()
  await vi.waitFor(() => expect(tabs[0].mode).toBe('source'))
  await tick()
  expect((document.querySelector('textarea') as HTMLTextAreaElement).value).toBe(session.owner.snapshot().raw)
  document.querySelectorAll<HTMLButtonElement>('[role=tab]')[0].click()
  await vi.waitFor(() => expect(tabs[0].mode).toBe('rich'))
  await tick()
  session.view.dispatch(session.view.state.tr.insertText('再测', position))
  expect(session.owner.snapshot().raw).toContain('再测测试')
})

it('opens and reuses Task tabs through the real external openPath entry', async () => {
  await openPath('/vault/inbox/tasks/from-next-task.md')
  expect(tabs).toHaveLength(1)
  const originalId = tabs[0].id
  toggle = mount(ModeToggle, { target: document.body, props: { get tab() { return activeTab()! } } })
  component = mount(EditorPane, { target: document.body, props: { get tab() { return activeTab()! } } })
  await vi.waitFor(() => expect(fileEditorSession(originalId)).toBeDefined())
  await openPath('/vault/inbox/tasks/from-next-task.md')
  expect(tabs).toHaveLength(1)
  expect(activeId.value).toBe(originalId)
  document.querySelectorAll<HTMLButtonElement>('[role=tab]')[1].click()
  await vi.waitFor(() => expect(activeTab()?.mode).toBe('source'))
  await vi.waitFor(() => expect(document.querySelector('textarea')).not.toBeNull())
  const source = document.querySelector<HTMLTextAreaElement>('textarea')!
  source.value += '\n入口编辑。\n'
  source.dispatchEvent(new Event('input', { bubbles: true }))
  expect(fileEditorSession(originalId)!.owner.snapshot().raw).toBe(source.value)
  await openFile('/vault/other-task.md')
  await vi.waitFor(() => expect(activeTab()?.filePath).toBe('/vault/other-task.md'))
  await vi.waitFor(() => expect(fileEditorSession(activeTab()!.id)).toBeDefined())
  await openPath('/vault/inbox/tasks/from-next-task.md')
  await vi.waitFor(() => expect(activeId.value).toBe(originalId))
  await vi.waitFor(() => expect(fileEditorSession(originalId)!.view.dom.isConnected).toBe(true))
  document.querySelectorAll<HTMLButtonElement>('[role=tab]')[0].click()
  await vi.waitFor(() => expect(activeTab()?.mode).toBe('rich'))
  const session = fileEditorSession(originalId)!
  session.view.dispatch(session.view.state.tr.insertText('入口', session.view.state.doc.child(0).nodeSize + 1))
  expect(session.owner.snapshot().raw).toContain('入口确认审计')
})
