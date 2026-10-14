import { mount, unmount } from 'svelte'
import type { EditorView } from 'prosemirror-view'
import SlashMenu from '../lib/slash-menu/SlashMenu.svelte'
import { filterSlashItems, getShareSlashItems, type SlashItem } from '../lib/slash-menu/slash-items-common'
import type { FileEditorOwner, FileSlashCommand } from './file-contract'
import type { ImeGuard } from '../lib/ime'

/** UI only: every file command is admitted atomically by the existing owner. */
export function createFileMenus(input: {
  view: EditorView; owner: FileEditorOwner; ime: ImeGuard
  available(): boolean; insertNote(): boolean
}) {
  const { view, owner, ime } = input
  let popup: ReturnType<typeof mount> | undefined, target: HTMLElement | undefined
  let items: SlashItem[] = [], selected = 0
  let captured: { authority: string; generation: number; from: number; to: number } | undefined
  function removePopup() { if (popup) { void unmount(popup); popup = undefined }; target?.remove(); target = undefined }
  function closeSlash() { removePopup(); captured = undefined; items = []; selected = 0 }
  function current() {
    const now = owner.snapshot(), selection = view.state.selection
    return input.available() && captured?.authority === now.authority && captured.generation === now.generation
      && captured.from === selection.from && captured.to === selection.to
  }
  function execute(item: SlashItem) {
    if (!current()) return
    const accepted = item.id === 'insert-note' ? input.insertNote() : owner.executeSlash(item.id as FileSlashCommand)
    if (accepted) closeSlash()
  }
  function paint() {
    removePopup()
    const coords = view.coordsAtPos(view.state.selection.from)
    target = document.createElement('div'); document.body.append(target)
    popup = mount(SlashMenu, { target, props: { position: { top: coords.bottom, left: coords.left }, items, selectedIndex: selected, onSelect: execute, onClose: closeSlash } })
  }
  function openSlash() {
    if (!input.available()) return
    const { $from, empty } = view.state.selection
    if (!empty || $from.parent.type.name !== 'paragraph') { closeSlash(); return }
    const query = /^\/([a-zA-Z0-9一-龥]*)$/.exec($from.parent.textBetween(0, $from.parentOffset, ''))
    if (!query) { closeSlash(); return }
    const now = owner.snapshot()
    captured = { authority: now.authority, generation: now.generation, from: view.state.selection.from, to: view.state.selection.to }
    items = filterSlashItems(query[1], getShareSlashItems()); selected = 0; paint()
  }
  function keydown(event: KeyboardEvent) {
    if (!captured || ime.blocks(event) || !current()) return
    if (event.key === 'Escape') { event.preventDefault(); closeSlash(); return }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); event.stopImmediatePropagation()
      selected = Math.max(0, Math.min(items.length - 1, selected + (event.key === 'ArrowDown' ? 1 : -1))); paint()
    } else if ((event.key === 'Enter' || event.key === 'Tab') && items.length) {
      event.preventDefault(); event.stopImmediatePropagation(); execute(items[selected])
    }
  }
  view.dom.addEventListener('input', openSlash)
  view.dom.addEventListener('keydown', keydown, true)
  view.dom.addEventListener('compositionstart', closeSlash)
  return { openSlash, closeSlash, destroy() {
    closeSlash(); view.dom.removeEventListener('input', openSlash); view.dom.removeEventListener('keydown', keydown, true)
    view.dom.removeEventListener('compositionstart', closeSlash)
  } }
}
