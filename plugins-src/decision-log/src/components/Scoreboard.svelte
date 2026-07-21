<!-- Scoreboard.svelte — always-on calibration rail.
     Shows calibration buckets (hits/total per confidence), sample count, and
     avoidance categories. Records CALIBRATION, never accuracy rate (spec §3 S3 /
     §7.6). Empty state shows "0 samples collected so far". -->
<script lang="ts">
  import { state as store } from '../lib/store.svelte'
  import { CONFIDENCE_BUCKETS, type Confidence } from '../lib/model'
  import { t } from '../lib/strings'

  const score = $derived(store.score)
  const hasSamples = $derived((score?.sampleCount ?? 0) > 0)
  const avoidance = $derived(Object.entries(score?.avoidance ?? {}))

  function pct(b: { hits: number; total: number }): number {
    return b.total ? Math.round((b.hits / b.total) * 100) : 0
  }
</script>

<aside class="rail">
  <h2 class="rail-title">{t('score.calibration')}</h2>

  {#if score}
    <div class="buckets">
      {#each CONFIDENCE_BUCKETS as c (c)}
        {@const b = score.buckets[c as Confidence]}
        <div class="bucket">
          <span class="bucket-label">{t(`sign.confidence.${c}` as 'sign.confidence.low')}</span>
          <div class="bar" aria-hidden="true">
            <div class="bar-fill" style="width:{pct(b)}%"></div>
          </div>
          <span class="bucket-count">{b.hits}/{b.total}</span>
        </div>
      {/each}
    </div>

    <p class="samples">
      <span class="samples-num">{score.sampleCount}</span>
      {t('score.samples')}
    </p>

    {#if !hasSamples}
      <p class="hint">{t('score.noVerdicts')}</p>
    {/if}

    {#if avoidance.length > 0}
      <div class="avoidance">
        <span class="avoidance-lead">{t('score.avoidance')}</span>
        <ul>
          {#each avoidance as [cat, n] (cat)}
            <li>{cat} <span class="avoid-n">×{n}</span></li>
          {/each}
        </ul>
      </div>
    {/if}
  {:else}
    <p class="hint">{t('score.empty')}</p>
  {/if}
</aside>

<style>
  .rail {
    width: 220px;
    flex: 0 0 220px;
    padding: 1rem;
    border-left: 1px solid var(--line, #e5e7eb);
    box-sizing: border-box;
    overflow-y: auto;
  }
  .rail-title { margin: 0 0 0.75rem; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.6; }
  .buckets { display: flex; flex-direction: column; gap: 0.5rem; }
  .bucket { display: grid; grid-template-columns: 1fr auto; grid-template-rows: auto auto; gap: 2px 6px; align-items: center; }
  .bucket-label { font-size: 0.8rem; }
  .bucket-count { font-size: 0.75rem; opacity: 0.7; font-variant-numeric: tabular-nums; }
  .bar { grid-column: 1 / -1; height: 6px; border-radius: 3px; background: color-mix(in srgb, currentColor 12%, transparent); overflow: hidden; }
  .bar-fill { height: 100%; background: var(--accent, #2563eb); border-radius: 3px; transition: width 0.2s; }
  .samples { margin: 1rem 0 0; font-size: 0.85rem; }
  .samples-num { font-size: 1.4rem; font-weight: 600; margin-right: 0.25rem; }
  .hint { margin: 0.75rem 0 0; font-size: 0.8rem; opacity: 0.55; line-height: 1.4; }
  .avoidance { margin-top: 1rem; }
  .avoidance-lead { font-size: 0.75rem; opacity: 0.6; }
  .avoidance ul { margin: 0.35rem 0 0; padding-left: 1rem; font-size: 0.82rem; }
  .avoidance li { margin: 0.15rem 0; }
  .avoid-n { opacity: 0.55; }
</style>
