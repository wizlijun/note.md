<script lang="ts">
  import { noteUi, styleVars } from './note-ui.svelte'
</script>

{#if noteUi.hover && !noteUi.edit}
  <div
    class="note-popover menu-panel"
    style="left:{noteUi.hover.x}px; top:{noteUi.hover.y}px; {styleVars(noteUi.hover.style)}"
  >
    {noteUi.hover.note}
  </div>
{/if}

<style>
  /* Chrome comes from the shared .menu-panel class in app.css.
     The --note-* custom properties carry the current document theme's colors
     AND typography (font/line-height), set inline when the popover opens, so
     the preview reads like part of the themed document. Each falls back to the
     system Canvas/CanvasText chrome + UI font when no theme was captured. */
  .note-popover {
    position: fixed;
    z-index: 1000;
    max-width: 320px;
    padding: 6px 10px;
    white-space: pre-wrap;
    word-break: break-word;
    pointer-events: none;
    background: color-mix(in srgb, var(--note-bg, Canvas) 82%, transparent);
    color: var(--note-fg, CanvasText);
    border-color: color-mix(in srgb, var(--note-fg, CanvasText) 22%, transparent);
    font-family: var(--note-font-family, inherit);
    font-size: var(--note-font-size, 13px);
    font-weight: var(--note-font-weight, 400);
    font-style: var(--note-font-style, normal);
    line-height: var(--note-line-height, 1.5);
    letter-spacing: var(--note-letter-spacing, normal);
    font-feature-settings: var(--note-font-feature, normal);
  }
</style>
