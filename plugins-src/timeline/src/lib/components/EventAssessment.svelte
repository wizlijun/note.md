<script lang="ts">
  import type { TimelineItem } from '../parser'
  import ImportanceLabel from './ImportanceLabel.svelte'
  let { item, zh }: { item: TimelineItem; zh: boolean } = $props()
  const metadata = $derived(item.metadata)
  const unknown = $derived(zh ? '未知' : 'Unknown')
  const relation = $derived({ direct: zh ? '直接参与或承担后果' : 'Direct involvement or consequences', related: zh ? '间接相关' : 'Indirectly related', background: zh ? '背景信息' : 'Background', unknown })
</script>

<section class="assessment" aria-label={zh ? '事件判断' : 'Event assessment'}>
  <ImportanceLabel importance={metadata.importance} flagged={metadata.anomaly?.status === 'flagged'} {zh} />
  {#if metadata.importance_origin === 'manual'}<p>{zh ? '手动设置；下方证据为原有记录。' : 'Manually set; evidence below is retained from the original record.'}</p>{/if}
  <p class="assessment-reason">{metadata.reason || (zh ? '旧文档尚未评估。' : 'This legacy document has not been assessed.')}</p>
  <div class="evidence"><strong>{zh ? '重要程度证据' : 'Importance evidence'}</strong>{#each metadata.evidence as evidence}<span>{evidence.source} · {evidence.locator}</span>{:else}<span>{zh ? '暂无证据' : 'No evidence recorded'}</span>{/each}</div>
  <div class="anomaly-assessment">
    <strong>{zh ? '反常判断' : 'Anomaly assessment'}</strong>
    <p>{metadata.anomaly?.status === 'flagged' ? (zh ? '有依据的反常' : 'Evidence-backed anomaly') : metadata.anomaly?.status === 'none' ? (zh ? '已核对未发现反常' : 'Reviewed; no anomaly found') : (zh ? '反常尚未判断' : 'Anomaly not yet assessed')}</p>
    {#if metadata.anomaly}<p>{metadata.anomaly.reason}</p>{/if}
    {#if metadata.anomaly?.evidence.length}<div class="evidence" aria-label={zh ? '反常证据' : 'Anomaly evidence'}>{#each metadata.anomaly.evidence as evidence}<span>{evidence.source} · {evidence.locator}</span>{/each}</div>{/if}
  </div>
  <dl class="signals">
    <div><dt>{zh ? '引用字数' : 'Source characters'}</dt><dd>{metadata.signals.source_chars ?? unknown}</dd></div>
    <div><dt>{zh ? '已证实耗时' : 'Verified duration'}</dt><dd>{metadata.signals.duration_minutes === null ? unknown : `${metadata.signals.duration_minutes} ${zh ? '分钟' : 'min'}`}</dd></div>
    <div><dt>{zh ? '本人关系' : 'Owner relation'}</dt><dd>{relation[metadata.signals.owner_relation]}</dd></div>
  </dl>
</section>

<style>
  .assessment { margin: 10px 0; padding: 10px; border: 1px solid var(--ui-separator); border-radius: 6px; background: var(--ui-bg); font-size: 11px; line-height: 1.6; overflow-wrap: anywhere; }
  p { margin: 5px 0; }
  .evidence { display: flex; flex-wrap: wrap; gap: 3px 9px; color: var(--ui-secondary); }
  .evidence strong { width: 100%; }
  .anomaly-assessment { margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--ui-separator); }
  .signals { margin: 10px 0 0; color: var(--ui-secondary); }
  .signals div { display: flex; gap: 8px; justify-content: space-between; }
  dt { flex-shrink: 0; }
  dd { margin: 0; text-align: right; }
</style>
