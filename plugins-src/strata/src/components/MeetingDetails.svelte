<script lang="ts">
  import type { MeetingNodeMetadata } from '../lib/meetings'
  let { metadata, onopen }: { metadata: MeetingNodeMetadata; onopen: (sourceId?: string) => void } = $props()
  const record = $derived(metadata.record)
  const name = (id: string) => metadata.references.find(reference => reference.localId === id)?.label ?? id
  const labels: Record<string, string> = { entities: '实体', concepts: '概念', claims: '主张', events: '事件', narratives: '叙事', relations: '关系' }
  const statusLabels: Record<string, string> = { candidate: '候选（数据未声明审核状态）', contested: '有争议', supported: '来源声明受支持', confirmed: '来源声明已确认', superseded: '已被替代', retracted: '已撤回' }
  const strengths: Record<string, string> = { strong: '强', medium: '中', weak: '弱' }
  const bases: Record<string, string> = { explicit_statement: '明确陈述', explicit_speech_act: '明确言语行为', direct_observation: '直接观察', source_defined: '来源定义', independent_corroboration: '独立互证', self_report: '自述', agent_inference: '模型推断', ambiguous: '存在歧义' }
  const value = (input: unknown) => input === null ? '未知' : typeof input === 'string' ? input : JSON.stringify(input)
</script>

<section class="meeting-details" aria-label="会议提取知识详情">
  <div class="metadata-line"><span>{labels[metadata.kind]}</span><span>{record.i === 0 ? '核心' : '支撑'}</span><span>{metadata.localId}</span></div>
  <p class="notice">已导入的抽取知识；结构校验不代表事实已核实，当前原文尚未核对。</p>
  <dl>
    <div><dt>重要性理由</dt><dd>{record.why}</dd></div>
    <div><dt>来源记录状态</dt><dd>{statusLabels[record.status ?? 'candidate'] ?? record.status}</dd></div>
    <div><dt>证据强度声明</dt><dd>{record.epistemic ? strengths[record.epistemic.strength] : '历史数据未声明'}{#if record.epistemic} · {record.epistemic.basis.map(basis => bases[basis] ?? basis).join('、')}{/if}</dd></div>
    {#if record.epistemic?.reason}<div><dt>强度说明</dt><dd>{record.epistemic.reason}</dd></div>{/if}
    {#if 'definition' in record}<div><dt>定义</dt><dd>{record.definition}</dd></div>{/if}
    {#if 'criteria' in record && record.criteria?.length}<div><dt>判定条件</dt><dd>{record.criteria.join('；')}</dd></div>{/if}
    {#if 'excludes' in record && record.excludes?.length}<div><dt>不包含</dt><dd>{record.excludes.join('；')}</dd></div>{/if}
    {#if 'by' in record}<div><dt>说话人 / 主张归属</dt><dd>{record.by.map(name).join('、') || '未声明'}</dd></div>{/if}
    {#if 'kind' in record}<div><dt>主张类型</dt><dd>{record.kind}</dd></div>{/if}
    {#if 'state' in record}<div><dt>事件状态</dt><dd>{record.state}</dd></div>{/if}
    {#if 'thesis' in record}<div><dt>叙事主旨</dt><dd>{record.thesis}</dd></div><div><dt>叙事模式</dt><dd>{record.mode}</dd></div>{/if}
    {#if 'p' in record}<div><dt>关系类别</dt><dd>P{record.p} · {record.type}</dd></div>{/if}
    {#if 'args' in record}
      {#each Object.entries(record.args) as [role, refs]}<div><dt>角色 · {role}</dt><dd>{(Array.isArray(refs) ? refs : [refs]).map(name).join('、')}</dd></div>{/each}
    {/if}
    {#if 'members' in record}
      {#each record.members as member}<div><dt>组成 · {member.role}</dt><dd>{name(member.ref)}</dd></div>{/each}
    {/if}
    {#if 'if' in record && record.if?.length}<div><dt>成立条件</dt><dd>{record.if.join('；')}</dd></div>{/if}
    {#if 'unless' in record && record.unless?.length}<div><dt>例外</dt><dd>{record.unless.join('；')}</dd></div>{/if}
    {#if 'event' in record}<div><dt>记录的事件时间</dt><dd>{value(record.event)}</dd></div>{/if}
    {#if 'valid' in record}<div><dt>有效时间</dt><dd>{value(record.valid)}</dd></div>{/if}
    {#if 'reason' in record && record.reason}<div><dt>理由</dt><dd>{record.reason}</dd></div>{/if}
    {#if 'single_source_reason' in record && record.single_source_reason}<div><dt>单一来源说明</dt><dd>{record.single_source_reason}</dd></div>{/if}
    {#if 'alternatives' in record && record.alternatives?.length}<div><dt>替代解释</dt><dd>{record.alternatives.join('；')}</dd></div>{/if}
    {#if record.limits?.length}<div><dt>限制</dt><dd>{record.limits.join('；')}</dd></div>{/if}
    <div><dt>适用范围</dt><dd>{value(record.scope ?? metadata.scope.purpose)}</dd></div>
    {#if record.authority}<div><dt>数据中的审核声明</dt><dd>{record.authority.reviewed_by.join('、')} · {record.authority.basis}</dd></div>{/if}
  </dl>
  <details>
    <summary>保存的来源与证据 · {metadata.evidence.length}</summary>
    {#each metadata.evidence as evidence}
      <article class="saved-evidence">
        <strong>{evidence.source.title ?? evidence.source.id} · {evidence.loc}</strong>
        {#if evidence.speaker}<p>说话人：{evidence.speaker.name}</p>{/if}
        {#if evidence.at}<p>来源时间：{value(evidence.at)}</p>{/if}
        {#if evidence.quote}<blockquote>{evidence.quote}</blockquote>{:else}<p>数据只保存定位，没有保存短引文。</p>{/if}
        <p class="source-uri">{evidence.source.uri}</p>
        <p>记录的来源版本：{evidence.source.v ?? '未知'}；当前版本未核对。</p>
        <button type="button" onclick={() => onopen(evidence.source.id)}>打开来源</button>
      </article>
    {/each}
  </details>
  <details><summary>数据集与抽取信息</summary><p>{metadata.scope.purpose}</p><p>{metadata.generated.by} · {metadata.generated.at}</p><p>{metadata.generated.rule}</p><p class="source-uri">{metadata.datasetPath}</p><p>{metadata.datasetId}#{metadata.localId}</p></details>
  <button type="button" onclick={() => onopen()}>打开知识文件</button>
</section>

<style>
  .meeting-details { display: grid; gap: 12px; min-width: 0; font-size: 12px; line-height: 1.5; }
  .metadata-line { display: flex; flex-wrap: wrap; gap: 10px; color: var(--ui-secondary); }
  .notice { color: var(--ui-secondary); }
  p { margin: 0; overflow-wrap: anywhere; }
  dl { display: grid; gap: 10px; margin: 0; }
  dl > div { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 8px; }
  dt { color: var(--ui-secondary); }
  dd { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
  summary { cursor: pointer; }
  details > p { margin-top: 8px; }
  .saved-evidence { display: grid; gap: 7px; margin-top: 10px; padding: 10px; border: 1px solid var(--ui-separator); border-radius: 6px; min-width: 0; }
  .saved-evidence strong, .source-uri { overflow-wrap: anywhere; }
  blockquote { white-space: pre-wrap; margin: 0; padding-left: 10px; border-left: 2px solid var(--ui-separator); overflow-wrap: anywhere; }
  button { justify-self: start; }
</style>
