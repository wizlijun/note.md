<script lang="ts">
  import type { Hunk, HunkDecision } from '../../lib/share-merge'
  import { flagLabels } from './display'
  import ConflictEditor from './ConflictEditor.svelte'
  import SourceDiff from './SourceDiff.svelte'
  import RenderedPreview from './RenderedPreview.svelte'
  let { hunk, decision, disabled = false, rendered = false, onDecide }: {
    hunk: Hunk; decision?: HunkDecision; disabled?: boolean; rendered?: boolean; onDecide: (id: string, decision: HunkDecision) => void
  } = $props()
  let editing = $state(false), confirmingRisk = $state(false)
  const editable = $derived(hunk.kind === 'conflict')
  const actionable = $derived(hunk.kind === 'theirs-only' || editable)
  const risky = $derived(hunk.flags.some(flag => ['trust-field', 'owner-annotation', 'hidden-chars', 'degraded'].includes(flag)))
  const choiceLabels = { accept: '已接受', reject: '已拒绝', ours: '保留原件', theirs: '采用建议', 'ours+theirs': '原件后接建议', 'theirs+ours': '建议后接原件', edited: '采用手改' }
  export function act(action: 'accept' | 'reject' | 'edit') {
    if (disabled || !actionable) return
    if (action === 'edit') { if (editable) editing = true; return }
    if (action === 'accept' && risky && !confirmingRisk) { confirmingRisk = true; return }
    confirmingRisk = false
    onDecide(hunk.id, hunk.kind === 'theirs-only' ? { kind: 'theirs-only', choice: action } : { kind: 'conflict', choice: action === 'accept' ? 'theirs' : 'ours' })
  }
</script>
<article class="hunk" tabindex="-1" data-hunk-id={hunk.id}>
  <header class="review-actions"><strong>{hunk.kind === 'conflict' ? '冲突' : hunk.kind === 'theirs-only' ? '协作者改动' : hunk.kind === 'both-same' ? '双方一致' : '主人改动'}</strong>{#each hunk.flags as flag}<span class="review-badge">{flagLabels[flag]}</span>{/each}<span>{decision ? choiceLabels[decision.choice] : actionable ? risky ? '需单独确认' : '待决定' : '保留原件'}</span></header>
  {#if rendered}<div class="rendered-diff"><h5>− 当前原件</h5><RenderedPreview text={hunk.ours} /><h5>+ 协作者版本</h5><RenderedPreview text={hunk.theirs} /></div>{:else}<SourceDiff current={hunk.ours} result={hunk.theirs} resultLabel="协作者版本" />{/if}
  {#if actionable}<div class="review-actions"><button {disabled} onclick={() => act('accept')}>接受</button><button {disabled} onclick={() => act('reject')}>拒绝</button><button disabled={disabled || !editable} title={editable ? '编辑冲突结果' : '无冲突建议可接受或拒绝'} onclick={() => act('edit')}>编辑</button></div>{/if}
  {#if confirmingRisk}<div class="risk-confirm" role="group" aria-label="单独确认风险"><p>此处涉及{hunk.flags.map(flag => flagLabels[flag]).join('、')}。请核对后单独接受。</p><button {disabled} onclick={() => act('accept')}>确认接受风险改动</button><button onclick={() => confirmingRisk = false}>取消</button></div>{/if}
  {#if editing}<ConflictEditor {hunk} {decision} {disabled} {onDecide} />{/if}
</article>
