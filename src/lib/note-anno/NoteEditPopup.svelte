<script lang="ts">
  import { noteUi } from './note-ui.svelte'
  import { t } from '../i18n/store.svelte'

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
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); close(true) }
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
    <button class="del" onclick={onDelete}>{t('noteedit.delete')}</button>
  </div>
</div>

<style>
  .note-edit {
    position: fixed;
    z-index: 1001;
    width: 280px;
    padding: 8px;
    border-radius: 8px;
    background: #fff;
    border: 1px solid rgba(0, 0, 0, 0.15);
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18);
  }
  textarea {
    width: 100%;
    box-sizing: border-box;
    resize: vertical;
    font: inherit;
    font-size: 13px;
    border: 1px solid rgba(0, 0, 0, 0.15);
    border-radius: 5px;
    padding: 5px 7px;
    outline: none;
  }
  .row { display: flex; justify-content: flex-end; margin-top: 6px; }
  .del {
    font-size: 12px;
    color: #c0392b;
    background: none;
    border: none;
    cursor: pointer;
    padding: 2px 6px;
    border-radius: 4px;
  }
  .del:hover { background: rgba(192, 57, 43, 0.1); }
  @media (prefers-color-scheme: dark) {
    .note-edit { background: #2a2a2e; border-color: rgba(255, 255, 255, 0.15); }
    textarea { background: #1e1e22; color: #ddd; border-color: rgba(255, 255, 255, 0.15); }
  }
</style>
