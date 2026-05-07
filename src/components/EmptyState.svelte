<script lang="ts">
  import { pickOpenFile } from '../lib/dialogs'
  import { openFile } from '../lib/tabs.svelte'

  async function onOpen() {
    const p = await pickOpenFile()
    if (p) {
      try { await openFile(p) } catch (e) { console.warn(e) }
    }
  }
</script>

<div class="empty">
  <p class="hint">拖入 .md 文件 或</p>
  <button onclick={onOpen}>Open… (Cmd+O)</button>
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
