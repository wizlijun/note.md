<script lang="ts">
  import { noteUi } from './note-ui.svelte'
</script>

{#if noteUi.hover && !noteUi.edit}
  <div class="note-popover" style="left:{noteUi.hover.x}px; top:{noteUi.hover.y}px">
    {noteUi.hover.note}
  </div>
{/if}

<style>
  .note-popover {
    position: fixed;
    z-index: 1000;
    max-width: 320px;
    padding: 6px 10px;
    border-radius: 6px;
    font-size: 12.5px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
    background: #fffbe8;
    color: #3b3b3b;
    border: 1px solid rgba(0, 0, 0, 0.12);
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.14);
    pointer-events: none;
  }
  @media (prefers-color-scheme: dark) {
    .note-popover {
      background: #3a3520;
      color: #e8e2c8;
      border-color: rgba(255, 255, 255, 0.14);
    }
  }
</style>
