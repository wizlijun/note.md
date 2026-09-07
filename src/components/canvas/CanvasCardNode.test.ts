// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, unmount } from 'svelte'
import { SvelteFlow } from '@xyflow/svelte'
import CanvasCardNode from './CanvasCardNode.svelte'

vi.mock('../../lib/plugins/host-render-html', () => ({
  renderMarkdownInline: (markdown: string) => markdown,
}))

const source = readFileSync(resolve(process.cwd(), 'src/components/canvas/CanvasCardNode.svelte'), 'utf8')

describe('CanvasCardNode interaction contracts', () => {
  it('lets Canvas own pointer gestures over an inactive image body', () => {
    expect(source).not.toMatch(/class="file-image[^\"]*\bnodrag\b/)
    expect(source).not.toMatch(/class="file-image[^\"]*\bnopan\b/)
    expect(source).toContain('draggable="false"')
  })

  it('remounts an active editor when its path or resolver root changes', () => {
    expect(source).toContain('let editorMountKey = $derived')
    expect(source).toContain('data.canvasPath')
    expect(source).toContain('mediaResolverRoot(data.mediaResolver)')
    expect(source).toContain('{#key editorMountKey}')
  })

  it('provides 44px coarse-pointer hit targets for connection and resize handles', () => {
    expect(source).toContain('handleClass="canvas-card-resize-handle"')
    expect(source).toMatch(/@media \(pointer: coarse\)[\s\S]*:global\(\.canvas-handle\)[\s\S]*width: 44px;[\s\S]*height: 44px;/)
    expect(source).toMatch(/@media \(pointer: coarse\)[\s\S]*:global\(\.canvas-card-resize-handle\)[\s\S]*width: 44px !important;[\s\S]*height: 44px !important;/)
  })
})


describe('CanvasCardNode activation', () => {
  let component: ReturnType<typeof mount> | null = null

  afterEach(async () => {
    if (component) await unmount(component)
    component = null
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it.each(['text', 'file', 'link'])('respects the interaction lock for %s cards', async (kind) => {
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    })
    const onActivate = vi.fn()
    const onOpen = vi.fn()
    for (const interactionLocked of [true, false]) {
      component = mount(SvelteFlow, {
        target: document.body,
        props: {
          nodes: [{
            id: 'card', type: 'canvas', position: { x: 0, y: 0 }, width: 240, height: 160,
            data: { kind, text: 'card', url: 'https://example.com/', file: 'note.md', interactionLocked, onActivate, onOpen },
          }],
          nodeTypes: { canvas: CanvasCardNode },
          fitView: false,
        },
      })
      await vi.waitFor(() => expect(document.querySelector('.canvas-card')).toBeTruthy())
      document.querySelector('.canvas-card')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      expect(kind === 'text' ? onActivate : onOpen).toHaveBeenCalledTimes(interactionLocked ? 0 : 1)
      await unmount(component)
      component = null
    }
  })
})
