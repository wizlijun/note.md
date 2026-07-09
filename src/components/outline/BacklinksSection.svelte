<script lang="ts">
  import { outline } from '../../lib/outline/store.svelte'
  import { backlinksFor } from '../../lib/outline/backlinks'
  import { currentPageName } from '../../lib/outline/backlinks-io.svelte'
  import { openFile } from '../../lib/tabs.svelte'
  import { t } from '../../lib/i18n/store.svelte'
  import InlineRender from './InlineRender.svelte'

  let hits = $derived.by(() => {
    void outline.version
    const page = currentPageName()
    if (!page || !outline.backlinkIndex) return []
    // 排除伴生文件对自己主文件的"自引用"噪音：保留，但排掉当前伴生文件
    return backlinksFor(outline.backlinkIndex, page).filter(h => h.file !== outline.companionPath)
  })
</script>

<section class="backlinks">
  <h3>{t('outline.backlinks')} <span class="count">{hits.length}</span></h3>
  {#each hits as hit}
    <button class="hit" onclick={() => void openFile(hit.file)}>
      <span class="file">{hit.file.split('/').pop()}</span>
      <span class="text"><InlineRender content={hit.text} /></span>
    </button>
  {/each}
  {#if hits.length === 0}<p class="none">{t('outline.noBacklinks')}</p>{/if}
</section>

<style>
  .backlinks { border-top: 1px solid var(--border-color, #3333); padding: 8px; }
  h3 { font-size: 12px; margin: 0 0 6px; opacity: 0.7; }
  .count { opacity: 0.6; font-weight: normal; }
  .hit { display: block; width: 100%; text-align: left; background: none; border: none;
    padding: 4px 6px; border-radius: 4px; cursor: pointer; color: inherit; font-size: 12px; }
  .hit:hover { background: var(--hover-bg, #8881); }
  .file { opacity: 0.6; margin-right: 6px; }
  .none { opacity: 0.5; font-size: 12px; }
</style>
