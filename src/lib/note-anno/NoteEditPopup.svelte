<script lang="ts">
  import { noteUi } from './note-ui.svelte'
  import { t } from '../i18n/store.svelte'
  import { iconSvg } from '../context-menu/icons'

  // Captured at mount: the parent only mounts this while noteUi.edit is set.
  const editState = noteUi.edit!
  let text = $state(editState.note)
  let root: HTMLDivElement | undefined = $state()
  let ta: HTMLTextAreaElement | undefined = $state()

  $effect(() => { ta?.focus(); ta?.select() })

  function close(save: boolean) {
    if (noteUi.edit !== editState) return
    noteUi.edit = null
    if (save) editState.save(text)
  }
  function onDelete() {
    if (noteUi.edit !== editState) return
    noteUi.edit = null
    editState.remove()
  }
  function onWindowMousedown(e: MouseEvent) {
    if (root && !root.contains(e.target as Node)) close(true)
  }
  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') { e.stopPropagation(); close(true) }
    // Notes are single-line (newlines are flattened on save) → Enter confirms.
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); close(true) }
  }
</script>

<svelte:window onmousedown={onWindowMousedown} />

<div
  class="note-edit"
  bind:this={root}
  style="left:{editState.x}px; top:{editState.y}px"
  onkeydown={onKeydown}
  role="dialog"
  aria-label={t('ctxmenu.note')}
  tabindex="-1"
>
  <textarea
    bind:this={ta}
    bind:value={text}
    rows="3"
    placeholder={t('noteedit.placeholder')}
  ></textarea>
  <div class="row">
    <button
      class="del"
      onclick={onDelete}
      title={t('noteedit.delete')}
      aria-label={t('noteedit.delete')}
    >{@html iconSvg('trash')}</button>
  </div>
</div>

<style>
  /* Flat panel matching EditorContextMenu: system colors + color-mix handle
     light/dark automatically; font inherits from the app/theme. */
  .note-edit {
    position: fixed;
    z-index: 1001;
    width: 280px;
    padding: 6px;
    background: Canvas;
    color: CanvasText;
    border: 1px solid color-mix(in srgb, CanvasText 18%, Canvas);
    border-radius: 8px;
    box-shadow: 0 4px 16px color-mix(in srgb, CanvasText 18%, transparent);
    font: inherit;
    font-size: 13px;
  }
  textarea {
    width: 100%;
    box-sizing: border-box;
    resize: none;
    font: inherit;
    font-size: 13px;
    line-height: 1.5;
    color: CanvasText;
    background: color-mix(in srgb, CanvasText 5%, Canvas);
    border: none;
    border-radius: 5px;
    padding: 6px 8px;
    outline: none;
  }
  textarea:focus {
    background: color-mix(in srgb, AccentColor 8%, Canvas);
  }
  .row { display: flex; justify-content: flex-end; margin-top: 4px; }
  .del {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    padding: 0;
    background: none;
    border: none;
    border-radius: 5px;
    cursor: pointer;
    color: color-mix(in srgb, CanvasText 65%, Canvas);
  }
  .del:hover {
    background: color-mix(in srgb, AccentColor 12%, Canvas);
    color: CanvasText;
  }
  /* iconSvg() emits class="ctx-icon" inside {@html} — style it unscoped. */
  :global(.note-edit .ctx-icon) { width: 15px; height: 15px; display: block; }
</style>
