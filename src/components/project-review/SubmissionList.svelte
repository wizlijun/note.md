<script lang="ts">
  import type { LocalFeedback } from '../../lib/project-share/types'
  let { feedback, selectedId, hunkCount, disabled = false, onSelect }: {
    feedback: LocalFeedback[]; selectedId?: string; hunkCount?: number; disabled?: boolean; onSelect: (feedback: LocalFeedback) => void
  } = $props()
  function group(item: LocalFeedback) {
    if (item.status === 'quarantined') return '隔离'
    if (['accepted', 'rejected', 'resolved', 'mirror_pending', 'branched'].includes(item.status)) return '已处理'
    if (Object.values(item.decisions).some(decision => ['accepted', 'rejected', 'mirror_pending', 'branched'].includes(decision.status))) return '部分'
    return '待审'
  }
  const groups = $derived(['待审', '部分', '已处理', '隔离'].map(label => ({ label, items: feedback.filter(item => group(item) === label) })))
</script>
<div class="submission-list" aria-label="本机提交">
  {#each groups as grouped}{#if grouped.items.length}<section><h4>{grouped.label}（{grouped.items.length}）</h4>{#each grouped.items as item (item.envelope.payload.submissionId)}<button class:selected={selectedId === item.envelope.payload.submissionId} {disabled} onclick={() => onSelect(item)}><strong>{item.envelope.payload.name || '访客'} <span class="review-badge">自报</span></strong><span class="review-secondary">{item.envelope.receivedAt} · {new Set([...item.envelope.payload.edits.map(e => e.path), ...item.envelope.payload.annotations.map(a => a.path)]).size} 个文件 · {item.envelope.payload.annotations.length} 条批注 · {selectedId === item.envelope.payload.submissionId && hunkCount !== undefined ? `当前文件 ${hunkCount} 处改动` : '改动待计算'}{#if item.review} · {Object.values(item.review).reduce((n, draft) => n + Object.keys(draft.hunks).length, 0)} 处已存决定{/if}</span></button>{/each}</section>{/if}{/each}
</div>
