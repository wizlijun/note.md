<script lang="ts">
  import { untrack } from 'svelte'
  import { t } from '../../lib/i18n/store.svelte'
  import type { Hunk, HunkDecision } from '../../lib/share-merge'
  import { visibleText } from './display'
  let { hunk, decision, disabled = false, mode = 'owner', onDecide }: {
    mode?: 'owner' | 'guest'; hunk: Hunk; decision?: HunkDecision; disabled?: boolean; onDecide: (id: string, decision: HunkDecision) => void
  } = $props()
  let text = $state(untrack(() => decision?.kind === 'conflict' && decision.choice === 'edited' ? decision.text ?? '' : hunk.ours))
  function choose(choice: 'ours' | 'theirs' | 'ours+theirs' | 'theirs+ours' | 'edited') {
    onDecide(hunk.id, { kind: 'conflict', choice, ...(choice === 'edited' ? { text, source: 'human' as const } : {}) })
  }
</script>
<div class="conflict-editor">
  <div class="conflict-columns"><div><h5>{mode === 'guest' ? t('guest.publisherVersion') : '当前原件'}</h5><pre>{visibleText(hunk.ours)}</pre></div><div><h5>{mode === 'guest' ? t('guest.myVersion') : '协作者版本'}</h5><pre>{visibleText(hunk.theirs)}</pre></div><label>{mode === 'guest' ? t('guest.editedResult') : '手改结果'}<textarea aria-label={mode === 'guest' ? t('guest.editedResult') : '手改结果'} bind:value={text} {disabled} rows="5" spellcheck="false"></textarea></label></div>
  <div class="review-actions">
    <button {disabled} onclick={() => choose('ours')}>{mode === 'guest' ? t('guest.publisherVersion') : '保留当前原件'}</button><button {disabled} onclick={() => choose('theirs')}>{mode === 'guest' ? t('guest.myVersion') : '采用协作者版本'}</button>
    {#if mode === 'owner'}<button {disabled} onclick={() => choose('ours+theirs')}>原件后接建议</button><button {disabled} onclick={() => choose('theirs+ours')}>建议后接原件</button>{/if}<button {disabled} onclick={() => choose('edited')}>{mode === 'guest' ? t('guest.useEdited') : '采用手改'}</button>
  </div>
</div>
