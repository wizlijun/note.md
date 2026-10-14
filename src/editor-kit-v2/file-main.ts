import { createEditor, type MorayaEditorInstance } from '@moraya/core'
import { Plugin, type Transaction } from 'prosemirror-state'
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view'
import type { Schema } from 'prosemirror-model'
import type { MountFileEditorOptions, MountedFileEditor, FileEditorOwner, FilePolicy, FileInput, FileSnapshot, ObserverDelta } from './file-contract'
import type { DecorationItem, EditorCommand, StructuralCommand } from './contract'
import { createFileController, type FileController } from './file-controller'
import { withBlockIdentitySchema } from './identity'
import { createFileResize } from './file-resize'
import { commandFor } from './commands'
import { attachFileSourceInput, type FileSourceInput, type FileSourceOptions } from './file-source-input'
import { noteUi, type NoteEditState } from '../lib/note-anno/note-ui.svelte'
import { finishNoteEdit, insertNoteRich, openEditForAnchor, openEditForMark, type NoteEditAdmission } from '../lib/note-anno/note-commands'
import { noteBadgePlugin } from '../lib/note-anno/note-plugin'
import { placeholderPlugin } from '../lib/placeholder-plugin'
import { createImeGuard, guardRichEditor, type ImeGuard } from '../lib/ime'
import { autoPairInsert } from '../lib/autopair'
import { renderSourceHtml } from '../lib/source-highlight'
import { bindFileHistoryFocus, refreshFileHistoryRoute } from '../lib/file-history-focus'
import { injectKitCss } from './file-kit-styles'

/** Desktop-only callers assemble these dependencies; this module stays pure. */
export interface FileMountWiring {
  plugins?: Plugin[]
  onDelta?: (delta: ObserverDelta) => void
  externalSource?: boolean
  imeGuard?: ImeGuard
}
export interface FileMountSession extends MountedFileEditor {
  closeIfSaved(expected: { identity: object; raw: string }): Promise<void>
  readonly baselineIdentity: object
  readonly view: EditorView
  attachSource(textarea: HTMLTextAreaElement, options?: FileSourceOptions): FileSourceInput
  attach(container: HTMLElement): void
  flushForDetach(): Promise<FileSnapshot>
  insertSlashNote(seed?: string): boolean
  insertSlashAttachment(kind: 'image' | 'file', href: string): boolean
}

