import type { FileEditorOwner } from '../editor-kit-v2/file-contract'

export type FileHistoryRoute = Readonly<{ active: boolean; canUndo: boolean; canRedo: boolean }>
type FocusTarget = {
  owner: FileEditorOwner; element: HTMLElement; kind: 'rich' | 'source'
  identity(): object; available(): boolean; capture(): () => void
}
type FocusCapture = { target: FocusTarget; identity: object; authority: string; generation: number; restore(): void }
let current: FocusCapture | undefined
const listeners = new Set<(route: FileHistoryRoute) => void>()
const inactive: FileHistoryRoute = { active: false, canUndo: false, canRedo: false }
function live(target: FocusTarget) { return target.element.isConnected && target.available() }
function route(): FileHistoryRoute {
  const target = current?.target
  return target && live(target) ? { active: true, canUndo: target.owner.canUndo(), canRedo: target.owner.canRedo() } : inactive
}
function publish() { const value = route(); for (const listener of listeners) listener(value) }
function capture(target: FocusTarget) {
  const snapshot = target.owner.snapshot()
  current = { target, identity: target.identity(), authority: snapshot.authority, generation: snapshot.generation, restore: target.capture() }
  publish()
}
export function observeFileHistoryRoute(listener: (route: FileHistoryRoute) => void): () => void {
  listeners.add(listener); listener(route()); return () => { listeners.delete(listener) }
}
/** Actual editor DOM registration; stores only the current owner and selection, never history. */
export function bindFileHistoryFocus(target: FocusTarget): () => void {
  const focus = () => { if (live(target)) capture(target) }
  const refresh = () => { if (current?.target === target && live(target)) capture(target) }
  const elsewhere = (event: FocusEvent) => {
    if (current?.target !== target || event.target === document.body || event.target === document.documentElement) return
    if (!(event.target instanceof Node) || !target.element.contains(event.target)) { current = undefined; publish() }
  }
  target.element.addEventListener('focusin', focus)
  for (const event of ['keyup', 'mouseup', 'input', 'select', 'compositionstart', 'compositionend']) target.element.addEventListener(event, refresh)
  document.addEventListener('focusin', elsewhere)
  document.addEventListener('selectionchange', refresh)
  const unsubscribe = target.owner.observe(refresh)
  if (target.element.contains(document.activeElement)) focus()
  return () => {
    unsubscribe(); target.element.removeEventListener('focusin', focus)
    for (const event of ['keyup', 'mouseup', 'input', 'select', 'compositionstart', 'compositionend']) target.element.removeEventListener(event, refresh)
    document.removeEventListener('focusin', elsewhere); document.removeEventListener('selectionchange', refresh)
    if (current?.target === target) { current = undefined; publish() }
  }
}
export function refreshFileHistoryRoute(): void { publish() }
export function routeFileHistory(command: 'undo' | 'redo'): boolean {
  const saved = current
  if (!saved || !live(saved.target)) return false
  const { target } = saved, snapshot = target.owner.snapshot()
  if (target.identity() !== saved.identity || snapshot.authority !== saved.authority || snapshot.generation !== saved.generation) {
    // An unobserved document change invalidates the bookmark; do not resolve it.
    capture(target); return false
  }
  if (!(command === 'undo' ? target.owner.canUndo() : target.owner.canRedo())) return false
  saved.restore()
  const done = command === 'undo' ? target.owner.undo() : target.owner.redo()
  if (live(target)) capture(target)
  return done
}
