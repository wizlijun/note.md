// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, tick, unmount } from 'svelte'
import { createClassComponent } from 'svelte/legacy'
import CanvasView from './CanvasView.svelte'
import type { Tab } from '../../lib/tabs.svelte'
import {
  clearCanvasClipboard,
  clearCanvasUiSessions,
  decodeJsonCanvas,
  rememberCanvasClipboard,
} from '../../lib/canvas'
import { formFactor } from '../../lib/platform.svelte'
import type { CanvasViewportState } from './canvas-view-state'

const h = vi.hoisted(() => ({
  setContent: vi.fn(),
  openFile: vi.fn(async () => {}),
  storeGet: vi.fn(async (): Promise<CanvasViewportState | null> => null),
  storeSet: vi.fn(async () => {}),
  storeSave: vi.fn(async () => {}),
  invoke: vi.fn(),
  openDialog: vi.fn(),
  clipboardRead: vi.fn(async () => ''),
  clipboardWrite: vi.fn(async (_text: string) => {}),
  showError: vi.fn(),
  editorMarkdown: '',
  editorChange: null as ((value: string) => void) | null,
  sotRoot: '/vault' as string | null,
  folderRoot: null as string | null,
}))

vi.mock('../../lib/tabs.svelte', () => ({
  setContent: h.setContent,
  openFile: h.openFile,
}))
vi.mock('../../lib/dialogs', () => ({ showError: h.showError }))
vi.mock('../../lib/sotvault.svelte', () => ({
  sotvaultStore: { get vaultRoot() { return h.sotRoot }, tick: 0 },
}))
vi.mock('../../lib/folder-view.svelte', () => ({
  folderView: { get rootDir() { return h.folderRoot } },
}))
vi.mock('../../lib/plugins/host-render-html', () => ({
  renderMarkdownInline: (markdown: string) => `<p>${markdown.replaceAll('&', '&amp;').replaceAll('<', '&lt;')}</p>`,
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: h.invoke }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: h.openDialog }))
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({
  readText: h.clipboardRead,
  writeText: h.clipboardWrite,
}))
vi.mock('@tauri-apps/plugin-store', () => ({
  Store: { load: vi.fn(async () => ({ get: h.storeGet, set: h.storeSet, save: h.storeSave })) },
}))
vi.mock('../../lib/editor-bridge', () => ({
  updateDocumentBaseDir: vi.fn(),
  mountRichEditor: vi.fn(async (
    _root: HTMLElement,
    initialContent: string,
    onChange: (value: string) => void,
  ) => {
    h.editorMarkdown = initialContent
    h.editorChange = onChange
    const editor = document.createElement('div')
    editor.className = 'ProseMirror'
    document.body.appendChild(editor)
    return {
      view: { focus: vi.fn() },
      getMarkdown: () => h.editorMarkdown,
      setContent: (value: string) => { h.editorMarkdown = value },
      destroy: () => editor.remove(),
    }
  }),
}))

class ResizeObserverStub {
  private static readonly instances = new Set<ResizeObserverStub>()
  private readonly targets = new Set<Element>()

  constructor(private readonly callback: ResizeObserverCallback) {
    ResizeObserverStub.instances.add(this)
  }

  static reset(): void {
    ResizeObserverStub.instances.clear()
  }

  static resize(target: Element, width: number, height: number): void {
    for (const observer of ResizeObserverStub.instances) observer.emit(target, width, height)
  }

  private emit(target: Element, width: number, height: number): void {
    if (!this.targets.has(target) || !target.isConnected) return
    const element = target as HTMLElement
    Object.defineProperties(element, {
      offsetWidth: { configurable: true, value: width },
      offsetHeight: { configurable: true, value: height },
    })
    const contentRect = {
      x: 0, y: 0, top: 0, left: 0, right: width, bottom: height,
      width, height, toJSON: () => ({}),
    } as DOMRect
    element.getBoundingClientRect = () => contentRect
    this.callback([{ target, contentRect } as ResizeObserverEntry], this as unknown as ResizeObserver)
  }

  observe(target: Element): void {
    this.targets.add(target)
    const element = target as HTMLElement
    const width = Number.parseFloat(element.style.width) || 100
    const height = Number.parseFloat(element.style.height) || 100
    Object.defineProperties(element, {
      offsetWidth: { configurable: true, value: width },
      offsetHeight: { configurable: true, value: height },
    })
    const contentRect = {
      x: 0, y: 0, top: 0, left: 0, right: width, bottom: height,
      width, height, toJSON: () => ({}),
    } as DOMRect
    element.getBoundingClientRect = () => contentRect
    for (const handle of element.querySelectorAll<HTMLElement>('.source, .target')) {
      Object.defineProperties(handle, {
        offsetWidth: { configurable: true, value: 8 },
        offsetHeight: { configurable: true, value: 8 },
      })
      handle.getBoundingClientRect = () => ({
        x: 0, y: 0, top: 0, left: 0, right: 8, bottom: 8,
        width: 8, height: 8, toJSON: () => ({}),
      }) as DOMRect
    }
    queueMicrotask(() => {
      if (this.targets.has(target) && target.isConnected) {
        this.callback([{ target, contentRect } as ResizeObserverEntry], this as unknown as ResizeObserver)
      }
    })
  }

  unobserve(target: Element): void {
    this.targets.delete(target)
  }

  disconnect(): void {
    this.targets.clear()
    ResizeObserverStub.instances.delete(this)
  }
}

const SAMPLE = JSON.stringify({
  nodes: [
    { id: 'text-1', type: 'text', text: '# 画布卡片', x: 0, y: 0, width: 260, height: 160, pluginField: 42 },
    { id: 'link-1', type: 'link', url: 'https://example.com/', x: 360, y: 0, width: 240, height: 140 },
  ],
  edges: [
    { id: 'edge-1', fromNode: 'text-1', fromSide: 'right', toNode: 'link-1', toSide: 'left', label: '参考' },
  ],
  topLevelExtension: { enabled: true },
})

function tab(): Tab {
  return {
    id: 'canvas-tab', filePath: '/vault/boards/demo.canvas', title: 'demo.canvas',
    initialContent: SAMPLE, currentContent: SAMPLE, mode: 'rich', kind: 'canvas',
    externalState: 'fresh', externalBannerDismissed: false,
    lastKnownMtime: 0, lastKnownHash: '',
  }
}

async function submitCanvasInput(value: string): Promise<void> {
  await vi.waitFor(() => expect(document.querySelector('.canvas-input-dialog[open]')).toBeTruthy())
  const dialog = document.querySelector('.canvas-input-dialog') as HTMLDialogElement
  ;(dialog.querySelector('input') as HTMLInputElement).value = value
  dialog.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await tick()
}

