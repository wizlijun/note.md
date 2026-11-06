/** @vitest-environment happy-dom */
import { expect, it, vi } from 'vitest'
vi.mock('../lib/platform-sync', () => ({ isApplePlatformSync: () => true }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null), convertFileSrc: (s: string) => s }))
vi.mock('@tauri-apps/plugin-os', () => ({ platform: () => 'macos', type: () => 'macos' }))
vi.mock('@tauri-apps/api/webview', () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }))
import { mount, unmount } from 'svelte'

const metadata = '---\ntitle: keep\n---\n\n'
const bodies = [
  'plain text', '$$\nx\n$$', '---', '$$\nx\n$$\n\nbody text', 'body text\n\n$$\nx\n$$',
  'body[^n]\n\n[^n]: note\n', '<div>HTML</div>\n', '- first\n  - nested\n',
  'A{>>note<<}B',
]
it.each(bodies.flatMap(body => ['Backspace', 'Delete', 'Enter'].map(key => ({ body, key }))))(
  'desktop Cmd+A $key removes atomic body: $body', async ({ body, key }) => {
    const { default: RichEditor } = await import('../components/RichEditor.svelte')
    const { tabs, activeId } = await import('../lib/tabs.svelte')
    const { fileEditorSession, closeFileEditorSession } = await import('../lib/file-editor-sessions')
    const raw = metadata + body, id = 'select-all-atoms'
    const tab = {
      id, filePath: '/vault/select-all-atoms.md', title: 'select-all-atoms.md',
      kind: 'markdown' as const, mode: 'rich' as const, currentContent: raw, initialContent: raw,
      externalState: 'fresh' as const, externalBannerDismissed: false, lastKnownMtime: 0, lastKnownHash: '',
    }
    tabs.push(tab)
    activeId.value = id
    let ready = false
    const component = mount(RichEditor, {
      target: document.body,
      props: { tab: tabs.find(t => t.id === id)!, fileBacked: true, onFileReady: () => { ready = true } },
    })
    try {
      await vi.waitFor(() => expect(ready).toBe(true))
      const f = fileEditorSession(id)!, originalMetadata = f.view.state.doc.firstChild!
      for (let i = 0; i < 2; i++) {
        f.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', metaKey: true, bubbles: true, cancelable: true }))
        expect(f.view.state.selection.from).toBe(originalMetadata.nodeSize + (body === 'plain text' ? 1 : 0))
        expect(f.view.state.selection.to).toBe(f.view.state.doc.content.size - (body === 'plain text' ? 1 : 0))
      }
      const selectedBody = f.view.state.selection
      f.owner.setReadOnly(true)
      f.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
      expect(f.owner.snapshot().raw).toBe(raw)
      expect(f.view.state.selection.eq(selectedBody)).toBe(true)
      f.owner.setReadOnly(false)
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
      f.view.dom.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(true)
      const changed = (await f.owner.flush()).raw
      expect(changed, String((f.baselineIdentity as { diagnostic: unknown }).diagnostic)).not.toBe(raw)
      expect(changed.startsWith('---\ntitle: keep\n---')).toBe(true)
      expect(f.view.state.doc.firstChild!.eq(originalMetadata)).toBe(true)
      expect(f.view.state.doc.childCount).toBeGreaterThanOrEqual(2)
      f.view.state.doc.forEach((node, _pos, index) => {
        if (index === 0) return
        expect(node.type.name).toBe('paragraph')
        expect(node.content.size).toBe(0)
      })
      await vi.waitFor(() => expect(tabs.find(t => t.id === id)!.currentContent).toBe(changed))
      expect(f.owner.undo()).toBe(true)
      expect(f.owner.snapshot().raw).toBe(raw)
      expect(f.view.state.selection.eq(selectedBody)).toBe(true)
      expect(f.owner.redo()).toBe(true)
      expect((await f.owner.flush()).raw).toBe(changed)
    } finally {
      await unmount(component)
      await closeFileEditorSession(id)
      tabs.splice(0)
      activeId.value = null
      document.body.replaceChildren()
    }
  },
)
