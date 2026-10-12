<script lang="ts">
  import { wordDiff } from './display'
  let { current, result, resultLabel = '最终文本' }: { current: string; result: string; resultLabel?: string } = $props()
  const diff = $derived(wordDiff(current, result))
</script>

<div class="source-diff" aria-label={`当前原件到${resultLabel}的完整差异`}>
  <h5>− 当前原件</h5><pre class="removed">{#each diff.before as part}<span class:word-change={part.changed}>{part.text}</span>{/each}</pre>
  <h5>+ {resultLabel}</h5><pre class="added">{#each diff.after as part}<span class:word-change={part.changed}>{part.text}</span>{/each}</pre>
</div>
