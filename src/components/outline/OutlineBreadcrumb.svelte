<!-- src/components/outline/OutlineBreadcrumb.svelte — zoom 面包屑。
     渲染 focus 根的祖先链(不含 focus 根本身,它已作聚焦视图顶行显示),对齐
     hulunote 的 get-nav-breadcrumbs + butlast。每段可点:根 Label → onCrumb(null)
     回全文;祖先 → onCrumb(祖先id) 逐级 zoom-out。 -->
<script lang="ts">
  import { ancestorsOf, type OutlineTree } from '../../lib/outline/model'

  let {
    tree, focusRootId, rootLabel = '全部', onCrumb,
  }: {
    tree: OutlineTree
    focusRootId: string
    /** 最左段文字(主大纲=笔记名 / daily=日期);点它 = 完全 zoom-out */
    rootLabel?: string
    onCrumb: (id: string | null) => void
  } = $props()

  const crumbs = $derived(ancestorsOf(tree, focusRootId))

  /** 祖先/根的显示文本:去掉常见 markdown/双链标记,压平空白,超长省略。 */
  function label(raw: string): string {
    const t = raw
      .replace(/\[\[([^\]]+)\]\]/g, '$1')     // [[wiki]] → wiki
      .replace(/[*_`~>#]/g, '')                // 常见行内/块标记
      .replace(/\s+/g, ' ')
      .trim()
    return t.length > 32 ? t.slice(0, 32) + '…' : (t || '·')
  }
</script>

<nav class="crumbs" aria-label="breadcrumb">
  <button class="crumb root" onclick={() => onCrumb(null)}>{rootLabel}</button>
  {#each crumbs as c (c.id)}
    <span class="sep" aria-hidden="true">›</span>
    <button class="crumb" onclick={() => onCrumb(c.id)}>{label(c.content)}</button>
  {/each}
</nav>

<style>
  /* 面包屑是导航 chrome,不是正文 —— 用系统 UI 字体 + 固定 13px 对齐工具栏
     (.doc-title),而非跟随主题阅读字体/字号(--outline-*),保证与主 UI 一致。 */
  .crumbs {
    display: flex; align-items: center; flex-wrap: wrap; gap: 4px;
    padding: 6px 16px;
    font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif;
    font-size: 13px;
    line-height: 1.4;
    border-bottom: 1px solid color-mix(in srgb, CanvasText 10%, transparent);
  }
  .crumb {
    background: none; border: none; padding: 1px 3px; border-radius: 4px;
    font: inherit; color: color-mix(in srgb, currentColor 70%, transparent);
    cursor: pointer; max-width: 22ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .crumb:hover { color: currentColor; background: color-mix(in srgb, currentColor 8%, transparent); }
  .crumb.root { font-weight: 600; color: color-mix(in srgb, currentColor 85%, transparent); }
  .sep { opacity: 0.4; }
</style>
