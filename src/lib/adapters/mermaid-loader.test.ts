/** @vitest-environment happy-dom */
import { afterAll, afterEach, expect, it, vi } from 'vitest'
// These assertions cover retained Mermaid, independent of the release build selector.
vi.hoisted(() => { vi.stubEnv('VITE_DIAGRAM_RENDERER', 'mermaid') })
afterAll(() => { vi.unstubAllEnvs() })

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null), convertFileSrc: (s: string) => s }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }))
vi.mock('@tauri-apps/plugin-os', () => ({ platform: () => 'macos', type: () => 'macos' }))
const render = vi.hoisted(() => vi.fn(async () => ({ svg: '<svg id="desktop-test"><path/></svg>' })))
vi.mock('@moraya/core/plugins/mermaid-renderer', () => ({ renderMermaid: render, updateMermaidTheme: vi.fn() }))
import { mountRichEditor } from '../editor-bridge'
import { mountRich } from '../../editor-kit/rich'
import { closeFileEditorSession } from '../file-editor-sessions'
import { BrowserMediaResolver } from '@moraya/core/adapters/browser-media-resolver'
import { loadDesktopMermaid } from './mermaid-loader'
const raw = '```mermaid\ngraph TD; A-->B\n```'
afterEach(() => { document.body.replaceChildren(); vi.clearAllMocks() })
it.each([false, true])('desktop bridge explicitly injects the stable original capability (file=%s)', async file => {
  expect((await loadDesktopMermaid()).renderMermaid).toBe(render)
  const root = document.createElement('div'); document.body.append(root)
  const instance = await mountRichEditor(root, raw, () => {}, undefined, new BrowserMediaResolver(), false,
    file ? { tab: { id: 'mermaid-di', filePath: '/vault/a.md', currentContent: raw, mode: 'rich' }, plugins: [] } : undefined)
  try { await vi.waitFor(() => expect(root.querySelector('#desktop-test')).not.toBeNull()); expect(render).toHaveBeenCalled() }
  finally { instance.destroy(); if (file) await closeFileEditorSession('mermaid-di') }
  expect((await loadDesktopMermaid()).renderMermaid).toBe(render)
})
it('legacy Kit keeps Mermaid editable without calling the desktop loader', async () => {
  const root = document.createElement('div'); document.body.append(root)
  const instance = await mountRich(root, raw, '/vault', () => {})
  try { await new Promise(r => setTimeout(r, 220)); expect(root.querySelector('pre')?.style.display).not.toBe('none'); expect(render).not.toHaveBeenCalled() }
  finally { instance.destroy() }
})