describe('CanvasView', () => {
  let component: ReturnType<typeof mount> | null = null

  beforeEach(() => {
    document.body.innerHTML = ''
    h.setContent.mockClear()
    h.invoke.mockReset()
    h.openDialog.mockReset()
    h.clipboardRead.mockReset()
    h.clipboardRead.mockResolvedValue('')
    h.clipboardWrite.mockReset()
    h.clipboardWrite.mockResolvedValue(undefined)
    h.showError.mockReset()
    h.editorMarkdown = ''
    h.editorChange = null
    clearCanvasUiSessions()
    clearCanvasClipboard()
    h.sotRoot = '/vault'
    h.folderRoot = null
    h.storeGet.mockResolvedValue(null)
    formFactor.value = 'desktop'
    ResizeObserverStub.reset()
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    if (component) await unmount(component)
    component = null
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('renders standard nodes/edge and serializes a new text node without Flow state', async () => {
    component = mount(CanvasView as unknown as Parameters<typeof mount>[0], {
      target: document.body,
      props: { tab: tab() },
    })
    await tick()
    await tick()
    flushSync()

    expect(document.querySelectorAll('.svelte-flow__node')).toHaveLength(2)
    await vi.waitFor(() => expect(document.body.textContent).toContain('# 画布卡片'))
    expect(document.body.textContent).toContain('example.com')

    const addText = Array.from(document.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('文本')) as HTMLButtonElement
    addText.click()
    flushSync()

    const serialized = h.setContent.mock.calls.at(-1)?.[1] as string
    expect(serialized).toContain('"topLevelExtension"')
    expect(serialized).toContain('"pluginField"')
    expect(serialized).not.toContain('"selected"')
    expect(serialized).not.toContain('"viewport"')
    expect(JSON.parse(serialized).nodes).toHaveLength(3)
  })

  it('reactively enables undo and redo toolbar actions', async () => {
    component = mount(CanvasView as unknown as Parameters<typeof mount>[0], {
      target: document.body,
      props: { tab: tab() },
    })
    await vi.waitFor(() => expect(document.querySelector('.canvas-toolbar')).toBeTruthy())

    let undo = document.querySelector('button[aria-label^="撤销"]') as HTMLButtonElement
    let redo = document.querySelector('button[aria-label^="重做"]') as HTMLButtonElement
    expect(undo.disabled).toBe(true)
    expect(redo.disabled).toBe(true)

    ;(Array.from(document.querySelectorAll('.canvas-toolbar > button'))
      .find((button) => button.textContent?.includes('分组')) as HTMLButtonElement).click()
    await submitCanvasInput('空分组')
    await tick()
    flushSync()

    undo = document.querySelector('button[aria-label^="撤销"]') as HTMLButtonElement
    redo = document.querySelector('button[aria-label^="重做"]') as HTMLButtonElement
    expect(undo.disabled).toBe(false)
    expect(undo.title).toContain('创建分组节点')
    expect(redo.disabled).toBe(true)

    undo.click()
    await tick()
    expect(JSON.parse(h.setContent.mock.calls.at(-1)?.[1] as string).nodes).toHaveLength(2)
    expect((document.querySelector('button[aria-label^="撤销"]') as HTMLButtonElement).disabled).toBe(true)
    redo = document.querySelector('button[aria-label^="重做"]') as HTMLButtonElement
    expect(redo.disabled).toBe(false)

    redo.click()
    await tick()
    expect(JSON.parse(h.setContent.mock.calls.at(-1)?.[1] as string).nodes).toHaveLength(3)
  })

  it('keeps save flushes inside one text-edit history transaction', async () => {
    component = mount(CanvasView as unknown as Parameters<typeof mount>[0], {
      target: document.body,
      props: { tab: tab() },
    })
    await vi.waitFor(() => expect(document.querySelector('[data-id="text-1"] .canvas-card')).toBeTruthy())

    ;(document.querySelector('[data-id="text-1"] .canvas-card') as HTMLElement)
      .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await vi.waitFor(() => expect(h.editorChange).toBeTypeOf('function'))

    h.editorMarkdown = '# 第一次'
    h.editorChange?.(h.editorMarkdown)
    await tick()
    window.dispatchEvent(new CustomEvent('notemd:flush-doc', { detail: { tabId: 'canvas-tab' } }))
    await tick()

    h.editorMarkdown = '# 第二次'
    h.editorChange?.(h.editorMarkdown)
    await tick()
    const pane = document.querySelector('.svelte-flow__pane') as HTMLElement
    ;(document.querySelector('.embedded-markdown') as HTMLElement)
      .dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: pane }))
    await Promise.resolve()
    await tick()

    expect(JSON.parse(h.setContent.mock.calls.at(-1)?.[1] as string).nodes[0].text).toBe('# 第二次')
    const undo = document.querySelector('button[aria-label^="撤销"]') as HTMLButtonElement
    expect(undo.title).toContain('编辑文本节点')
    undo.click()
    await tick()
    expect(JSON.parse(h.setContent.mock.calls.at(-1)?.[1] as string).nodes[0].text).toBe('# 画布卡片')
  })

  it('creates a geometric group around the selected node', async () => {
    component = mount(CanvasView as unknown as Parameters<typeof mount>[0], {
      target: document.body,
      props: { tab: tab() },
    })
    await vi.waitFor(() => expect(document.querySelectorAll('.svelte-flow__node')).toHaveLength(2))

    ;(document.querySelector('[data-id="text-1"]') as HTMLElement).click()
    await tick()
    const addGroup = Array.from(document.querySelectorAll('.canvas-toolbar > button'))
      .find((button) => button.textContent?.includes('分组')) as HTMLButtonElement
    addGroup.click()
    await submitCanvasInput('重点')
    flushSync()

    const serialized = h.setContent.mock.calls.at(-1)?.[1] as string
    const nodes = JSON.parse(serialized).nodes as Array<Record<string, unknown>>
    expect(nodes[0]).toMatchObject({
      type: 'group', label: '重点', x: -36, y: -52, width: 332, height: 248,
    })
    expect(nodes.map((node) => node.id)).toEqual([expect.any(String), 'text-1', 'link-1'])
  })

  it('draws an exact standard group rectangle with the frame tool', async () => {
    h.storeGet.mockResolvedValue({ x: 0, y: 0, zoom: 1, updatedAt: 1 })
    component = mount(CanvasView as unknown as Parameters<typeof mount>[0], {
      target: document.body,
      props: { tab: tab() },
    })
    await vi.waitFor(() => expect(document.querySelector('.svelte-flow__pane')).toBeTruthy())
    const surface = document.querySelector('.canvas-surface') as HTMLElement
    const pane = document.querySelector('.svelte-flow__pane') as HTMLElement
    ;(Array.from(document.querySelectorAll('.canvas-toolbar > button'))
      .find((button) => button.textContent?.trim() === '框组') as HTMLButtonElement).click()
    await tick()

    pane.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, pointerId: 17, pointerType: 'mouse', button: 0, isPrimary: true, clientX: 100, clientY: 90,
    }))
    surface.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true, pointerId: 17, pointerType: 'mouse', isPrimary: true, clientX: 410, clientY: 310,
    }))
    await tick()
    expect(document.querySelector('.draw-rectangle')).toBeTruthy()

    surface.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true, pointerId: 17, pointerType: 'mouse', button: 0, isPrimary: true, clientX: 410, clientY: 310,
    }))
    await tick()
    const saved = JSON.parse(h.setContent.mock.calls.at(-1)?.[1] as string)
    expect(saved.nodes[0]).toMatchObject({ type: 'group', x: 100, y: 90, width: 310, height: 220 })
    expect(document.querySelector('.draw-rectangle')).toBeFalsy()
    expect((document.querySelector('button[aria-label^="撤销"]') as HTMLButtonElement).title)
      .toContain('拖拽创建分组')
  })

  it('draws a minimum-sized group with one-finger touch input', async () => {
    h.storeGet.mockResolvedValue({ x: 0, y: 0, zoom: 1, updatedAt: 1 })
    component = mount(CanvasView as unknown as Parameters<typeof mount>[0], {
      target: document.body,
      props: { tab: tab() },
    })
    await vi.waitFor(() => expect(document.querySelector('.svelte-flow__pane')).toBeTruthy())
    const surface = document.querySelector('.canvas-surface') as HTMLElement
    const pane = document.querySelector('.svelte-flow__pane') as HTMLElement
    ;(Array.from(document.querySelectorAll('.canvas-toolbar > button'))
      .find((button) => button.textContent?.trim() === '框组') as HTMLButtonElement).click()
    await tick()

    pane.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, pointerId: 18, pointerType: 'touch', button: 0, isPrimary: true, clientX: 100, clientY: 90,
    }))
    surface.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true, pointerId: 18, pointerType: 'touch', isPrimary: true, clientX: 130, clientY: 120,
    }))
    surface.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true, pointerId: 18, pointerType: 'touch', button: 0, isPrimary: true, clientX: 130, clientY: 120,
    }))
    await tick()

    expect(JSON.parse(h.setContent.mock.calls.at(-1)?.[1] as string).nodes[0]).toMatchObject({
      type: 'group', x: 100, y: 90, width: 180, height: 120,
    })
  })

  it('cancels a pending document gesture before applying a clean external reload', async () => {
    h.storeGet.mockResolvedValue({ x: 0, y: 0, zoom: 1, updatedAt: 1 })
    const initial = tab()
    const legacy = createClassComponent({
      component: CanvasView,
      target: document.body,
      props: { tab: initial },
    })
    try {
      await vi.waitFor(() => expect(document.querySelector('.svelte-flow__pane')).toBeTruthy())
      const surface = document.querySelector('.canvas-surface') as HTMLElement
      const pane = document.querySelector('.svelte-flow__pane') as HTMLElement
      ;(document.querySelector('button[title="拖拽绘制分组（快捷键 2）"]') as HTMLButtonElement).click()
      pane.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, pointerId: 71, pointerType: 'mouse', button: 0, isPrimary: true, clientX: 40, clientY: 40,
      }))
      surface.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true, pointerId: 71, pointerType: 'mouse', isPrimary: true, clientX: 260, clientY: 180,
      }))
      await tick()
      expect(document.querySelector('.draw-rectangle')).toBeTruthy()

      const incoming = JSON.stringify({
        nodes: [{ id: 'external', type: 'text', text: 'external reload', x: 500, y: 300, width: 200, height: 120 }],
        edges: [],
      })
      legacy.$set({ tab: { ...initial, currentContent: incoming, initialContent: incoming } })
      await tick()
      await tick()
      expect(document.querySelector('.draw-rectangle')).toBeFalsy()
      await vi.waitFor(() => expect(document.body.textContent).toContain('external reload'))

      surface.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true, pointerId: 71, pointerType: 'mouse', button: 0, isPrimary: true, clientX: 260, clientY: 180,
      }))
      await tick()
      expect(h.setContent).not.toHaveBeenCalled()
    } finally {
      legacy.$destroy()
      document.body.innerHTML = ''
    }
  })

  it.each(['selection', 'group-selection', 'single'] as const)(
    'persists a %s drag as one undoable move, including unselected group contents', async (mode) => {
      h.storeGet.mockResolvedValue({ x: 0, y: 0, zoom: 1, updatedAt: 1 })
      const initialNodes = [
        ...(mode === 'group-selection' ? [
          { id: 'first', type: 'group', label: 'outer', x: 100, y: 100, width: 300, height: 240 },
          { id: 'nested', type: 'group', label: 'nested', x: 130, y: 170, width: 200, height: 130 },
          { id: 'inside', type: 'text', text: 'inside', x: 160, y: 210, width: 80, height: 50 },
        ] : [
          { id: 'first', type: 'text', text: 'first', x: 100, y: 100, width: 200, height: 120 },
        ]),
        { id: 'second', type: 'text', text: 'second', x: 500, y: 100, width: 160, height: 110 },
        { id: 'outside', type: 'text', text: 'outside', x: 900, y: 500, width: 160, height: 110 },
      ]
      const initial = tab()
      initial.currentContent = initial.initialContent = JSON.stringify({ nodes: initialNodes, edges: [] })
      component = mount(CanvasView, { target: document.body, props: { tab: initial } })
      await vi.waitFor(() => expect(document.querySelector('[data-id="first"]')).toBeTruthy())
      const flow = document.querySelector('.svelte-flow') as HTMLElement
      const pane = document.querySelector('.svelte-flow__pane') as HTMLElement
      await tick()
      flow.style.width = '1200px'
      flow.style.height = '800px'
      ResizeObserverStub.resize(flow, 1200, 800)
      flow.getBoundingClientRect = () => ({
        x: 0, y: 0, top: 0, left: 0, right: 1200, bottom: 800,
        width: 1200, height: 800, toJSON: () => ({}),
      }) as DOMRect
      pane.getBoundingClientRect = flow.getBoundingClientRect
      await tick()

      let dragTarget: HTMLElement
      if (mode === 'single') {
        dragTarget = document.querySelector('[data-id="first"]') as HTMLElement
        dragTarget.click()
        await tick()
      } else {
        // Select the top strip: it intersects the outer group and sibling, but not the descendants.
        const pointer = { bubbles: true, pointerId: 81, pointerType: 'mouse', button: 0, isPrimary: true }
        pane.dispatchEvent(new PointerEvent('pointerdown', { ...pointer, clientX: 90, clientY: 90 }))
        pane.dispatchEvent(new PointerEvent('pointermove', { ...pointer, clientX: 700, clientY: 150 }))
        await tick()
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        pane.dispatchEvent(new PointerEvent('pointerup', { ...pointer, clientX: 700, clientY: 150 }))
        await vi.waitFor(() => expect(document.querySelector('.svelte-flow__selection-wrapper')).toBeTruthy())
        expect(Array.from(document.querySelectorAll('.svelte-flow__node.selected')).map((node) => node.getAttribute('data-id')))
          .toEqual(['first', 'second'])
        dragTarget = document.querySelector('.svelte-flow__selection-wrapper') as HTMLElement
      }

      const mouse = { bubbles: true, cancelable: true, view: window, button: 0, buttons: 1, altKey: true }
      dragTarget.dispatchEvent(new MouseEvent('mousedown', { ...mouse, clientX: 196, clientY: 127 }))
      window.dispatchEvent(new MouseEvent('mousemove', { ...mouse, clientX: 200, clientY: 130 }))
      await tick()
      window.dispatchEvent(new MouseEvent('mousemove', { ...mouse, clientX: 235, clientY: 155 }))
      await tick()
      window.dispatchEvent(new MouseEvent('mousemove', { ...mouse, clientX: 273, clientY: 179 }))
      await tick()
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      const movedIds = new Set(mode === 'single' ? ['first'] : mode === 'selection'
        ? ['first', 'second'] : ['first', 'nested', 'inside', 'second'])
      const previewPositions = initialNodes.map((node) => (document.querySelector(`[data-id="${node.id}"]`) as HTMLElement).style.transform)
      const savesDuringDrag = h.setContent.mock.calls.length
      window.dispatchEvent(new MouseEvent('mouseup', { ...mouse, buttons: 0, clientX: 273, clientY: 179 }))
      await tick()

      for (const node of initialNodes) {
        const dx = movedIds.has(node.id) ? 73 : 0
        const dy = movedIds.has(node.id) ? 49 : 0
        expect(previewPositions[initialNodes.indexOf(node)])
          .toBe(`translate(${node.x + dx}px, ${node.y + dy}px)`)
      }
      expect(savesDuringDrag).toBe(0)

      expect(h.setContent).toHaveBeenCalledOnce()
      expect(JSON.parse(h.setContent.mock.calls.at(-1)![1]).nodes).toEqual(initialNodes.map((node) => ({
        ...node,
        x: node.x + (movedIds.has(node.id) ? 73 : 0),
        y: node.y + (movedIds.has(node.id) ? 49 : 0),
      })))
      const undo = document.querySelector('button[aria-label^="撤销"]') as HTMLButtonElement
      expect(undo.title).toContain(mode === 'single' ? '移动节点' : mode === 'selection' ? '移动多个节点' : '移动分组与选区')
      await new Promise((resolve) => setTimeout(resolve, 0))
      undo.click()
      await tick()
      expect(JSON.parse(h.setContent.mock.calls.at(-1)![1]).nodes).toEqual(initialNodes)
      expect(undo.disabled).toBe(true)
    },
  )

  it('persists keyboard movement and applies group closure semantics', async () => {
    const grouped = tab()
    grouped.currentContent = grouped.initialContent = JSON.stringify({
      nodes: [
        { id: 'group-1', type: 'group', label: '分组', x: 0, y: 0, width: 300, height: 220 },
        { id: 'inside', type: 'text', text: 'inside', x: 40, y: 50, width: 120, height: 80 },
      ],
      edges: [],
    })
    component = mount(CanvasView as unknown as Parameters<typeof mount>[0], {
      target: document.body,
      props: { tab: grouped },
    })
    await vi.waitFor(() => expect(document.querySelector('[data-id="group-1"] .group-label')).toBeTruthy())

    const label = document.querySelector('[data-id="group-1"] .group-label') as HTMLElement
    label.click()
    await tick()
    label.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    await tick()
    let nodes = JSON.parse(h.setContent.mock.calls.at(-1)?.[1] as string).nodes as Array<Record<string, unknown>>
    expect(nodes.find((node) => node.id === 'group-1')).toMatchObject({ x: 1, y: 0 })
    expect(nodes.find((node) => node.id === 'inside')).toMatchObject({ x: 41, y: 50 })

    label.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true }))
    await tick()
    nodes = JSON.parse(h.setContent.mock.calls.at(-1)?.[1] as string).nodes as Array<Record<string, unknown>>
    expect(nodes.find((node) => node.id === 'group-1')).toMatchObject({ x: 1, y: 10 })
    expect(nodes.find((node) => node.id === 'inside')).toMatchObject({ x: 41, y: 60 })
  })

  it('renames, styles, clears and ungroups while preserving contained nodes', async () => {
    h.invoke.mockResolvedValue(Uint8Array.from([1, 137, 80, 78, 71]).buffer)
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:group-background')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const grouped = tab()
    grouped.currentContent = grouped.initialContent = JSON.stringify({
      nodes: [
        { id: 'group-1', type: 'group', label: '旧名称', background: 'assets/bg.png', x: 0, y: 0, width: 300, height: 220 },
        { id: 'inside', type: 'text', text: 'inside', x: 40, y: 50, width: 120, height: 80 },
      ],
      edges: [],
    })
    component = mount(CanvasView as unknown as Parameters<typeof mount>[0], {
      target: document.body,
      props: { tab: grouped },
    })
    await vi.waitFor(() => expect(document.querySelector('[data-id="group-1"] .group-label')).toBeTruthy())
    ;(document.querySelector('[data-id="group-1"] .group-label') as HTMLElement).click()
    await tick()

    ;(document.querySelector('button[title="缩放分组边界以适配其中节点"]') as HTMLButtonElement).click()
    await tick()
    expect(JSON.parse(h.setContent.mock.calls.at(-1)?.[1] as string).nodes[0]).toMatchObject({
      id: 'group-1', x: 4, y: -2, width: 192, height: 168,
    })

    const name = document.querySelector('.group-name-label input') as HTMLInputElement
    name.value = '新名称'
    name.dispatchEvent(new Event('input', { bubbles: true }))
    window.dispatchEvent(new CustomEvent('notemd:flush-doc', { detail: { tabId: 'other-tab' } }))
    expect(JSON.parse(h.setContent.mock.calls.at(-1)?.[1] as string).nodes[0]).not.toMatchObject({ label: '新名称' })
    window.dispatchEvent(new CustomEvent('notemd:flush-doc', { detail: { tabId: 'canvas-tab' } }))
    await tick()
    expect(JSON.parse(h.setContent.mock.calls.at(-1)?.[1] as string).nodes[0]).toMatchObject({ label: '新名称' })

    const style = document.querySelector('.group-style-label select') as HTMLSelectElement
    style.value = 'cover'
    style.dispatchEvent(new Event('change', { bubbles: true }))
    await tick()
    expect(JSON.parse(h.setContent.mock.calls.at(-1)?.[1] as string).nodes[0]).toMatchObject({ backgroundStyle: 'cover' })

    ;(document.querySelector('button[title="移除分组背景图片"]') as HTMLButtonElement).click()
    await tick()
    let saved = JSON.parse(h.setContent.mock.calls.at(-1)?.[1] as string)
    expect(saved.nodes[0]).not.toHaveProperty('background')
    expect(saved.nodes[0]).not.toHaveProperty('backgroundStyle')

    ;(document.querySelector('button[title="移除分组边框并保留其中节点"]') as HTMLButtonElement).click()
    await tick()
    saved = JSON.parse(h.setContent.mock.calls.at(-1)?.[1] as string)
    expect(saved.nodes).toEqual([expect.objectContaining({ id: 'inside', text: 'inside' })])
    expect((document.querySelector('button[aria-label^="撤销"]') as HTMLButtonElement).title).toContain('解散分组')
  })

  it('exposes working edge label, end, color and reconnect controls', async () => {
    component = mount(CanvasView as unknown as Parameters<typeof mount>[0], {
      target: document.body,
      props: { tab: tab() },
    })
    await vi.waitFor(() => expect(document.querySelector('.svelte-flow__edge[data-id="edge-1"]')).toBeTruthy())
    ;(document.querySelector('.svelte-flow__edge[data-id="edge-1"]') as SVGGElement)
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await tick()
    flushSync()

    expect(document.querySelectorAll('.canvas-edge-reconnect')).toHaveLength(2)
    const fromEnd = document.querySelector('button[title="切换连线起点箭头"]') as HTMLButtonElement
    const toEnd = document.querySelector('button[title="切换连线终点箭头"]') as HTMLButtonElement
    expect(fromEnd.getAttribute('aria-pressed')).toBe('false')
    expect(toEnd.getAttribute('aria-pressed')).toBe('true')
    fromEnd.click()
    await tick()
    toEnd.click()
    await tick()

    ;(document.querySelector('button[title="连线颜色 3"]') as HTMLButtonElement).click()
    await tick()
    const label = document.querySelector('.edge-label input') as HTMLInputElement
    label.value = '更新标签'
    label.dispatchEvent(new Event('input', { bubbles: true }))
    window.dispatchEvent(new CustomEvent('notemd:flush-doc', { detail: { tabId: 'canvas-tab' } }))
    await tick()

    const edge = JSON.parse(h.setContent.mock.calls.at(-1)?.[1] as string).edges[0]
    expect(edge).toMatchObject({ fromEnd: 'arrow', toEnd: 'none', color: '3', label: '更新标签' })
  })

  it('keeps popover keyboard activation out of Canvas edge and pan shortcuts', async () => {
    component = mount(CanvasView as unknown as Parameters<typeof mount>[0], {
      target: document.body,
      props: { tab: tab() },
    })
    await vi.waitFor(() => expect(document.querySelector('.svelte-flow__edge[data-id="edge-1"]')).toBeTruthy())
    ;(document.querySelector('.svelte-flow__edge[data-id="edge-1"]') as SVGGElement)
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await tick()

    const surface = document.querySelector('.canvas-surface') as HTMLElement
    const colorMenu = document.querySelector('summary[aria-label="颜色"]') as HTMLElement
    colorMenu.focus()
    colorMenu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    colorMenu.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }))
    await tick()

    expect(document.querySelector('.canvas-edge-label-content input')).toBeFalsy()
    expect(surface.classList.contains('tool-pan')).toBe(false)
  })

  it('keeps a delete control available when multiple edges are selected', async () => {
    const multiEdge = tab()
    multiEdge.currentContent = multiEdge.initialContent = JSON.stringify({
      nodes: [
        { id: 'a', type: 'text', text: 'a', x: 0, y: 0, width: 120, height: 100 },
        { id: 'b', type: 'text', text: 'b', x: 260, y: 0, width: 120, height: 100 },
        { id: 'c', type: 'text', text: 'c', x: 520, y: 0, width: 120, height: 100 },
      ],
      edges: [
        { id: 'edge-a', fromNode: 'a', toNode: 'b' },
        { id: 'edge-b', fromNode: 'b', toNode: 'c' },
      ],
    })
    component = mount(CanvasView as unknown as Parameters<typeof mount>[0], {
      target: document.body,
      props: { tab: multiEdge },
    })
    await vi.waitFor(() => expect(document.querySelectorAll('.svelte-flow__edge')).toHaveLength(2))

    ;(document.querySelector('.svelte-flow__edge[data-id="edge-a"]') as SVGGElement)
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', code: 'ControlLeft', ctrlKey: true, bubbles: true }))
    ;(document.querySelector('.svelte-flow__edge[data-id="edge-b"]') as SVGGElement)
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control', code: 'ControlLeft', bubbles: true }))
    await tick()
    flushSync()

    const context = document.querySelector('.canvas-context-toolbar[aria-label="连线操作"]') as HTMLElement
    expect(context).toBeTruthy()
    expect(context.textContent).toContain('2 条连线')
    expect(context.querySelector('summary[aria-label="颜色"]')).toBeFalsy()
    ;(context.querySelector('button[aria-label="删除选中内容"]') as HTMLButtonElement).click()
    await tick()

    const saved = JSON.parse(h.setContent.mock.calls.at(-1)?.[1] as string)
    expect(saved.nodes).toHaveLength(3)
    expect(saved.edges).toEqual([])
  })

  it('keeps automatically routed edge sides out of the saved canvas', async () => {
    const dynamicEdge = tab()
    dynamicEdge.currentContent = dynamicEdge.initialContent = JSON.stringify({
      nodes: [
        { id: 'a', type: 'text', text: 'a', x: 0, y: 0, width: 120, height: 100 },
        { id: 'b', type: 'text', text: 'b', x: 300, y: 0, width: 120, height: 100 },
      ],
      edges: [{ id: 'dynamic', fromNode: 'a', toNode: 'b' }],
    })
    component = mount(CanvasView as unknown as Parameters<typeof mount>[0], {
      target: document.body,
      props: { tab: dynamicEdge },
    })
    await vi.waitFor(() => expect(document.querySelector('.svelte-flow__edge[data-id="dynamic"]')).toBeTruthy())

    ;(document.querySelector('[data-id="a"]') as HTMLElement).click()
    await tick()
    ;(document.querySelector('.canvas-surface') as HTMLElement)
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    await tick()

    const edge = JSON.parse(h.setContent.mock.calls.at(-1)?.[1] as string).edges[0]
    expect(edge).toEqual({ id: 'dynamic', fromNode: 'a', toNode: 'b' })
  })

  it('edits an edge label inline by double-click or Enter', async () => {
    component = mount(CanvasView as unknown as Parameters<typeof mount>[0], {
      target: document.body,
      props: { tab: tab() },
    })
    await vi.waitFor(() => expect(document.querySelector('.svelte-flow__edge[data-id="edge-1"]')).toBeTruthy())
    const edge = document.querySelector('.svelte-flow__edge[data-id="edge-1"]') as SVGGElement
    edge.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await tick()
    expect(document.querySelectorAll('.canvas-edge-reconnect')).toHaveLength(2)

    ;(document.querySelector('.canvas-surface') as HTMLElement)
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await tick()
    let input = document.querySelector('.canvas-edge-label-content input') as HTMLInputElement
    expect(input).toBeTruthy()
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await tick()

    const labelButton = document.querySelector('.canvas-edge-label-content button') as HTMLButtonElement
    labelButton.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await tick()
    input = document.querySelector('.canvas-edge-label-content input') as HTMLInputElement
    expect(input.value).toBe('参考')
    input.value = '画布内标签'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new FocusEvent('blur', { bubbles: true }))
    await tick()
    expect(JSON.parse(h.setContent.mock.calls.at(-1)?.[1] as string).edges[0].label).toBe('画布内标签')
  })

  it('keeps desktop clipboard buttons functional through the Tauri fallback', async () => {
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('Web clipboard denied'))
    vi.spyOn(navigator.clipboard, 'readText').mockRejectedValue(new Error('Web clipboard denied'))
    component = mount(CanvasView as unknown as Parameters<typeof mount>[0], {
      target: document.body,
      props: { tab: tab() },
    })
    await vi.waitFor(() => expect(document.querySelector('[data-id="text-1"]')).toBeTruthy())
    ;(document.querySelector('[data-id="text-1"]') as HTMLElement).click()
    await tick()

    const copy = document.querySelector('button[title="复制选中内容"]') as HTMLButtonElement
    expect(copy.disabled).toBe(false)
    copy.click()
    await vi.waitFor(() => expect(h.clipboardWrite).toHaveBeenCalledOnce())
    expect(JSON.parse(h.clipboardWrite.mock.calls[0][0]).nodes).toEqual([
      expect.objectContaining({ id: 'text-1', type: 'text' }),
    ])

    h.clipboardRead.mockResolvedValue('https://example.org/from-clipboard')
    ;(document.querySelector('button[title="粘贴"]') as HTMLButtonElement).click()
    await vi.waitFor(() => {
      const saved = JSON.parse(h.setContent.mock.calls.at(-1)?.[1] as string)
      expect(saved.nodes).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'link', url: 'https://example.org/from-clipboard' }),
      ]))
    })
  })

  it('refuses an in-process cross-root paste instead of committing broken resource references', async () => {
    const decoded = decodeJsonCanvas(JSON.stringify({
      nodes: [{ id: 'file-1', type: 'file', file: 'assets/photo.png', x: 0, y: 0, width: 200, height: 120 }],
      edges: [],
    }))
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) return
    rememberCanvasClipboard({
      version: 1,
      nodes: decoded.document.nodes,
      edges: decoded.document.edges,
      sourceRoot: '/source-vault',
    }, 'cross-root-canvas')
    vi.spyOn(navigator.clipboard, 'readText').mockRejectedValue(new Error('Web clipboard denied'))
    h.clipboardRead.mockResolvedValue('cross-root-canvas')
    h.sotRoot = '/target-vault'
    const target = tab()
    target.filePath = '/target-vault/boards/demo.canvas'
    component = mount(CanvasView as unknown as Parameters<typeof mount>[0], {
      target: document.body,
      props: { tab: target },
    })
    await vi.waitFor(() => expect(document.querySelector('button[title="粘贴"]')).toBeTruthy())

    ;(document.querySelector('button[title="粘贴"]') as HTMLButtonElement).click()

    await vi.waitFor(() => expect(h.showError).toHaveBeenCalledWith(expect.stringContaining('暂不支持跨工作区')))
    expect(h.setContent).not.toHaveBeenCalled()
  })

  it('creates a text card by double-clicking the pane and zooms from the visible Flow control', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600)
    component = mount(CanvasView as unknown as Parameters<typeof mount>[0], {
      target: document.body,
      props: { tab: tab() },
    })
    await vi.waitFor(() => expect(document.querySelector('.svelte-flow__pane')).toBeTruthy())

    const pane = document.querySelector('.svelte-flow__pane') as HTMLElement
    pane.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 250, clientY: 220 }))
    await tick()
    expect(JSON.parse(h.setContent.mock.calls.at(-1)?.[1] as string).nodes).toHaveLength(3)

    const viewport = document.querySelector('.svelte-flow__viewport') as HTMLElement
    const before = viewport.style.transform
    const zoomIn = document.querySelector('.svelte-flow__controls-zoomin') as HTMLButtonElement
    const zoomOut = document.querySelector('.svelte-flow__controls-zoomout') as HTMLButtonElement
    const fitView = document.querySelector('.svelte-flow__controls-fitview') as HTMLButtonElement
    expect(zoomIn.disabled).toBe(false)
    expect(zoomOut.disabled).toBe(false)
    expect(fitView.disabled).toBe(false)
    zoomIn.click()
    await vi.waitFor(() => expect(viewport.style.transform).not.toBe(before))
    zoomOut.click()
    fitView.click()
  })

  it.each([
    { mode: 'pan', preselected: false }, { mode: 'pan', preselected: true },
    { mode: 'space', preselected: false }, { mode: 'space', preselected: true },
    { mode: 'lock', preselected: false }, { mode: 'lock', preselected: true },
  ])('disables node interaction during $mode navigation with preselection $preselected', async ({ mode, preselected }) => {
    h.storeGet.mockResolvedValue({ x: 0, y: 0, zoom: 1, updatedAt: 1 })
    const target = tab()
    const source = JSON.parse(SAMPLE)
    source.nodes.push({ id: 'unknown', type: 'future-node', x: 700, y: 0, width: 100, height: 100 })
    target.currentContent = target.initialContent = JSON.stringify(source)
    component = mount(CanvasView, { target: document.body, props: { tab: target } })
    await vi.waitFor(() => expect(document.querySelector('[data-id="unknown"]')).toBeTruthy())
    const surface = document.querySelector('.canvas-surface') as HTMLElement
    const node = document.querySelector('[data-id="text-1"]') as HTMLElement
    const diagnostic = document.querySelector('[data-id="unknown"]') as HTMLElement
    const interactiveClasses = ['draggable', 'selectable', 'nopan']
    for (const className of interactiveClasses) {
      expect(node.classList.contains(className)).toBe(true)
      expect(diagnostic.classList.contains(className)).toBe(false)
    }
    if (preselected) {
      const flow = document.querySelector('.svelte-flow') as HTMLElement
      const pane = document.querySelector('.svelte-flow__pane') as HTMLElement
      ResizeObserverStub.resize(flow, 1200, 800)
      pane.getBoundingClientRect = flow.getBoundingClientRect
      const pointer = { bubbles: true, pointerId: 87, pointerType: 'mouse', button: 0, isPrimary: true }
      pane.dispatchEvent(new PointerEvent('pointerdown', { ...pointer, clientX: 10, clientY: 10 }))
      pane.dispatchEvent(new PointerEvent('pointermove', { ...pointer, clientX: 650, clientY: 180 }))
      pane.dispatchEvent(new PointerEvent('pointerup', { ...pointer, clientX: 650, clientY: 180 }))
      await vi.waitFor(() => expect(document.querySelector('.svelte-flow__selection-wrapper')).toBeTruthy())
      expect(document.querySelectorAll('.svelte-flow__node.selected')).toHaveLength(2)
    }

    if (mode === 'lock') (document.querySelector('button[aria-label="锁定画布交互"]') as HTMLButtonElement).click()
    else surface.dispatchEvent(new KeyboardEvent('keydown', { key: mode === 'pan' ? 'p' : ' ', bubbles: true }))
    await tick()
    for (const className of interactiveClasses) {
      expect(node.classList.contains(className)).toBe(false)
      expect(diagnostic.classList.contains(className)).toBe(false)
    }

    node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, view: window, button: 0, clientX: 50, clientY: 50 }))
    window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, view: window, buttons: 1, clientX: 110, clientY: 90 }))
    await tick()
    window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, view: window, buttons: 1, clientX: 170, clientY: 130 }))
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, view: window, button: 0, clientX: 170, clientY: 130 }))
    await tick()
    // Flow suppresses the click immediately following a navigation drag.
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(h.setContent).not.toHaveBeenCalled()
    expect(node.classList.contains('selected')).toBe(preselected)

    if (mode === 'lock') (document.querySelector('button[aria-label="解锁画布交互"]') as HTMLButtonElement).click()
    else if (mode === 'space') window.dispatchEvent(new KeyboardEvent('keyup', { key: ' ' }))
    else surface.dispatchEvent(new KeyboardEvent('keydown', { key: 's', bubbles: true }))
    await tick()
    for (const className of interactiveClasses) {
      expect(node.classList.contains(className)).toBe(true)
      expect(diagnostic.classList.contains(className)).toBe(false)
    }
    node.click()
    await tick()
    expect(node.classList.contains('selected')).toBe(true)
  })

  it('exposes select/pan/lasso tools, Space pan and a view-only interaction lock', async () => {
    component = mount(CanvasView as unknown as Parameters<typeof mount>[0], {
      target: document.body,
      props: { tab: tab() },
    })
    await vi.waitFor(() => expect(document.querySelector('button[aria-label="自由套索工具"]')).toBeTruthy())
    const surface = document.querySelector('.canvas-surface') as HTMLElement

    surface.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', bubbles: true }))
    await tick()
    expect(surface.classList.contains('tool-lasso')).toBe(true)
    expect((document.querySelector('button[aria-label="自由套索工具"]') as HTMLButtonElement).classList.contains('tool-active')).toBe(true)

    surface.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
    await tick()
    expect(surface.classList.contains('tool-pan')).toBe(true)
    window.dispatchEvent(new KeyboardEvent('keyup', { key: ' ' }))
    await tick()
    expect(surface.classList.contains('tool-lasso')).toBe(true)

    surface.dispatchEvent(new KeyboardEvent('keydown', { key: 's', bubbles: true }))
    surface.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', metaKey: true, bubbles: true }))
    await tick()
    expect(document.querySelector('.selection-resizer')).toBeTruthy()

    ;(document.querySelector('button[title="临时锁定或解锁当前画布交互"]') as HTMLButtonElement).click()
    await tick()
    expect(surface.classList.contains('tool-pan')).toBe(true)
    expect(document.querySelector('.selection-resizer')).toBeFalsy()
    expect(document.body.textContent).toContain('解锁')
    expect(h.setContent).not.toHaveBeenCalled()
  })

  it('keeps Canvas shortcuts and native Select All out of focused controls', async () => {
    const grouped = tab()
    grouped.currentContent = grouped.initialContent = JSON.stringify({
      nodes: [
        { id: 'group-1', type: 'group', label: '分组', x: 0, y: 0, width: 300, height: 220 },
        { id: 'inside', type: 'text', text: 'inside', x: 40, y: 50, width: 120, height: 80 },
      ],
      edges: [],
    })
    component = mount(CanvasView as unknown as Parameters<typeof mount>[0], {
      target: document.body,
      props: { tab: grouped },
    })
    await vi.waitFor(() => expect(document.querySelector('[data-id="group-1"] .group-label')).toBeTruthy())
    ;(document.querySelector('[data-id="group-1"] .group-label') as HTMLElement).click()
    await tick()

    const input = document.querySelector('.group-name-label input') as HTMLInputElement
    input.focus()
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
    window.dispatchEvent(new CustomEvent('notemd:select-all'))
    await tick()

    expect(document.querySelector('[data-id="group-1"]')?.classList.contains('selected')).toBe(true)
    expect(document.querySelector('[data-id="inside"]')?.classList.contains('selected')).toBe(false)
    expect(document.querySelector('.canvas-surface')?.classList.contains('tool-pan')).toBe(false)
    expect(h.setContent).not.toHaveBeenCalled()
  })

  it('updates the untouched default tool for form-factor changes without overriding a user choice', async () => {
    component = mount(CanvasView as unknown as Parameters<typeof mount>[0], {
      target: document.body,
      props: { tab: tab() },
    })
    await vi.waitFor(() => expect(document.querySelector('button[aria-label="自由套索工具"]')).toBeTruthy())
    const surface = document.querySelector('.canvas-surface') as HTMLElement
    expect(surface.classList.contains('tool-pan')).toBe(false)

    formFactor.value = 'phone'
    await tick()
    expect(surface.classList.contains('tool-pan')).toBe(true)

    ;(document.querySelector('button[aria-label="自由套索工具"]') as HTMLButtonElement).click()
    formFactor.value = 'desktop'
    await tick()
    expect(surface.classList.contains('tool-lasso')).toBe(true)
  })

  it('supports application zoom shortcuts and compact semantic zoom', async () => {
    h.storeGet.mockResolvedValue({ x: 0, y: 0, zoom: 1, updatedAt: 1 })
    component = mount(CanvasView as unknown as Parameters<typeof mount>[0], {
      target: document.body,
      props: { tab: tab() },
    })
    await vi.waitFor(() => expect(document.querySelector('.zoom-indicator')?.textContent).toContain('100%'))
    const surface = document.querySelector('.canvas-surface') as HTMLElement
    for (let index = 0; index < 6; index++) {
      surface.dispatchEvent(new KeyboardEvent('keydown', { key: '-', metaKey: true, bubbles: true }))
    }
    await tick()
    expect(surface.classList.contains('lod-compact')).toBe(true)
    expect((document.querySelector('.compact-label') as HTMLElement).textContent).toContain('画布卡片')

    surface.dispatchEvent(new KeyboardEvent('keydown', { key: '0', metaKey: true, bubbles: true }))
    await tick()
    expect(surface.classList.contains('lod-compact')).toBe(false)
    expect(document.querySelector('.zoom-indicator')?.textContent).toContain('100%')
  })

  it('aligns and distributes a multi-selection as one undoable document command', async () => {
    const arranged = tab()
    arranged.currentContent = arranged.initialContent = JSON.stringify({
      nodes: [
        { id: 'a', type: 'text', text: 'a', x: 0, y: 0, width: 200, height: 120 },
        { id: 'b', type: 'text', text: 'b', x: 260, y: 40, width: 160, height: 100 },
        { id: 'c', type: 'text', text: 'c', x: 540, y: 80, width: 200, height: 120 },
      ],
      edges: [],
    })
    component = mount(CanvasView as unknown as Parameters<typeof mount>[0], {
      target: document.body,
      props: { tab: arranged },
    })
    await vi.waitFor(() => expect(document.querySelectorAll('.svelte-flow__node')).toHaveLength(3))
    const surface = document.querySelector('.canvas-surface') as HTMLElement
    surface.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', metaKey: true, bubbles: true }))
    await tick()

    expect(document.querySelector('.selection-resizer')).toBeTruthy()
    ;(document.querySelector('button[aria-label="左对齐"]') as HTMLButtonElement).click()
    await tick()
    let nodes = JSON.parse(h.setContent.mock.calls.at(-1)?.[1] as string).nodes as Array<Record<string, unknown>>
    expect(nodes.map((node) => node.x)).toEqual([0, 0, 0])
    expect((document.querySelector('button[aria-label^="撤销"]') as HTMLButtonElement).title).toContain('对齐选中节点')

    ;(document.querySelector('button[aria-label^="撤销"]') as HTMLButtonElement).click()
    await tick()
    nodes = JSON.parse(h.setContent.mock.calls.at(-1)?.[1] as string).nodes as Array<Record<string, unknown>>
    expect(nodes.map((node) => node.x)).toEqual([0, 260, 540])

    ;(document.querySelector('button[aria-label="水平等距分布"]') as HTMLButtonElement).click()
    await tick()
    nodes = JSON.parse(h.setContent.mock.calls.at(-1)?.[1] as string).nodes as Array<Record<string, unknown>>
    expect(nodes.find((node) => node.id === 'b')?.x).toBe(290)

    const anchorBefore = { x: nodes[0].x, y: nodes[0].y, width: nodes[0].width }
    const rightBefore = Math.max(...nodes.map((node) => Number(node.x) + Number(node.width)))
    ;(document.querySelector('button[aria-label="缩放选区右下角"]') as HTMLButtonElement)
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }))
    await tick()
    nodes = JSON.parse(h.setContent.mock.calls.at(-1)?.[1] as string).nodes as Array<Record<string, unknown>>
    expect(Math.max(...nodes.map((node) => Number(node.x) + Number(node.width)))).toBeGreaterThan(rightBefore)
    expect(nodes[0]).toMatchObject({ x: anchorBefore.x, y: anchorBefore.y })
    expect(Number(nodes[0].width)).toBeGreaterThan(Number(anchorBefore.width))
  })

  it('moves the multi-selection frame with its preview and rolls back pointer cancellation', async () => {
    h.storeGet.mockResolvedValue({ x: 0, y: 0, zoom: 1, updatedAt: 1 })
    component = mount(CanvasView as unknown as Parameters<typeof mount>[0], {
      target: document.body,
      props: { tab: tab() },
    })
    await vi.waitFor(() => expect(document.querySelectorAll('.svelte-flow__node')).toHaveLength(2))
    const surface = document.querySelector('.canvas-surface') as HTMLElement
    surface.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', metaKey: true, bubbles: true }))
    await tick()
    const handle = document.querySelector('button[aria-label="缩放选区右下角"]') as HTMLButtonElement
    const frame = document.querySelector('.selection-resizer') as HTMLElement
    const beforeWidth = Number.parseFloat(frame.style.width)

    handle.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, pointerId: 91, pointerType: 'mouse', button: 0, isPrimary: true,
      clientX: beforeWidth, clientY: 160,
    }))
    handle.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true, pointerId: 91, pointerType: 'mouse', isPrimary: true,
      clientX: beforeWidth + 120, clientY: 220,
    }))
    await tick()
    expect(Number.parseFloat((document.querySelector('.selection-resizer') as HTMLElement).style.width)).toBeGreaterThan(beforeWidth)
    expect(h.setContent).not.toHaveBeenCalled()

    handle.dispatchEvent(new PointerEvent('pointercancel', {
      bubbles: true, pointerId: 91, pointerType: 'mouse', isPrimary: true,
    }))
    await tick()
    expect(Number.parseFloat((document.querySelector('.selection-resizer') as HTMLElement).style.width)).toBe(beforeWidth)
    expect(h.setContent).not.toHaveBeenCalled()
  })

  it('renders the Huabu-style dock and contextual toolbar with standard multi-node color edits', async () => {
    component = mount(CanvasView as unknown as Parameters<typeof mount>[0], {
      target: document.body,
      props: { tab: tab() },
    })
    await vi.waitFor(() => expect(document.querySelector('.canvas-dock')).toBeTruthy())

    const dock = document.querySelector('.canvas-dock') as HTMLElement
    expect(dock.querySelectorAll(':scope > .dock-button').length).toBeGreaterThanOrEqual(10)
    expect(dock.querySelectorAll('svg').length).toBeGreaterThanOrEqual(10)
    expect(document.querySelector('.canvas-context-toolbar')).toBeFalsy()

    const surface = document.querySelector('.canvas-surface') as HTMLElement
    surface.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', metaKey: true, bubbles: true }))
    await tick()
    flushSync()

    const context = document.querySelector('.canvas-context-toolbar') as HTMLElement
    expect(context).toBeTruthy()
    expect(context.getAttribute('aria-label')).toBe('选区操作')
    expect(context.getAttribute('style')).toContain('left:')
    expect(context.querySelector('summary[aria-label="对齐与分布"]')).toBeTruthy()
    expect(context.querySelector('summary[aria-label="颜色"]')).toBeTruthy()
    expect([...context.querySelectorAll('.align-panel button')].every((button) => button.classList.contains('menu-row'))).toBe(true)

    const colorButton = context.querySelector('button[title="颜色 3"]') as HTMLButtonElement
    expect(colorButton.classList.contains('menu-row')).toBe(true)
    colorButton.click()
    await tick()
    const nodes = JSON.parse(h.setContent.mock.calls.at(-1)?.[1] as string).nodes as Array<Record<string, unknown>>
    expect(nodes.map((node) => node.color)).toEqual(['3', '3'])
  })

  it('repositions and clamps the contextual toolbar for viewport and surface size changes', async () => {
    h.storeGet.mockResolvedValue({ x: 120, y: 80, zoom: 2, updatedAt: 1 })
    component = mount(CanvasView as unknown as Parameters<typeof mount>[0], {
      target: document.body,
      props: { tab: tab() },
    })
    await vi.waitFor(() => expect(document.querySelector('.canvas-dock')).toBeTruthy())
    const surface = document.querySelector('.canvas-surface') as HTMLElement
    surface.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', metaKey: true, bubbles: true }))
    await tick()

    ResizeObserverStub.resize(surface, 800, 400)
    ResizeObserverStub.resize(document.querySelector('.canvas-context-toolbar')!, 328, 46)
    await tick()
    let context = document.querySelector('.canvas-context-toolbar') as HTMLElement
    expect(context.style.left).toBe('624px')
    expect(context.style.top).toBe('68px')

    ResizeObserverStub.resize(surface, 240, 120)
    ResizeObserverStub.resize(document.querySelector('.canvas-context-toolbar')!, 216, 92)
    await tick()
    context = document.querySelector('.canvas-context-toolbar') as HTMLElement
    expect(context.style.left).toBe('120px')
    expect(context.style.top).toBe('100px')
  })

  it('draws a freeform lasso and selects only intersecting nodes', async () => {
    h.storeGet.mockResolvedValue({ x: 0, y: 0, zoom: 1, updatedAt: 1 })
    component = mount(CanvasView as unknown as Parameters<typeof mount>[0], {
      target: document.body,
      props: { tab: tab() },
    })
    await vi.waitFor(() => expect(document.querySelector('.svelte-flow__pane')).toBeTruthy())
    const surface = document.querySelector('.canvas-surface') as HTMLElement
    const pane = document.querySelector('.svelte-flow__pane') as HTMLElement
    surface.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', bubbles: true }))
    await tick()

    pane.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, pointerId: 7, pointerType: 'mouse', button: 0, isPrimary: true, clientX: 5, clientY: 5,
    }))
    for (const [clientX, clientY] of [[280, 5], [280, 180], [5, 180]] as const) {
      surface.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true, pointerId: 7, pointerType: 'mouse', isPrimary: true, clientX, clientY,
      }))
    }
    await tick()
    expect(document.querySelector('.lasso-polygon')).toBeTruthy()
    surface.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true, pointerId: 7, pointerType: 'mouse', button: 0, isPrimary: true, clientX: 5, clientY: 5,
    }))
    await tick()

    expect(document.querySelector('[data-id="text-1"]')?.classList.contains('selected')).toBe(true)
    expect(document.querySelector('[data-id="link-1"]')?.classList.contains('selected')).toBe(false)
    expect(document.querySelector('.lasso-polygon')).toBeFalsy()
    expect(h.setContent).not.toHaveBeenCalled()
  })

  it('selects with a one-finger touch lasso', async () => {
    h.storeGet.mockResolvedValue({ x: 0, y: 0, zoom: 1, updatedAt: 1 })
    component = mount(CanvasView as unknown as Parameters<typeof mount>[0], {
      target: document.body,
      props: { tab: tab() },
    })
    await vi.waitFor(() => expect(document.querySelector('.svelte-flow__pane')).toBeTruthy())
    const surface = document.querySelector('.canvas-surface') as HTMLElement
    const pane = document.querySelector('.svelte-flow__pane') as HTMLElement
    surface.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', bubbles: true }))
    await tick()

    pane.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, pointerId: 27, pointerType: 'touch', button: 0, isPrimary: true, clientX: 5, clientY: 5,
    }))
    for (const [clientX, clientY] of [[280, 5], [280, 180], [5, 180]] as const) {
      surface.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true, pointerId: 27, pointerType: 'touch', isPrimary: true, clientX, clientY,
      }))
    }
    surface.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true, pointerId: 27, pointerType: 'touch', button: 0, isPrimary: true, clientX: 5, clientY: 5,
    }))
    await tick()

    expect(document.querySelector('[data-id="text-1"]')?.classList.contains('selected')).toBe(true)
    expect(document.querySelector('[data-id="link-1"]')?.classList.contains('selected')).toBe(false)
    expect(h.setContent).not.toHaveBeenCalled()
  })

  it('cancels a pending touch lasso and yields navigation to a second finger', async () => {
    component = mount(CanvasView as unknown as Parameters<typeof mount>[0], {
      target: document.body,
      props: { tab: tab() },
    })
    await vi.waitFor(() => expect(document.querySelector('.svelte-flow__pane')).toBeTruthy())
    const surface = document.querySelector('.canvas-surface') as HTMLElement
    const pane = document.querySelector('.svelte-flow__pane') as HTMLElement
    surface.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', bubbles: true }))
    await tick()

    pane.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, pointerId: 37, pointerType: 'touch', button: 0, isPrimary: true, clientX: 20, clientY: 20,
    }))
    pane.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, pointerId: 38, pointerType: 'touch', button: 0, isPrimary: false, clientX: 80, clientY: 80,
    }))
    await tick()
    expect(document.querySelector('.lasso-polygon')).toBeFalsy()
    expect(pane.classList.contains('draggable')).toBe(true)

    for (const pointerId of [37, 38]) {
      surface.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true, pointerId, pointerType: 'touch', button: 0, isPrimary: pointerId === 37,
      }))
    }
    await tick()
    expect(pane.classList.contains('draggable')).toBe(false)
  })

  it('places shortcut, toolbar and pasted nodes at the last pointer position', async () => {
    h.storeGet.mockResolvedValue({ x: 0, y: 0, zoom: 1, updatedAt: 1 })
    component = mount(CanvasView as unknown as Parameters<typeof mount>[0], {
      target: document.body,
      props: { tab: tab() },
    })
    await vi.waitFor(() => expect(document.querySelector('.svelte-flow__pane')).toBeTruthy())
    const surface = document.querySelector('.canvas-surface') as HTMLElement
    const pane = document.querySelector('.svelte-flow__pane') as HTMLElement
    surface.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true, pointerId: 3, pointerType: 'mouse', isPrimary: true, clientX: 700, clientY: 500,
    }))
    surface.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true }))
    pane.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 700, clientY: 500 }))
    await tick()

    let nodes = JSON.parse(h.setContent.mock.calls.at(-1)?.[1] as string).nodes as Array<Record<string, unknown>>
    expect(nodes.at(-1)).toMatchObject({ type: 'text', x: 560, y: 410 })

    const addText = document.querySelector('button[title="新建文本卡片"]') as HTMLButtonElement
    addText.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, pointerId: 4, pointerType: 'mouse', button: 0, isPrimary: true, clientX: 20, clientY: 20,
    }))
    addText.click()
    await tick()
    nodes = JSON.parse(h.setContent.mock.calls.at(-1)?.[1] as string).nodes as Array<Record<string, unknown>>
    expect(nodes.at(-1)).toMatchObject({ type: 'text', x: 560, y: 410 })

    ;(document.querySelector('button[title="新建链接卡片"]') as HTMLButtonElement).click()
    await submitCanvasInput('https://example.org/toolbar')
    await tick()
    nodes = JSON.parse(h.setContent.mock.calls.at(-1)?.[1] as string).nodes as Array<Record<string, unknown>>
    expect(nodes.at(-1)).toMatchObject({
      type: 'link', url: 'https://example.org/toolbar', x: 560, y: 410,
    })

    const pasteEvent = new ClipboardEvent('paste', { bubbles: true })
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: { getData: () => 'pointer paste' },
    })
    surface.dispatchEvent(pasteEvent)
    await tick()
    nodes = JSON.parse(h.setContent.mock.calls.at(-1)?.[1] as string).nodes as Array<Record<string, unknown>>
    expect(nodes.at(-1)).toMatchObject({ type: 'text', text: 'pointer paste', x: 560, y: 410 })
  })

  it('does not move the remembered insertion point when using the contextual toolbar', async () => {
    h.storeGet.mockResolvedValue({ x: 0, y: 0, zoom: 1, updatedAt: 1 })
    component = mount(CanvasView as unknown as Parameters<typeof mount>[0], {
      target: document.body,
      props: { tab: tab() },
    })
    await vi.waitFor(() => expect(document.querySelector('[data-id="text-1"]')).toBeTruthy())
    const surface = document.querySelector('.canvas-surface') as HTMLElement
    surface.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true, pointerId: 23, pointerType: 'mouse', isPrimary: true, clientX: 700, clientY: 500,
    }))
    ;(document.querySelector('[data-id="text-1"]') as HTMLElement).click()
    await tick()

    const copy = document.querySelector('button[title="复制选中内容"]') as HTMLButtonElement
    copy.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, pointerId: 24, pointerType: 'mouse', button: 0, isPrimary: true, clientX: 20, clientY: 20,
    }))
    ;(document.querySelector('button[title="新建文本卡片"]') as HTMLButtonElement).click()
    await tick()

    const nodes = JSON.parse(h.setContent.mock.calls.at(-1)?.[1] as string).nodes as Array<Record<string, unknown>>
    expect(nodes.at(-1)).toMatchObject({ type: 'text', x: 560, y: 410 })
  })

  it('creates and edits links through a visible dialog, validates input and cancels without writes', async () => {
    const nativePrompt = vi.fn(() => { throw new Error('unavailable in WebView') })
    vi.stubGlobal('prompt', nativePrompt)
    component = mount(CanvasView, { target: document.body, props: { tab: tab() } })
    await vi.waitFor(() => expect(document.querySelector('.canvas-dock')).toBeTruthy())
    ;(document.querySelector('button[aria-label="新建链接卡片"]') as HTMLButtonElement).click()
    await submitCanvasInput('javascript:alert(1)')
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('http://')
    expect(h.setContent).not.toHaveBeenCalled()
    await submitCanvasInput('https://example.org/new')
    expect(document.querySelector('dialog')).toBeNull()
    expect(JSON.parse(h.setContent.mock.calls.at(-1)![1]).nodes.at(-1).url).toBe('https://example.org/new')

    ;(document.querySelector('button[aria-label="编辑链接"]') as HTMLButtonElement).click()
    await submitCanvasInput('https://example.org/edited')
    expect(JSON.parse(h.setContent.mock.calls.at(-1)![1]).nodes.at(-1).url).toBe('https://example.org/edited')
    h.setContent.mockClear()
    ;(document.querySelector('button[aria-label="围绕选中节点创建分组"]') as HTMLButtonElement).click()
    await tick()
    document.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true }))
    await tick()
    expect(document.querySelector('dialog')).toBeNull()
    expect(h.setContent).not.toHaveBeenCalled()
    expect(nativePrompt).not.toHaveBeenCalled()
  })

  it('cleans up touch resize before a subsequent one-finger lasso', async () => {
    h.storeGet.mockResolvedValue({ x: 0, y: 0, zoom: 1, updatedAt: 1 })
    component = mount(CanvasView, { target: document.body, props: { tab: tab() } })
    await vi.waitFor(() => expect(document.querySelector('.svelte-flow__pane')).toBeTruthy())
    const surface = document.querySelector('.canvas-surface') as HTMLElement
    surface.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', metaKey: true, bubbles: true }))
    await tick()
    const handle = document.querySelector('.resize-handle.br') as HTMLElement
    for (const type of ['pointerdown', 'pointerup']) {
      handle.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 101, pointerType: 'touch', isPrimary: true, clientX: 600, clientY: 160 }))
    }
    surface.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', bubbles: true }))
    await tick()
    const pane = document.querySelector('.svelte-flow__pane') as HTMLElement
    pane.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 102, pointerType: 'touch', isPrimary: true, clientX: 5, clientY: 5 }))
    await tick()
    expect(pane.classList.contains('draggable')).toBe(false)
    for (const [clientX, clientY] of [[280, 5], [280, 180], [5, 180]]) {
      surface.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 102, pointerType: 'touch', isPrimary: true, clientX, clientY }))
    }
    surface.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 102, pointerType: 'touch', isPrimary: true, clientX: 5, clientY: 5 }))
    await tick()
    expect(document.querySelector('[data-id="text-1"]')?.classList.contains('selected')).toBe(true)
    expect(document.querySelector('[data-id="link-1"]')?.classList.contains('selected')).toBe(false)
  })

  it('cancels a focused resize with Escape and leaves node dragging enabled', async () => {
    component = mount(CanvasView, { target: document.body, props: { tab: tab() } })
    await vi.waitFor(() => expect(document.querySelector('.svelte-flow__pane')).toBeTruthy())
    const surface = document.querySelector('.canvas-surface') as HTMLElement
    surface.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', metaKey: true, bubbles: true }))
    await tick()
    const handle = document.querySelector('.resize-handle.br') as HTMLElement
    handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 111, pointerType: 'mouse', isPrimary: true, clientX: 600, clientY: 160 }))
    handle.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 111, pointerType: 'mouse', isPrimary: true, clientX: 900, clientY: 300 }))
    handle.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }))
    await tick()
    handle.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 111, pointerType: 'mouse', isPrimary: true, clientX: 900, clientY: 300 }))
    await tick()
    expect(h.setContent).not.toHaveBeenCalled()
    expect(document.querySelector('[data-id="text-1"]')?.classList.contains('draggable')).toBe(true)
  })

  it('prevents document mutations while locked and resumes editing after unlocking', async () => {
    component = mount(CanvasView, { target: document.body, props: { tab: tab() } })
    await vi.waitFor(() => expect(document.querySelector('.canvas-dock')).toBeTruthy())
    const surface = document.querySelector('.canvas-surface') as HTMLElement
    surface.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', metaKey: true, bubbles: true }))
    ;(document.querySelector('button[aria-label="锁定画布交互"]') as HTMLButtonElement).click()
    await tick()
    for (const key of ['ArrowRight', 'Delete', 'Enter']) surface.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
    ;(document.querySelector('[data-id="text-1"] .canvas-card') as HTMLElement).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await tick()
    expect(h.setContent).not.toHaveBeenCalled()
    expect(document.querySelector('.embedded-markdown')).toBeNull()
    expect((document.querySelector('button[aria-label="新建文本卡片"]') as HTMLButtonElement).disabled).toBe(true)
    ;(document.querySelector('button[aria-label="解锁画布交互"]') as HTMLButtonElement).click()
    await tick()
    ;(document.querySelector('button[aria-label="新建文本卡片"]') as HTMLButtonElement).click()
    await tick()
    expect(JSON.parse(h.setContent.mock.calls.at(-1)![1]).nodes).toHaveLength(3)
  })

  it('handles native copy, cut and history events without intercepting input fields', async () => {
    component = mount(CanvasView, { target: document.body, props: { tab: tab() } })
    await vi.waitFor(() => expect(document.querySelector('[data-id="text-1"]')).toBeTruthy())
    const surface = document.querySelector('.canvas-surface') as HTMLElement
    surface.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', metaKey: true, bubbles: true }))
    await tick()
    const setData = vi.fn()
    const copy = new ClipboardEvent('copy', { bubbles: true, cancelable: true })
    Object.defineProperty(copy, 'clipboardData', { value: { setData } })
    surface.dispatchEvent(copy)
    expect(copy.defaultPrevented).toBe(true)
    expect(JSON.parse(setData.mock.calls[0][1]).nodes).toHaveLength(2)
    expect(h.setContent).not.toHaveBeenCalled()
    const cut = new ClipboardEvent('cut', { bubbles: true, cancelable: true })
    Object.defineProperty(cut, 'clipboardData', { value: { setData } })
    surface.dispatchEvent(cut)
    await tick()
    expect(JSON.parse(h.setContent.mock.calls.at(-1)![1]).nodes).toEqual([])
    surface.dispatchEvent(new InputEvent('beforeinput', { inputType: 'historyUndo', bubbles: true, cancelable: true }))
    await tick()
    expect(JSON.parse(h.setContent.mock.calls.at(-1)![1]).nodes).toHaveLength(2)
    surface.dispatchEvent(new InputEvent('beforeinput', { inputType: 'historyRedo', bubbles: true, cancelable: true }))
    await tick()
    expect(JSON.parse(h.setContent.mock.calls.at(-1)![1]).nodes).toEqual([])

    ;(document.querySelector('button[aria-label="新建链接卡片"]') as HTMLButtonElement).click()
    await tick()
    const input = document.querySelector('dialog input') as HTMLInputElement
    const native = new InputEvent('beforeinput', { inputType: 'historyUndo', bubbles: true, cancelable: true })
    input.dispatchEvent(native)
    expect(native.defaultPrevented).toBe(false)
  })

  it('opens a popover with the keyboard and Escape returns focus without changing the selection', async () => {
    component = mount(CanvasView, { target: document.body, props: { tab: tab() } })
    await vi.waitFor(() => expect(document.querySelector('[data-id="text-1"]')).toBeTruthy())
    ;(document.querySelector('[data-id="text-1"]') as HTMLElement).click()
    await tick()
    const summary = document.querySelector('summary[aria-label="颜色"]') as HTMLElement
    const details = summary.parentElement as HTMLDetailsElement
    summary.focus()
    summary.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    expect(details.open).toBe(true)
    expect(document.activeElement).toBe(details.querySelector('button'))
    ;(document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(details.open).toBe(false)
    expect(document.activeElement).toBe(summary)
    expect(h.setContent).not.toHaveBeenCalled()
  })

  it('places a toolbar-imported file at the remembered flow coordinate', async () => {
    h.storeGet.mockResolvedValue({ x: 100, y: 50, zoom: 2, updatedAt: 1 })
    h.openDialog.mockResolvedValue('/tmp/import.png')
    h.invoke.mockImplementation(async (command: string) => command === 'canvas_resource_import'
      ? { relativePath: 'assets/import.png', canonicalPath: '/vault/assets/import.png', size: 12 }
      : null)
    component = mount(CanvasView, { target: document.body, props: { tab: tab() } })
    await vi.waitFor(() => expect(document.querySelector('.canvas-dock')).toBeTruthy())
    const surface = document.querySelector('.canvas-surface') as HTMLElement
    surface.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 31, pointerType: 'mouse', isPrimary: true, clientX: 700, clientY: 500 }))
    const button = document.querySelector('button[aria-label="添加文件或图片"]') as HTMLButtonElement
    button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 32, pointerType: 'mouse', isPrimary: true, clientX: 40, clientY: 30 }))
    button.focus()
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 40, clientY: 30 }))
    await vi.waitFor(() => expect(h.setContent).toHaveBeenCalled())
    expect(JSON.parse(h.setContent.mock.calls.at(-1)![1]).nodes.at(-1)).toMatchObject({
      type: 'file', file: 'assets/import.png', x: 160, y: 135,
    })
  })

  it('cuts the copied selection even if focus changes while the clipboard is pending', async () => {
    let copied!: () => void
    vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(() => new Promise<void>((resolve) => { copied = resolve }))
    component = mount(CanvasView, { target: document.body, props: { tab: tab() } })
    await vi.waitFor(() => expect(document.querySelector('[data-id="text-1"]')).toBeTruthy())
    ;(document.querySelector('[data-id="text-1"]') as HTMLElement).click()
    await tick()
    ;(document.querySelector('button[aria-label="剪切选中内容"]') as HTMLButtonElement).click()
    ;(document.querySelector('[data-id="link-1"]') as HTMLElement).click()
    await tick()
    copied()
    await vi.waitFor(() => expect(h.setContent).toHaveBeenCalled())
    expect(JSON.parse(h.setContent.mock.calls.at(-1)![1]).nodes.map((node: { id: string }) => node.id)).toEqual(['link-1'])
  })

  it('fails closed for malformed JSON and never rewrites the tab', async () => {
    const broken = tab()
    broken.currentContent = broken.initialContent = '{"nodes":['
    component = mount(CanvasView as unknown as Parameters<typeof mount>[0], {
      target: document.body,
      props: { tab: broken },
    })
    await tick()
    expect(document.body.textContent).toContain('无法编辑这个画布')
    expect(h.setContent).not.toHaveBeenCalled()
  })

  it('uses a containing Folder View root when the Canvas is outside the SOT Vault', async () => {
    h.sotRoot = '/other-vault'
    h.folderRoot = '/workspace'
    h.invoke.mockResolvedValue(Uint8Array.from([1, 137, 80, 78, 71]).buffer)
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:group-background')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const withBackground = tab()
    withBackground.filePath = '/workspace/boards/demo.canvas'
    withBackground.currentContent = withBackground.initialContent = JSON.stringify({
      nodes: [{
        id: 'group-1', type: 'group', x: 0, y: 0, width: 300, height: 200,
        label: '背景', background: 'assets/background.png', backgroundStyle: 'cover',
      }],
      edges: [],
    })

    component = mount(CanvasView as unknown as Parameters<typeof mount>[0], {
      target: document.body,
      props: { tab: withBackground },
    })

    await vi.waitFor(() => expect(h.invoke).toHaveBeenCalledWith('canvas_resource_read', {
      root: '/workspace', target: '/workspace/assets/background.png',
    }))
    await vi.waitFor(() => {
      const background = document.querySelector('.group-background') as HTMLElement | null
      expect(background?.style.backgroundImage).toContain('blob:group-background')
      expect(background?.classList.contains('cover')).toBe(true)
    })
  })

  it('imports a native multi-file drop in one document transaction', async () => {
    h.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'canvas_resource_import') {
        const name = String(args?.sourcePath).split('/').at(-1)
        return {
          relativePath: `demo_files/${name}`,
          canonicalPath: `/vault/boards/demo_files/${name}`,
          size: 12,
        }
      }
      throw new Error(`unexpected command: ${command}`)
    })
    component = mount(CanvasView as unknown as Parameters<typeof mount>[0], {
      target: document.body,
      props: { tab: tab() },
    })
    await tick()
    window.dispatchEvent(new CustomEvent('notemd:canvas-native-drop', {
      detail: {
        tabId: 'canvas-tab', paths: ['/tmp/archive.zip', '/tmp/notes.txt'], position: { x: 100, y: 100 },
      },
    }))

    await vi.waitFor(() => expect(h.invoke).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => {
      const serialized = h.setContent.mock.calls.at(-1)?.[1] as string
      expect(JSON.parse(serialized).nodes).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'file', file: 'demo_files/archive.zip' }),
        expect.objectContaining({ type: 'file', file: 'demo_files/notes.txt' }),
      ]))
    })
    expect(h.setContent).toHaveBeenCalledOnce()
    ;(document.querySelector('button[aria-label^="撤销"]') as HTMLButtonElement).click()
    await tick()
    expect(JSON.parse(h.setContent.mock.calls.at(-1)?.[1] as string).nodes).toHaveLength(2)
  })

  it('resolves a file node through backend containment before opening it', async () => {
    const withFile = tab()
    withFile.currentContent = withFile.initialContent = JSON.stringify({
      nodes: [{
        id: 'file-1', type: 'file', file: 'assets/archive.canvas',
        x: 0, y: 0, width: 260, height: 160,
      }],
      edges: [],
    })
    h.invoke.mockResolvedValue({ canonicalPath: '/vault/assets/archive.canvas' })
    component = mount(CanvasView as unknown as Parameters<typeof mount>[0], {
      target: document.body,
      props: { tab: withFile },
    })
    await vi.waitFor(() => expect(document.querySelector('.canvas-card')).toBeTruthy())

    ;(document.querySelector('.canvas-card') as HTMLElement).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))

    await vi.waitFor(() => expect(h.invoke).toHaveBeenCalledWith('canvas_resource_resolve', {
      root: '/vault', target: '/vault/assets/archive.canvas',
    }))
    await vi.waitFor(() => expect(h.openFile).toHaveBeenCalledWith('/vault/assets/archive.canvas'))
  })
})
