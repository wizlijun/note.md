<script lang="ts">
  import { feedbackName } from '../../lib/project-share/feedback'
  import type { LocalFeedback } from '../../lib/project-share/types'
  let { feedback, selectedId, hunkCount, disabled = false, onSelect }: {
    feedback: LocalFeedback[]; selectedId?: string; hunkCount?: number; disabled?: boolean; onSelect: (feedback: LocalFeedback) => void
  } = $props()
  function group(item: LocalFeedback) {
    if (item.status === 'quarantined') return '隔离'
    if (item.superseded_by) return '已取代'
    if (['accepted', 'rejected', 'resolved', 'mirror_pending', 'branched'].includes(item.status)) return '已处理'
    if (Object.values(item.decisions).some(decision => ['accepted', 'rejected', 'mirror_pending', 'branched'].includes(decision.status))) return '部分'
    return '待审'
  }
  const groups = $derived(['待审', '部分', '已处理', '隔离', '已取代'].map(label => ({ label, items: feedback.filter(item => group(item) === label) })))
</script>
{#snippet rows(items: LocalFeedback[])}
  {#each items as item (item.envelope.payload.submissionId)}
    <button class:selected={selectedId === item.envelope.payload.submissionId} {disabled} onclick={() => onSelect(item)}>
      <strong>{feedbackName(item.envelope.payload) || '访客'} <span class="review-badge">自报</span>{#if item.envelope.payload.schemaVersion === 2 && item.envelope.payload.contributor?.aiAssisted}<span class="review-badge">AI 辅助</span>{/if}</strong>
      {#if item.envelope.payload.schemaVersion === 2 && item.envelope.payload.message}<span>{item.envelope.payload.message}</span>{/if}
      <span class="review-secondary">{item.envelope.receivedAt} · {new Set([...item.envelope.payload.edits.map(e => e.path), ...item.envelope.payload.annotations.map(a => a.path)]).size} 个文件 · {item.envelope.payload.annotations.length} 条批注 · {selectedId === item.envelope.payload.submissionId && hunkCount !== undefined ? `当前文件 ${hunkCount} 处改动` : '改动待计算'}{#if item.review} · {Object.values(item.review).reduce((n, draft) => n + Object.keys(draft.hunks).length, 0)} 处已存决定{/if}</span>
    </button>
  {/each}
{/snippet}
<div class="submission-list" aria-label="本机提交">
  {#each groups as grouped}{#if grouped.items.length}
    {#if grouped.label === '已取代'}<details><summary>已取代（{grouped.items.length}）</summary>{@render rows(grouped.items)}</details>
    {:else}<section><h4>{grouped.label}（{grouped.items.length}）</h4>{@render rows(grouped.items)}</section>{/if}
  {/if}{/each}
</div>
