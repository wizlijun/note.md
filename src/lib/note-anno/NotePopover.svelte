<script lang="ts">
  import { noteUi } from './note-ui.svelte'
</script>

{#if noteUi.hover && !noteUi.edit}
  <div class="note-popover" style="left:{noteUi.hover.x}px; top:{noteUi.hover.y}px">
    {noteUi.hover.note}
  </div>
{/if}

<style>
  /* Flat panel matching EditorContextMenu / NoteEditPopup: system colors,
     inherited font, auto light/dark via color-mix. */
  .note-popover {
    position: fixed;
    z-index: 1000;
    max-width: 320px;
    padding: 6px 10px;
    border-radius: 8px;
    font: inherit;
    font-size: 13px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
    background: Canvas;
    color: CanvasText;
    border: 1px solid color-mix(in srgb, CanvasText 18%, Canvas);
    box-shadow: 0 4px 16px color-mix(in srgb, CanvasText 18%, transparent);
    pointer-events: none;
  }
</style>
