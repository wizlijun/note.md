// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import Harness from './HomeDocumentHost.test-harness.svelte'
import { tabs, activeId } from '../lib/tabs.svelte'
vi.mock('@tauri-apps/plugin-store', () => ({ Store: { load: vi.fn() } }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
it('keeps the same authenticated iframe alive while home is shown, and clears it on close or another document', async () => {
  const tab: any = { id: 'custom', kind: 'custom', filePath: '/file.cef', title: 'file.cef', editorPluginId: 'fixture', editorEntry: 'index.html', currentContent: 'before' }
  tabs.push(tab); activeId.value = tab.id
  const component = mount(Harness, { target: document.body }); await tick()
  const iframe = document.querySelector('iframe')!
  activeId.value = null; await tick()
  expect(document.querySelector('iframe')).toBe(iframe)
  expect(iframe.closest('.document-column')?.hasAttribute('hidden')).toBe(true)
  expect((iframe.closest('.document-column') as HTMLElement).inert).toBe(true)
  window.dispatchEvent(new MessageEvent('message', { origin: 'plugin://fixture', source: iframe.contentWindow, data: { type: 'change', content: 'in-flight edit' } }))
  expect(tabs[0].currentContent).toBe('in-flight edit')
  activeId.value = tab.id; await tick()
  expect(document.querySelector('iframe')).toBe(iframe)
  expect(iframe.closest('.document-column')?.hasAttribute('hidden')).toBe(false)
  tabs.push({ ...tabs[0], id: 'other', kind: 'markdown' })
  activeId.value = 'other'; await tick()
  activeId.value = null; await tick()
  expect(document.querySelector('iframe')).toBeNull()
  activeId.value = tab.id; await tick()
  activeId.value = null; await tick(); tabs.splice(0); await tick()
  expect(document.querySelector('iframe')).toBeNull()
  await unmount(component)
})
