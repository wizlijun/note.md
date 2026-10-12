<script lang="ts">
  import type { Episode, Review, Source } from './types'
  import { dimensions, goalLabels, outcomeLabels, practicalColumns, signalLabels, supportedFinding } from './domain'
  let { episode, legacy, source, review, saving, onSave, onOpen }: {
    episode: Episode; legacy: boolean; source: Source | undefined; review: Review; saving: boolean
    onSave: (excluded: boolean, note: string) => void
    onOpen: (sourceId: string, line: number) => void
  } = $props()
  let note = $state('')
  $effect(() => { note = review.note })
</script>

<article id="episode-detail" aria-label="片段详情" tabindex="-1">
  <div class="eyebrow">AI 生成 · 待核对{review.excluded ? ' · 已人工排除' : ''}</div>
  <h2>{episode.title}</h2>
  <p class="muted">目标：{goalLabels[episode.goal_origin]} · {outcomeLabels[episode.outcome]}</p>
  {#if episode.outcome === 'user_confirmed'}<p class="notice">“用户确认结果”描述原对话中的反馈，不代表你已确认本次 Agency 判断。</p>{/if}
  {#if episode.outcome === 'assistant_reported'}<p class="notice">当前只有 AI 自述完成，尚未独立核验结果。</p>{/if}
  {#if legacy}<p class="notice">旧版报告，重新生成可补充协作复盘。目标状态与下方摩擦记录尚未结构化核对。</p>
    {#if episode.friction}<h3>已有摩擦记录 · 旧版未结构化核对</h3><p>{episode.friction}</p>{/if}
  {:else}
    <div class="practical">
      {#each practicalColumns as column}
        {@const finding = supportedFinding(episode.practical?.[column.key], episode)}
        <section><h3>{column.label}</h3>
          {#if finding}<p>{finding.note}</p><p class="muted">依据：{finding.evidence_indices.map(i => `引文 ${i + 1}`).join('、')}</p>
          {:else}<p class="muted">{column.unknown}</p>{/if}
        </section>
      {/each}
    </div>
  {/if}
  <details class="signals">
    <summary>Agency 三维线索（辅助说明）</summary>
    <p class="muted">这是对原对话的补充解释，不是心理评分，也不能代替目标进展或能力扩展的证据。</p>
    {#each dimensions as dimension}
      {@const signal = episode[dimension.key]}
      <section>
        <div class="signal-title"><h3>{dimension.label}</h3><span>{signalLabels[signal.state]}</span></div>
        <p>{signal.note || '未提供判断说明。'}</p>
        {#if signal.evidence_indices.length}<p class="muted">依据：{signal.evidence_indices.map(i => `引文 ${i + 1}`).join('、')}</p>{/if}
      </section>
    {/each}
  </details>
  {#if episode.contribution.length}<h3>我的选择与授权</h3><ul>{#each episode.contribution as item}<li>{item}</li>{/each}</ul>{/if}
  <h3>原文依据</h3><p class="path">{source?.path ?? '来源记录不可用'}</p>
  {#each episode.evidence as evidence, i}
    <div class="evidence"><div class="evidence-head"><span>引文 {i + 1} · {evidence.kind === 'user' ? '用户' : 'AI'}</span><button class="source-link" disabled={!source} onclick={() => onOpen(episode.source_id, evidence.line)}>打开原文 · 第 {evidence.line} 行</button></div><blockquote>{evidence.quote}</blockquote></div>
  {:else}<p class="muted">没有可回源的引文。</p>{/each}
  <div class="review">
    <label for="review-note">我的备注</label>
    <textarea id="review-note" rows="3" maxlength="4000" bind:value={note} placeholder="例如：这段属于探索，不是执行失败。" disabled={saving}></textarea>
    <div class="review-actions"><button disabled={saving || note === review.note} onclick={() => onSave(review.excluded, note)}>{saving ? '保存中…' : '保存备注'}</button><button disabled={saving} onclick={() => onSave(!review.excluded, note)}>{review.excluded ? '恢复计入' : '排除此片段'}</button></div>
    <p class="muted">排除会从本批复盘与建议中移除此片段，保留引文与备注。</p>
  </div>
</article>

<style>
  article { padding: 24px; min-width: 0; }
  h2 { margin: 6px 0 10px; font-size: 19px; line-height: 1.5; }
  h3 { font-size: 13px; margin: 16px 0 6px; }
  p, li { line-height: 1.65; overflow-wrap: anywhere; }
  p { margin: 6px 0; } ul { padding-left: 20px; }
  .eyebrow, .muted, .path { color: var(--ui-secondary); font-size: 12px; }
  .path { overflow-wrap: anywhere; }
  .notice { padding: 10px 12px; background: var(--ui-bg); border-radius: 8px; font-size: 12px; }
  .signals { margin: 22px 0; }
  summary { cursor: pointer; font-size: 12px; color: var(--ui-secondary); }
  .signals section { padding: 12px 0; border-bottom: 1px solid var(--ui-separator); }
  .signal-title { display: flex; justify-content: space-between; gap: 12px; align-items: center; }
  .signal-title h3 { margin: 0; } .signal-title span { font-size: 12px; color: var(--ui-secondary); }
  .evidence { margin: 12px 0; border: 1px solid var(--ui-separator); border-radius: 8px; padding: 12px; }
  .evidence-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; font-size: 12px; color: var(--ui-secondary); }
  blockquote { white-space: pre-wrap; overflow-wrap: anywhere; margin: 10px 0 0; line-height: 1.7; }
  button { background: var(--ui-surface); color: inherit; border: 1px solid var(--ui-control-border); border-radius: 6px; padding: 6px 10px; cursor: pointer; }
  button:hover:not(:disabled) { background: var(--ui-hover); } button:disabled { opacity: .5; }
  .source-link { color: var(--ui-accent-text); border: 0; padding: 3px 0; white-space: nowrap; }
  .review { border-top: 1px solid var(--ui-separator); margin-top: 24px; padding-top: 18px; }
  label { display: block; font-weight: 600; margin-bottom: 8px; }
  textarea { width: 100%; resize: vertical; border: 1px solid var(--ui-control-border); border-radius: 6px; padding: 10px; background: var(--ui-surface); color: inherit; }
  .review-actions { display: flex; gap: 8px; margin: 10px 0; }
</style>
