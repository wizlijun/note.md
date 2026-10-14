import type { FileEditorOwner, FileResult, FileSnapshot } from './file-contract'
import { diff, DiffLimitError } from '../lib/share-merge/diff'

type SourceOwner = Pick<FileEditorOwner, 'snapshot' | 'replaceSource' | 'observe' | 'undo' | 'redo'>
export type PendingSource = Readonly<{ value: string; baseGeneration: number; reason: string }>
export interface FileSourceOptions {
  paint?: () => void
  onPendingError?: (reason: string) => void
  onCompositionChange?: (value: boolean) => void
  identity?: () => object
}
export interface FileSourceInput {
  pending(): PendingSource | null
  composing(): boolean
  commitBuffer(): FileResult
  retry(): FileResult
  discard(): FileResult
  flush(): Promise<FileSnapshot>
  detach(): void
  bind(textarea: HTMLTextAreaElement, options?: FileSourceOptions): void
}

/** The browser textarea's LF projection is display-only, never raw authority. */
function displaySource(raw: string): string { return raw.replace(/\r\n?/g, '\n') }
function sourceFromDisplay(raw: string, next: string): string {
  const before = displaySource(raw)
  if (before === next) return raw
  const offsets = [0]
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '\r' && raw[i + 1] === '\n') i++
    offsets.push(i + 1)
  }
  const eol = /\r\n|\r|\n/.exec(raw)?.[0] ?? '\n'
  let result = '', position = 0
  for (const change of diff(before.split(''), next.split(''))) {
    result += raw.slice(position, offsets[change.b0]) + next.slice(change.s0, change.s1).replace(/\n/g, eol)
    position = offsets[change.b1]
  }
  return result + raw.slice(position)
}

