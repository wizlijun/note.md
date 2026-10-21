<script lang="ts">
  import { importanceLabel, type Importance } from '../importance'
  let { importance, flagged = false, zh }: { importance: Importance; flagged?: boolean; zh: boolean } = $props()
</script>

<span class="assessment-labels">
  <span class="importance-label" data-importance={importance}>{importanceLabel(importance, zh)}</span>
  {#if flagged}<span class="anomaly-label">{zh ? '反常' : 'Anomaly'}</span>{/if}
</span>

<style>
  .assessment-labels { display: flex; align-items: center; gap: 5px; flex-shrink: 0; white-space: nowrap; }
  .importance-label { color: var(--importance-color); font-size: 10px; font-weight: 650; line-height: 16px; }
  .anomaly-label { color: var(--timeline-anomaly-text); background: var(--timeline-anomaly-bg); border: 1px solid transparent; border-radius: 4px; padding: 0 4px; font-size: 9px; font-weight: 650; line-height: 14px; }
</style>
