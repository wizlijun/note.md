// Shared UI state for annotation popovers. Rich mode writes it from DOM
// event handlers; NotePopover / NoteEditPopup render from it.

export interface NoteEditState {
  x: number
  y: number
  note: string
  save: (note: string) => void
  remove: () => void
}

export interface NoteHoverState {
  x: number
  y: number
  note: string
}

export const noteUi = $state({
  edit: null as NoteEditState | null,
  hover: null as NoteHoverState | null,
})
