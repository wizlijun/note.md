<script lang="ts">
  import { parseUnifiedDiff } from '../../lib/git-history/diff-parse'

  let { content }: { content: string } = $props()

  let rows = $derived(parseUnifiedDiff(content))

  function sign(type: string): string {
    return type === 'add' ? '+' : type === 'del' ? '-' : ' '
  }
</script>

<div class="diff-view" role="document">
  {#each rows as r, i (i)}
    <div class="row {r.type}">
      <span class="ln old">{r.oldLn ?? ''}</span>
      <span class="ln new">{r.newLn ?? ''}</span>
      <span class="sign">{sign(r.type)}</span>
      <span class="text">{r.text || ' '}</span>
    </div>
  {/each}
</div>

<style>
  .diff-view {
    flex: 1;
    min-height: 0;
    overflow: auto;
    font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
    font-size: 13px;
    line-height: 1.55;
    background: Canvas;
    color: CanvasText;
    padding: 8px 0 24px;
    box-sizing: border-box;
  }
  .row {
    display: flex;
    align-items: baseline;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .ln {
    flex: 0 0 auto;
    width: 3.4em;
    padding: 0 6px;
    text-align: right;
    color: GrayText;
    opacity: 0.65;
    user-select: none;
    -webkit-user-select: none;
  }
  .sign {
    flex: 0 0 auto;
    width: 1.2em;
    text-align: center;
    user-select: none;
    -webkit-user-select: none;
    opacity: 0.8;
  }
  .text {
    flex: 1 1 auto;
    padding-right: 12px;
    white-space: pre-wrap;
  }

  /* Line-level backgrounds, git-tool style. Uses color-mix so it adapts to the
     current Canvas (light/dark) automatically. */
  .row.add { background: color-mix(in srgb, #2ea043 16%, Canvas); }
  .row.del { background: color-mix(in srgb, #f85149 16%, Canvas); }
  .row.add .sign { color: #2ea043; opacity: 1; }
  .row.del .sign { color: #f85149; opacity: 1; }

  .row.hunk {
    background: color-mix(in srgb, #4a90e2 14%, Canvas);
    color: color-mix(in srgb, CanvasText 55%, #4a90e2);
  }
  .row.hunk .text { font-weight: 500; }

  .row.meta {
    color: GrayText;
    opacity: 0.8;
  }
  .row.meta .sign { visibility: hidden; }

  @media (prefers-color-scheme: dark) {
    .row.add { background: color-mix(in srgb, #2ea043 22%, Canvas); }
    .row.del { background: color-mix(in srgb, #f85149 22%, Canvas); }
    .row.hunk { background: color-mix(in srgb, #4a90e2 20%, Canvas); }
  }
</style>
