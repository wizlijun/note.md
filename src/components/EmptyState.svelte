<script lang="ts">
  import { pickOpenFile, showError } from '../lib/dialogs'
  import { openFile, newFile } from '../lib/tabs.svelte'

  async function onOpen() {
    const p = await pickOpenFile()
    if (p) {
      try { await openFile(p) } catch (e) { console.warn(e); showError(String(e)) }
    }
  }

  function onNew() {
    newFile()
  }

  function onDblClick() {
    newFile()
  }
</script>

<div class="empty" ondblclick={onDblClick}>
  <p class="hint">拖入 .md 文件 或</p>
  <div class="actions">
    <button onclick={onNew}>New (⌘N)</button>
    <button onclick={onOpen}>Open… (⌘O)</button>
  </div>
</div>

<style>
  .empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    color: GrayText;
  }
  .actions {
    display: flex;
    gap: 10px;
  }
  button {
    padding: 6px 14px;
    border-radius: 6px;
    border: 1px solid color-mix(in srgb, CanvasText 25%, transparent);
    background: Canvas;
    color: CanvasText;
    cursor: pointer;
    font-size: 13px;
  }
  button:hover { background: color-mix(in srgb, CanvasText 8%, Canvas); }
</style>
