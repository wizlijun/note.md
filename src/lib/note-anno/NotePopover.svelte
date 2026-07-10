<script lang="ts">
  import { noteUi } from './note-ui.svelte'
</script>

{#if noteUi.hover && !noteUi.edit}
  <div class="note-popover menu-panel" style="left:{noteUi.hover.x}px; top:{noteUi.hover.y}px">
    {noteUi.hover.note}
  </div>
{/if}

<style>
  /* Chrome comes from the shared .menu-panel class in app.css. */
  .note-popover {
    position: fixed;
    z-index: 1000;
    max-width: 320px;
    padding: 6px 10px;
    font: inherit;
    font-size: 13px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
    pointer-events: none;
  }
</style>
