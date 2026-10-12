<script lang="ts">
  import type { ReviewAnnotation } from '../../lib/project-share/review.svelte'
  let { rows, disabled = false, gitTarget = false, onStage, onDismiss, onCopy }: {
    rows: ReviewAnnotation[]; disabled?: boolean; gitTarget?: boolean; onStage: (index: number) => void; onDismiss: (index: number) => void; onCopy: (text: string) => void
  } = $props()
  const positioned = $derived(rows.filter(row => row.anchor?.status !== 'orphan').sort((a, b) => (a.anchor && a.anchor.status !== 'orphan' ? a.anchor.start : Infinity) - (b.anchor && b.anchor.status !== 'orphan' ? b.anchor.start : Infinity) || a.index - b.index))
  const orphans = $derived(rows.filter(row => row.anchor?.status === 'orphan'))
</script>
{#snippet entries(items: ReviewAnnotation[])}
  {#each items as row (row.index)}<article class="review-annotation" data-annotation-index={row.index}>
    <blockquote>{row.annotation.quote || '点批注'}</blockquote><p>{row.annotation.comment}</p>
    <p class="review-secondary">{row.manualReason ?? (row.anchor === null ? '定位暂不可用，可复制或忽略' : row.anchor.status === 'orphan' ? '无法定位到当前原件' : row.anchor.status === 'fuzzy' ? '近似定位，请核对选文' : '已定位到当前原件')}{#if row.decision} · {row.decision === 'promoted' ? '已提升' : '已忽略'}{/if}</p>
    <div class="review-actions">{#if row.canPromote}<button aria-pressed={row.staged} {disabled} onclick={() => onStage(row.index)}>{row.staged ? '取消提升' : '提升为我的批注'}</button>{/if}<button onclick={() => onCopy(`${row.annotation.quote}\n${row.annotation.comment}`)}>复制评论</button><button disabled={disabled || !!row.decision} onclick={() => onDismiss(row.index)}>忽略</button></div>
  </article>{/each}
{/snippet}
{#if rows.length}<section class="annotations"><h4>访客批注</h4><p class="review-secondary">{gitTarget ? '分支和补丁只包含正文。批注可复制或忽略；需要提升请先切换到 A。' : '选择提升后，批注会与正文一起确认并写回。'}</p>{@render entries(positioned)}{#if orphans.length}<h4>孤立评论</h4>{@render entries(orphans)}{/if}</section>{/if}
