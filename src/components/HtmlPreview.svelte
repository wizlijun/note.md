<script lang="ts">
  import { t } from '../lib/i18n/store.svelte'
  let { html }: { html: string } = $props()
</script>

<!--
  HTML rich mode = sandboxed iframe preview. NOT editable.
  - sandbox attribute with NO allow-scripts → <script> tags do not execute
  - srcdoc renders the raw HTML byte-stably; saving back is a no-op
  - To edit: switch to source mode (Cmd+/)
-->
<div class="html-preview-wrap">
  <iframe
    title={t('htmlPreview.title')}
    sandbox=""
    srcdoc={html}
    class="html-preview-frame"
  ></iframe>
</div>

<style>
  .html-preview-wrap {
    width: 100%;
    height: 100%;
    box-sizing: border-box;
    overflow: hidden;
    background: Canvas;
    /* GPU compositing hint */
    will-change: transform;
    transform: translateZ(0);
    contain: layout paint;
  }
  .html-preview-frame {
    width: 100%;
    height: 100%;
    border: 0;
    background: white;
  }
</style>