export function mountFileEditor(container: HTMLElement, options: MountFileEditorOptions): Promise<MountedFileEditor>
export function mountFileEditor(container: HTMLElement, options: MountFileEditorOptions, wiring: FileMountWiring): Promise<FileMountSession>
export async function mountFileEditor(container: HTMLElement, options: MountFileEditorOptions, wiring: FileMountWiring = {}): Promise<FileMountSession> {
  if (!options.adapters?.mediaResolver) throw new TypeError('file editor requires an explicit mediaResolver')
  if (!wiring.externalSource) injectKitCss()
  const root = document.createElement('div'), rich = document.createElement('div')
  root.className = wiring.externalSource ? 'file-editor' : 'file-editor kit-host'; root.style.cssText = 'position:relative;width:100%;height:100%;min-height:0'
  rich.className = 'file-rich'; root.append(rich)
  container.append(root)
  let controller: FileController
  let instance: MorayaEditorInstance
  let schema: Schema
  let basePlugins: Plugin[] = []
  let source: FileSourceInput | undefined
  let unbindRichHistory = () => {}, unbindSourceHistory = () => {}
  let pane: HTMLElement | undefined
  let mode: 'rich' | 'source' = 'rich'
  let closed = false, detached = false, readOnly = options.readOnly ?? false
  let richComposing = false, richFrame: number | null = null
  let policy = options.policy
  let ownedEdit: NoteEditState | undefined
  const layers = new Map<string, readonly DecorationItem[]>()
  const listeners = new Set<(value: FileSnapshot) => void>()
  const richWaiters: { resolve(): void; reject(error: Error): void }[] = []
  const ids = options.ids ?? { blockId: () => crypto.randomUUID(), lineage: () => crypto.randomUUID(), tableId: () => crypto.randomUUID() }
  const ime = wiring.imeGuard ?? createImeGuard()
  function flushNote(): boolean {
    if (!ownedEdit || noteUi.edit !== ownedEdit) { ownedEdit = undefined; return true }
    return ownedEdit.flushDraft?.() !== false
  }
  function finishOwnedEdit() {
    if (ownedEdit && noteUi.edit === ownedEdit) noteUi.edit = null
    ownedEdit = undefined
  }
  function blocked(): string | null {
    if (closed) return 'file-closed'
    if (richComposing || source?.composing()) return 'composing'
    if (source?.pending()) return source.pending()!.reason
    if (!flushNote()) return 'annotation-pending'
    return null
  }
  function command(command: EditorCommand | StructuralCommand, execute: boolean): boolean {
    if (closed || richComposing || source?.composing() || source?.pending()) return false
    if (command.kind === 'undo' || command.kind === 'redo') return controller.runHistory(command.kind, execute)
    if (command.kind.startsWith('block.')) {
      const prepared = controller.prepareStructural(command as StructuralCommand)
      return prepared.ok && (execute ? controller.dispatch(prepared.tr) : controller.probe(prepared.tr))
    }
    let tr: Transaction | undefined
    const handled = commandFor(command as EditorCommand, controller.state)?.(controller.state, value => { tr = value }, controller.view ?? undefined)
    return !!handled && !!tr && (execute ? controller.dispatch(tr) : controller.probe(tr))
  }
  const owner: FileEditorOwner = {
    snapshot: () => controller.snapshot(),
    replaceSource: input => closed || richComposing ? { ok: false, reason: closed ? 'file-closed' : 'composing' } : controller.replaceSource(input),
    execute: value => command(value, true), canExecute: value => command(value, false),
    executeSlash: value => !blocked() && controller.executeSlashCommand(value, true),
    canExecuteSlash: value => !closed && !richComposing && !source?.pending() && controller.executeSlashCommand(value, false),
    undo: () => command({ kind: 'undo' }, true), redo: () => command({ kind: 'redo' }, true),
    canUndo: () => command({ kind: 'undo' }, false), canRedo: () => command({ kind: 'redo' }, false),
    restoreContent: raw => closed || richComposing || source?.composing() || source?.pending()
      ? { ok: false, reason: 'file-input-pending' } : controller.restoreContent(raw),
    installBaseline(input, nextOptions) {
      const reason = blocked(); if (reason) return { ok: false, reason }
      const previous = controller, oldPolicy = policy
      const nextPolicy = nextOptions ? nextOptions.policy ?? undefined : policy
      try {
        const candidate = createController(input, nextPolicy)
        controller = candidate; policy = nextPolicy
        instance.view.updateState(candidate.state)
        candidate.bindView(detached ? null : instance.view)
        previous.bindView(null); unsubscribeController(); subscribeController()
        finishOwnedEdit()
        const value = candidate.snapshot(), subscribers = [...listeners]
        queueMicrotask(() => {
          if (closed) return
          for (const listener of subscribers) if (listeners.has(listener)) {
            try { listener(value) } catch (error) { console.error('File editor observer failed', error) }
          }
        })
        return { ok: true, changed: true, snapshot: candidate.snapshot() }
      } catch (error) {
        controller = previous; policy = oldPolicy
        instance.view.updateState(previous.state)
        previous.bindView(detached ? null : instance.view)
        return { ok: false, reason: error instanceof Error ? error.message : 'baseline-failed' }
      }
    },
    setReadOnly(value) { readOnly = value; controller.setReadOnly(value); instance.view.setProps({ editable: () => !readOnly }); if (pane) pane.querySelector('textarea')!.readOnly = readOnly },
    async flush() {
      if (closed) throw new Error('file-closed')
      if (richComposing) await new Promise<void>((resolve, reject) => richWaiters.push({ resolve, reject }))
      await source?.flush()
      if (!flushNote()) throw new Error('annotation-pending')
      return controller.snapshot()
    },
    observe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    close: () => close(),
  }
  async function close(expected?: { identity: object; raw: string }): Promise<void> {
    if (closed) return
    await owner.flush()
    if (expected && (controller !== expected.identity || controller.snapshot().raw !== expected.raw)) throw new Error('File changed while closing; saved content no longer matches')
    closed = true; unbindRichHistory(); unbindSourceHistory(); source?.detach(); unsubscribeController(); listeners.clear(); layers.clear()
    if (ownedEdit && noteUi.edit === ownedEdit) noteUi.edit = null
    controller.bindView(null); instance.destroy(); root.remove()
  }
  function createController(file: FileInput, nextPolicy?: FilePolicy): FileController {
    const resize = createFileResize(() => controller)
    const decoration = new Plugin({ props: { decorations(state) {
      const items = [...layers.values()].flat(), decorations: Decoration[] = []
      state.doc.forEach((node, pos) => {
        const selected = items.filter(item => item.blockId === node.attrs.cdrBlockId)
        if (selected.length) decorations.push(Decoration.node(pos, pos + node.nodeSize, {
          'data-cdr-decoration': 'true', 'data-cdr-kind': selected[0].kind, 'data-cdr-label': selected.map(item => item.label).join(' · '),
        }))
      })
      return DecorationSet.create(state.doc, decorations)
    }, nodeViews: { table: resize.nodeView } } })
    const result = createFileController({ raw: file.raw, authority: file.authority, recovery: file.recovery, schema, ids,
      plugins: [resize.plugin, decoration, ...basePlugins], policy: nextPolicy, onDelta: wiring.onDelta })
    result.setReadOnly(readOnly)
    return result
  }
  let unsubscribeController = () => {}
  function subscribeController() {
    unsubscribeController = controller.observe(value => {
      if (closed) return
      try { options.onChange?.(value) } catch (error) { console.error('File editor observer failed', error) }
      for (const listener of [...listeners]) if (listeners.has(listener)) {
        try { listener(value) } catch (error) { console.error('File editor observer failed', error) }
      }
    })
  }
  const pendingAdapters = new Set<() => void>()
  let mounting = true
  function acquired(handle: { destroy(): void }) {
    let live = true
    const destroy = () => {
      if (!live) return
      live = false; pendingAdapters.delete(destroy); handle.destroy()
    }
    if (mounting) pendingAdapters.add(destroy)
    return { destroy }
  }
  const frontmatter = options.adapters.frontmatterViewFactory, spreadsheet = options.adapters.spreadsheetViewFactory
  try {
    instance = guardRichEditor(rich, await createEditor({
      ...options.adapters, ...options.render, container: rich,
      ...(frontmatter ? { frontmatterViewFactory: { render(...args: Parameters<typeof frontmatter.render>) {
        const handle = frontmatter.render(...args)
        return handle ? acquired(handle) : undefined
      } } } : {}),
      ...(spreadsheet ? { spreadsheetViewFactory: { create(...args: Parameters<typeof spreadsheet.create>) {
        return acquired(spreadsheet.create(...args))
      } } } : {}),
      configureSchema: withBlockIdentitySchema,
      createState(finalSchema, plugins) {
        schema = finalSchema
        basePlugins = plugins.filter(plugin => {
          const key = (plugin as unknown as { key: string }).key
          return !key.startsWith('moraya-link-text$') && !key.startsWith('moraya-inline-code-convert$')
        })
        basePlugins.push(...(wiring.plugins ?? []))
        if (!wiring.plugins?.some(plugin => plugin.spec.key === noteBadgePlugin().spec.key)) basePlugins.push(noteBadgePlugin())
        if (options.placeholder) basePlugins.push(placeholderPlugin(options.placeholder))
        controller = createController(options.file, policy)
        return controller.state
      },
      dispatchTransaction(_view, tr) { controller.dispatch(tr) },
      enableHistory: true, enableTableResize: false,
    }), ime)
    controller!.bindView(instance.view)
    instance.view.setProps({ editable: () => !readOnly })
    subscribeController()
    mounting = false; pendingAdapters.clear()
  } catch (error) {
    mounting = false
    for (const destroy of [...pendingAdapters].reverse()) {
      try { destroy() } catch (cleanupError) { console.error('File editor adapter cleanup failed', cleanupError) }
    }
    root.remove(); throw error
  }
  function bindRichHistory() {
    unbindRichHistory()
    unbindRichHistory = bindFileHistoryFocus({ owner, element: instance.view.dom, kind: 'rich', identity: () => controller,
      available: () => !closed && !detached && mode === 'rich', capture: () => {
        const selection = instance.view.state.selection.getBookmark(), doc = instance.view.state.doc
        return () => { if (instance.view.state.doc !== doc) return; instance.view.focus(); instance.view.dispatch(instance.view.state.tr.setSelection(selection.resolve(doc))) }
      } })
  }
  bindRichHistory()
  rich.addEventListener('compositionstart', () => { richComposing = true; refreshFileHistoryRoute() }, true)
  rich.addEventListener('compositionend', () => {
    if (richFrame !== null) cancelAnimationFrame(richFrame)
    richFrame = requestAnimationFrame(() => {
      richFrame = null; richComposing = false; refreshFileHistoryRoute()
      for (const waiter of richWaiters.splice(0)) waiter.resolve()
    })
  }, true)
  rich.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && ['z', 'y'].includes(event.key.toLowerCase()) && (richComposing || ime.blocks(event))) {
      event.preventDefault(); event.stopImmediatePropagation()
    }
  }, true)
  function attachSource(textarea: HTMLTextAreaElement, callbacks: FileSourceOptions = {}) {
    const config = { ...callbacks, identity: () => controller, onCompositionChange: (value: boolean) => { controller.setComposing(value); callbacks.onCompositionChange?.(value); refreshFileHistoryRoute() } }
    if (source) source.bind(textarea, config)
    else source = attachFileSourceInput(textarea, owner, config)
    unbindSourceHistory()
    unbindSourceHistory = bindFileHistoryFocus({ owner, element: textarea, kind: 'source', identity: () => controller,
      available: () => !closed && !detached && mode === 'source', capture: () => {
        const start = textarea.selectionStart, end = textarea.selectionEnd, direction = textarea.selectionDirection
        return () => { textarea.focus(); textarea.setSelectionRange(start, end, direction) }
      } })
    return source
  }
  function sourcePane() {
    if (pane || wiring.externalSource) return
    pane = document.createElement('div'); pane.className = 'kit-source'
    const pre = document.createElement('pre'), textarea = document.createElement('textarea'), status = document.createElement('div')
    const layout = document.createElement('div'), editorArea = document.createElement('div')
    layout.style.cssText = 'height:100%;display:flex;flex-direction:column'
    editorArea.style.cssText = 'position:relative;flex:1;min-height:0'
    status.style.cssText = 'flex:none;padding:8px;white-space:normal;font:13px/1.5 system-ui;background:Canvas;color:CanvasText'
    pre.className = 'kit-source-hl'; textarea.className = 'kit-source-ta'; textarea.readOnly = readOnly
    const retry = document.createElement('button'), discard = document.createElement('button')
    retry.textContent = 'Retry save'; discard.textContent = 'Discard unsaved changes'
    const paint = () => {
      pre.innerHTML = renderSourceHtml(textarea.value, [], -1)
      const pending = source?.pending()
      status.hidden = !pending
      status.firstChild!.textContent = pending?.reason === 'stale-source' ? 'The document has changed. Copy your draft before discarding it.' : 'Changes have not been saved. You can edit or copy the text, then retry or discard.'
      retry.disabled = !!source?.composing() || pending?.reason === 'stale-source'; discard.disabled = !!source?.composing()
    }
    status.append(document.createElement('span'), retry, discard)
    editorArea.append(pre, textarea); layout.append(editorArea, status); pane.append(layout); root.append(pane)
    attachSource(textarea, { paint }); paint()
    retry.onclick = () => { source!.retry(); paint() }; discard.onclick = () => { source!.discard(); paint() }
    textarea.addEventListener('keydown', event => {
      if (source!.composing() || event.isComposing || event.keyCode === 229 || event.metaKey || event.ctrlKey || event.altKey || event.key.length !== 1 || textarea.selectionStart !== textarea.selectionEnd) return
      const position = textarea.selectionStart, pair = autoPairInsert(textarea.value, position, event.key)
      if (!pair) return
      event.preventDefault(); textarea.value = textarea.value.slice(0, position) + pair.insert + textarea.value.slice(position)
      textarea.setSelectionRange(position + pair.caret, position + pair.caret); source!.commitBuffer()
    })
    textarea.addEventListener('scroll', () => { pre.scrollTop = textarea.scrollTop; pre.scrollLeft = textarea.scrollLeft })
  }
  function admission(): NoteEditAdmission {
    const active = controller, view = instance.view
    let generation = active.snapshot().generation, valid = true
    const isCurrent = () => valid && !closed && !detached && mode === 'rich' && controller === active && instance.view === view && active.snapshot().generation === generation
    return { isCurrent, dispatch(tr) {
      if (!isCurrent() || richComposing) return false
      if (!active.dispatch(tr)) return false
      if (view.state.doc.eq(tr.doc)) generation = active.snapshot().generation
      else valid = false
      return true
    } }
  }
  const annotations = {
    insert(seed = '') {
      if (closed || detached || mode !== 'rich' || richComposing || !finishNoteEdit()) return false
      ownedEdit = insertNoteRich(instance.view, seed, admission())
      return !!ownedEdit
    },
    editAt(position: number) {
      if (closed || detached || mode !== 'rich' || richComposing) return false
      const before = controller.snapshot().generation
      if (!finishNoteEdit() || before !== controller.snapshot().generation || position < 0 || position > instance.view.state.doc.content.size) return false
      const coords = instance.view.coordsAtPos(position), rect = new DOMRect(coords.left, coords.top, 0, coords.bottom - coords.top)
      ownedEdit = instance.view.state.doc.nodeAt(position)?.type.name === 'note_anchor'
        ? openEditForAnchor(instance.view, position, rect, undefined, admission())
        : openEditForMark(instance.view, position, rect, undefined, admission())
      return !!ownedEdit
    },
  }
  return {
    owner, annotations, closeIfSaved: expected => close(expected), get baselineIdentity() { return controller }, get view() { return instance.view }, attachSource,
    async flushForDetach() { const value = await owner.flush(); finishOwnedEdit(); return value },
    insertSlashNote(seed = '') {
      const gate = admission(), state = instance.view.state, { $from, empty } = state.selection
      if (!empty || $from.parent.type.name !== 'paragraph' || !/^\/[a-zA-Z0-9一-龥]*$/.test($from.parent.textBetween(0, $from.parentOffset))) return false
      ownedEdit = insertNoteRich(instance.view, seed, gate, { from: $from.start(), to: $from.pos })
      return !!ownedEdit
    },
    insertSlashAttachment(kind, href) {
      if (closed || detached || mode !== 'rich' || blocked()) return false
      const state = instance.view.state, { $from, empty } = state.selection
      if (!empty || $from.parent.type.name !== 'paragraph' || !/^\/[a-zA-Z0-9一-龥]*$/.test($from.parent.textBetween(0, $from.parentOffset))) return false
      const node = kind === 'image' ? state.schema.nodes.image.create({ src: href, alt: '' })
        : state.schema.text(href.replace(/[?#].*$/, '').replace(/^.*[/\\]/, '') || href, [state.schema.marks.link.create({ href, title: null })])
      return controller.dispatch(state.tr.replaceRangeWith($from.start(), $from.pos, node).scrollIntoView())
    },
    async setMode(next) {
      if (closed) return false
      try { await owner.flush() } catch { return false }
      if (mode === next) return true
      if (ownedEdit && noteUi.edit === ownedEdit) noteUi.edit = null
      mode = next
      if (mode === 'source') sourcePane()
      rich.hidden = mode !== 'rich'; if (pane) pane.hidden = mode !== 'source'
      refreshFileHistoryRoute()
      return true
    },
    focus() { if (!closed && !detached) { if (mode === 'source') pane?.querySelector('textarea')?.focus(); else instance.view.focus() } },
    destroyView() {
      if (detached || closed) return
      unbindRichHistory(); unbindSourceHistory(); source?.detach(); controller.bindView(null); detached = true; root.remove()
      if (richFrame !== null) cancelAnimationFrame(richFrame)
      richFrame = null
      if (richComposing) { richComposing = false; for (const waiter of richWaiters.splice(0)) waiter.reject(new Error('composition-interrupted')) }
    },
    attach(target) { if (closed) throw new Error('file-closed'); target.append(root); detached = false; instance.view.updateState(controller.state); controller.bindView(instance.view); bindRichHistory(); if (pane) attachSource(pane.querySelector('textarea')!) },
    decorations: {
      setLayer(id, items) { if (closed) return; layers.set(id, items.map(item => ({ ...item }))); instance.view.updateState(controller.state) },
      removeLayer(id) { if (closed) return; layers.delete(id); instance.view.updateState(controller.state) },
    },
  }
}