export function attachFileSourceInput(textarea: HTMLTextAreaElement, owner: SourceOwner, options: FileSourceOptions = {}): FileSourceInput {
  let element: HTMLTextAreaElement | null = null
  let callbacks = options
  let installed = owner.snapshot()
  let identity = options.identity?.() ?? owner
  let value = displaySource(installed.raw)
  let selection: [number, number, 'forward' | 'backward' | 'none'] = [0, 0, 'none']
  let pending: PendingSource | null = null
  let composing = false
  let frame: number | null = null
  let unsubscribe: (() => void) | undefined
  let shortcut: 'undo' | 'redo' | null = null
  const waiters: { resolve(value: FileSnapshot): void; reject(error: Error): void }[] = []
  const unchanged = (): FileResult => ({ ok: true, changed: false, snapshot: owner.snapshot() })
  const paint = () => callbacks.paint?.()
  function read() {
    if (!element) return
    value = displaySource(element.value)
    selection = [element.selectionStart, element.selectionEnd, element.selectionDirection]
    if (pending) pending = Object.freeze({ ...pending, value })
  }
  function write() {
    if (element) {
      element.value = value
      element.setSelectionRange(Math.min(selection[0], value.length), Math.min(selection[1], value.length), selection[2])
    }
    paint()
  }
  function rejected(reason: string): FileResult {
    pending = Object.freeze({ value, baseGeneration: installed.generation, reason })
    callbacks.onPendingError?.(reason)
    paint()
    return { ok: false, reason }
  }
  function current() {
    const snapshot = owner.snapshot()
    return snapshot.authority === installed.authority && snapshot.generation === installed.generation
      && identity === (callbacks.identity?.() ?? owner)
  }
  function follow() {
    if (pending || composing) { paint(); return }
    // Content notifications are queued: always use the latest installed state.
    installed = owner.snapshot(); identity = callbacks.identity?.() ?? owner
    value = displaySource(installed.raw); write()
  }
  function submit(): FileResult {
    if (!current()) return rejected('stale-source')
    let raw: string
    try { raw = sourceFromDisplay(installed.raw, value) }
    catch (error) { if (error instanceof DiffLimitError) return rejected('source-diff-limit'); throw error }
    const result = owner.replaceSource({ expectedGeneration: installed.generation, value: raw })
    if (!result.ok) return rejected(result.reason)
    installed = result.snapshot; identity = callbacks.identity?.() ?? owner
    pending = null; value = displaySource(installed.raw); write()
    return result
  }
  function commitBuffer(): FileResult {
    read()
    if (composing) { paint(); return { ok: false, reason: 'composing' } }
    if (pending) { paint(); return { ok: false, reason: pending.reason } }
    return submit()
  }
  function settle() {
    for (const waiter of waiters.splice(0)) {
      if (pending) waiter.reject(new Error(pending.reason))
      else waiter.resolve(owner.snapshot())
    }
  }
  function start() {
    if (composing) return
    if (!pending) { installed = owner.snapshot(); identity = callbacks.identity?.() ?? owner }
    composing = true; callbacks.onCompositionChange?.(true); read(); paint()
  }
  function end() {
    if (!composing || frame !== null) return
    frame = requestAnimationFrame(() => {
      frame = null; read(); composing = false; callbacks.onCompositionChange?.(false)
      commitBuffer(); settle()
    })
  }
  function history(direction: 'undo' | 'redo') {
    if (composing || pending) return
    read(); owner[direction](); follow()
  }
  function beforeInput(event: Event) {
    const input = event as InputEvent
    const direction = input.inputType === 'historyUndo' ? 'undo' : input.inputType === 'historyRedo' ? 'redo' : null
    if (!direction || composing) return
    if (!input.cancelable) { read(); rejected('uncancelable-history'); return }
    input.preventDefault()
    if (shortcut === direction) { shortcut = null; return }
    history(direction)
  }
  function keydown(event: Event) {
    const key = event as KeyboardEvent
    if (key.isComposing || key.keyCode === 229 || composing || key.altKey || !(key.metaKey || key.ctrlKey)) return
    if (!['z', 'y'].includes(key.key.toLowerCase())) return
    key.preventDefault()
    shortcut = key.shiftKey || key.key.toLowerCase() === 'y' ? 'redo' : 'undo'
    history(shortcut)
    queueMicrotask(() => { shortcut = null })
  }
  const events: [string, EventListener][] = [
    ['select', read], ['input', commitBuffer], ['compositionstart', start], ['compositionend', end], ['beforeinput', beforeInput], ['keydown', keydown],
  ]
  function detach() {
    read()
    if (frame !== null) cancelAnimationFrame(frame)
    frame = null
    if (composing) {
      composing = false; callbacks.onCompositionChange?.(false)
      rejected('composition-interrupted'); settle()
    } else if (!pending && value !== displaySource(installed.raw)) rejected('detached-buffer')
    for (const [name, listener] of events) element?.removeEventListener(name, listener)
    unsubscribe?.(); unsubscribe = undefined; element = null
  }
  function bind(next: HTMLTextAreaElement, nextOptions: FileSourceOptions = callbacks) {
    if (element) detach()
    element = next; callbacks = nextOptions
    if (!pending) { installed = owner.snapshot(); identity = callbacks.identity?.() ?? owner; value = displaySource(installed.raw) }
    for (const [name, listener] of events) element.addEventListener(name, listener)
    unsubscribe = owner.observe(follow)
    write()
  }
  bind(textarea)
  return {
    pending: () => pending, composing: () => composing, commitBuffer,
    retry() { if (composing) return { ok: false, reason: 'composing' }; read(); return pending ? submit() : unchanged() },
    discard() {
      if (composing) return { ok: false, reason: 'composing' }
      pending = null; follow(); return unchanged()
    },
    flush() {
      if (composing) return new Promise((resolve, reject) => waiters.push({ resolve, reject }))
      read()
      if (pending) return Promise.reject(new Error(pending.reason))
      if (value !== displaySource(installed.raw)) { const result = commitBuffer(); if (!result.ok) return Promise.reject(new Error(result.reason)) }
      return Promise.resolve(owner.snapshot())
    },
    detach, bind,
  }
}
