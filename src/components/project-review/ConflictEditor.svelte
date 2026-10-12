<script lang="ts">
  import { untrack } from 'svelte'
  import type { Hunk, HunkDecision } from '../../lib/share-merge'
  import { visibleText } from './display'
  let { hunk, decision, disabled = false, onDecide }: {
    hunk: Hunk; decision?: HunkDecision; disabled?: boolean; onDecide: (id: string, decision: HunkDecision) => void
  } = $props()
  let text = $state(untrack(() => decision?.kind === 'conflict' && decision.choice === 'edited' ? decision.text ?? '' : hunk.ours))
  function choose(choice: 'ours' | 'theirs' | 'ours+theirs' | 'theirs+ours' | 'edited') {
    onDecide(hunk.id, { kind: 'conflict', choice, ...(choice === 'edited' ? { text, source: 'human' as const } : {}) })
  }
</script>
<div class="conflict-editor">
  <div class="conflict-columns"><div><h5>当前原件</h5><pre>{visibleText(hunk.ours)}</pre></div><div><h5>协作者版本</h5><pre>{visibleText(hunk.theirs)}</pre></div><label>手改结果<textarea aria-label="手改结果" bind:value={text} {disabled} rows="5" spellcheck="false"></textarea></label></div>
  <div class="review-actions">
    <button {disabled} onclick={() => choose('ours')}>保留当前原件</button><button {disabled} onclick={() => choose('theirs')}>采用协作者版本</button>
    <button {disabled} onclick={() => choose('ours+theirs')}>原件后接建议</button><button {disabled} onclick={() => choose('theirs+ours')}>建议后接原件</button><button {disabled} onclick={() => choose('edited')}>采用手改</button>
  </div>
</div>
