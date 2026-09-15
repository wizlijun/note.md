<script module lang="ts">
  import type { ViewRecord } from '../lib/normalizer'
  import type { DatasetIndexes, Evidence, KnowledgeRecord, Source } from '../lib/types'

  export type DetailPaneText = (key: string, values?: Record<string, string | number>) => string

  export interface DetailPaneProps {
    record?: ViewRecord | null
    indexes: DatasetIndexes
    text: DetailPaneText
    onNavigate: (id: string) => void
    onCopyRaw: (record: KnowledgeRecord, pointer: string) => void
    onCopyReference: (record: ViewRecord) => void
    onReadSource: (evidence: Evidence, source?: Source) => void
  }
</script>

<script lang="ts">
  import { evidenceLabel, referencedRecordIds, roleEntries, timeMeaning } from '../lib/normalizer'
  import type { Relation } from '../lib/types'

  let {
    record = null,
    indexes,
    text,
    onNavigate,
    onCopyRaw,
    onCopyReference,
    onReadSource,
  }: DetailPaneProps = $props()

  type Tab = 'details' | 'evidence' | 'raw'
  interface DetailRow { key: string; value: string }

  let tab = $state<Tab>('details')

  $effect(() => {
    record?.id
    tab = 'details'
  })

  function present(value: unknown): string {
    if (Array.isArray(value)) return value.map(present).join(' · ')
    if (value && typeof value === 'object') {
      return Object.entries(value).map(([key, item]) => `${key}: ${present(item)}`).join(' · ')
    }
    return value === null ? text('value.unknown') : String(value)
  }

  function add(rows: DetailRow[], key: string, value: unknown): void {
    if (value === undefined || (Array.isArray(value) && value.length === 0) || value === '') return
    rows.push({ key, value: present(value) })
  }

  function describeTime(raw: KnowledgeRecord, field: 'event' | 'valid'): string {
    const meaning = timeMeaning(raw, field)
    if (meaning.kind === 'not-applicable') return text('time.notApplicable')
    if (meaning.kind === 'unknown') return text('time.unknown')
    return present(meaning.value)
  }

  function detailRows(raw: KnowledgeRecord): DetailRow[] {
    const rows: DetailRow[] = []
    if ('name' in raw) {
      add(rows, 'field.entityType', raw.type)
      add(rows, 'field.aliases', raw.aliases)
      add(rows, 'field.description', raw.desc)
      add(rows, 'field.identity', raw.identity ?? 'candidate')
    } else if ('term' in raw) {
      add(rows, 'field.definition', raw.definition)
      add(rows, 'field.aliases', raw.aliases)
      add(rows, 'field.criteria', raw.criteria)
      add(rows, 'field.excludes', raw.excludes)
    } else if ('kind' in raw) {
      add(rows, 'field.claimKind', raw.kind)
      add(rows, 'field.claimant', raw.by)
      add(rows, 'field.about', raw.about)
      add(rows, 'field.conditions', raw.if)
      add(rows, 'field.exceptions', raw.unless)
      add(rows, 'field.reason', raw.reason)
    } else if ('state' in raw) {
      add(rows, 'field.eventType', raw.type)
      add(rows, 'field.eventState', raw.state)
      add(rows, 'field.roles', roleEntries(raw.args).map(item => `${item.role}: ${item.ref}`))
      add(rows, 'field.place', raw.place)
      add(rows, 'field.description', raw.desc)
    } else if ('members' in raw) {
      add(rows, 'field.narrativeType', raw.type)
      add(rows, 'field.thesis', raw.thesis)
      add(rows, 'field.mode', raw.mode)
      add(rows, 'field.members', raw.members.map(member => `${member.role}: ${member.ref}`))
      add(rows, 'field.reason', raw.reason)
      add(rows, 'field.alternatives', raw.alternatives)
    } else if ('p' in raw) {
      add(rows, 'field.priority', `P${raw.p}`)
      add(rows, 'field.relationType', raw.type)
      add(rows, 'field.statement', raw.text)
      add(rows, 'field.claimReferences', raw.claim)
      add(rows, 'field.roles', roleEntries(raw.args).map(item => `${item.role}: ${item.ref}`))
      add(rows, 'field.conditions', raw.if)
      add(rows, 'field.exceptions', raw.unless)
      add(rows, 'field.reason', raw.reason)
      add(rows, 'field.singleSourceReason', raw.single_source_reason)
    }
    add(rows, 'field.eventTime', describeTime(raw, 'event'))
    add(rows, 'field.validTime', describeTime(raw, 'valid'))
    add(rows, 'field.scope', raw.scope)
    add(rows, 'field.limits', raw.limits)
    add(rows, 'field.authority', raw.authority)
    add(rows, 'field.score', raw.score === undefined ? undefined : `${raw.score}${raw.score_type ? ` · ${raw.score_type}` : ''}`)
    add(rows, 'field.revision', raw.rev ?? 1)
    add(rows, 'field.operation', raw.op ?? 'create')
    add(rows, 'field.parents', raw.parents)
    return rows
  }

  const rows = $derived(record ? detailRows(record.raw) : [])
  const references = $derived(record ? referencedRecordIds(record.raw) : [])
  function relationStatements(raw: KnowledgeRecord): string[] {
    if (!('p' in raw)) return []
    const relation = raw as Relation
    if (relation.text) return [relation.text]
    return (relation.claim ?? []).map(id => {
      const item = indexes.nodesById.get(id)
      return item && 'text' in item && !('p' in item) ? item.text : id
    })
  }
</script>

<section class="detail-pane" aria-label={text('detail.ariaLabel')}>
  {#if !record}
    <p class="empty" role="status">{text('detail.empty')}</p>
  {:else}
    <header>
      <div class="heading-copy">
        <p class="eyebrow">{text(`kind.${record.kind}`)} · {record.id}</p>
        <h2>{record.label}</h2>
        <p class="status-line">
          {text(`status.${record.status}`)} · {text(record.importance === 0 ? 'importance.core' : 'importance.supporting')}
        </p>
      </div>
      <div class="heading-actions">
        <button type="button" onclick={() => onCopyReference(record)}>{text('action.copyReference')}</button>
      </div>
    </header>

    <div class="tabs" role="tablist" aria-label={text('detail.tabs')}>
      {#each ['details', 'evidence', 'raw'] as value}
        <button
          type="button"
          role="tab"
          aria-selected={tab === value}
          aria-controls={`detail-panel-${value}`}
          class:active={tab === value}
          onclick={() => tab = value as Tab}
        >{text(`detail.tab.${value}`)}</button>
      {/each}
    </div>

    {#if tab === 'details'}
      <div class="panel" id="detail-panel-details" role="tabpanel">
        <section class="lead">
          <h3>{text('detail.content')}</h3>
          {#if relationStatements(record.raw).length > 0}
            {#each relationStatements(record.raw) as statement}<p>{statement}</p>{/each}
          {:else if 'text' in record.raw && !('p' in record.raw)}
            <p>{record.raw.text}</p>
          {:else if 'thesis' in record.raw}
            <p>{record.raw.thesis}</p>
          {:else if 'definition' in record.raw}
            <p>{record.raw.definition}</p>
          {:else if 'desc' in record.raw && record.raw.desc}
            <p>{record.raw.desc}</p>
          {:else}
            <p>{record.label}</p>
          {/if}
          <p class="why"><strong>{text('field.why')}</strong> {record.why}</p>
        </section>

        <dl>
          {#each rows as row}
            <div><dt>{text(row.key)}</dt><dd>{row.value}</dd></div>
          {/each}
        </dl>

        <section>
          <h3>{text('detail.related')}</h3>
          {#if references.length === 0}
            <p class="muted">{text('detail.noRelated')}</p>
          {:else}
            <div class="link-list">
              {#each references as id}
                <button type="button" onclick={() => onNavigate(id)}>
                  <span>{indexes.nodesById.get(id) ? text('action.openRecord') : text('detail.missingRecord')}</span>
                  <code>{id}</code>
                </button>
              {/each}
            </div>
          {/if}
        </section>
      </div>
    {:else if tab === 'evidence'}
      <div class="panel evidence-panel" id="detail-panel-evidence" role="tabpanel">
        <h3>{text('detail.directEvidence', { count: record.raw.ev.length })}</h3>
        {#if record.raw.ev.length === 0}
          <p class="muted">{text('detail.noEvidence')}</p>
        {:else}
          {#each record.raw.ev as evidenceId}
            {@const evidence = indexes.evidenceById.get(evidenceId)}
            {@const source = evidence ? indexes.sourcesById.get(evidence.s) : undefined}
            <article class="evidence-card">
              {#if evidence}
                <h4>{evidenceLabel(evidence, source)}</h4>
                {#if evidence.quote}<blockquote>{evidence.quote}</blockquote>{/if}
                <dl>
                  {#if evidence.speaker}<div><dt>{text('field.speaker')}</dt><dd>{evidence.speaker}</dd></div>{/if}
                  {#if evidence.at}<div><dt>{text('field.sourceTime')}</dt><dd>{present(evidence.at)}</dd></div>{/if}
                  {#if evidence.role}<div><dt>{text('field.evidenceRole')}</dt><dd>{evidence.role}</dd></div>{/if}
                  {#if source}<div><dt>{text('field.sourceUri')}</dt><dd>{source.uri}</dd></div>{/if}
                </dl>
                <button type="button" onclick={() => onReadSource(evidence, source)}>{text('action.readSource')}</button>
              {:else}
                <h4>{evidenceId}</h4>
                <p class="error">{text('detail.missingEvidence')}</p>
              {/if}
            </article>
          {/each}
        {/if}
      </div>
    {:else}
      <div class="panel raw-panel" id="detail-panel-raw" role="tabpanel">
        <div class="raw-heading">
          <code>{record.pointer}</code>
          <button type="button" onclick={() => onCopyRaw(record.raw, record.pointer)}>{text('action.copyRaw')}</button>
        </div>
        <pre role="region" aria-label={text('detail.rawRecord')}>{JSON.stringify(record.raw, null, 2)}</pre>
      </div>
    {/if}
  {/if}
</section>

<style>
  .detail-pane {
    min-width: 0;
    min-height: 0;
    overflow: auto;
    color: CanvasText;
  }

  header {
    display: flex;
    min-width: 0;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    padding: 18px 20px 14px;
  }

  .heading-copy { min-width: 0; }
  h2 { margin: 3px 0 5px; font-size: clamp(18px, 2.5vw, 24px); line-height: 1.35; overflow-wrap: anywhere; }
  h3 { margin: 20px 0 9px; font-size: 14px; }
  h4 { margin: 0 0 8px; overflow-wrap: anywhere; }
  p { line-height: 1.6; overflow-wrap: anywhere; }
  .eyebrow, .status-line, .muted { margin: 0; color: var(--ui-secondary, GrayText); font-size: 12px; }
  .heading-actions { flex: none; }

  button {
    min-height: 30px;
    border: 1px solid var(--ui-control-border, color-mix(in srgb, CanvasText 20%, transparent));
    border-radius: 7px;
    background: var(--ui-surface, Canvas);
    color: inherit;
    font: inherit;
    cursor: pointer;
  }

  button:hover { background: var(--ui-hover, color-mix(in srgb, CanvasText 7%, transparent)); }
  button:focus-visible { outline: 2px solid var(--ui-accent, AccentColor); outline-offset: 2px; }
  .heading-actions button, .raw-heading button, .evidence-card > button { padding: 5px 10px; }

  .tabs {
    display: flex;
    overflow-x: auto;
    padding: 0 20px;
    border-bottom: 1px solid var(--ui-separator, color-mix(in srgb, CanvasText 16%, transparent));
  }

  .tabs button { flex: none; padding: 8px 12px; border: 0; border-radius: 0; background: transparent; }
  .tabs button.active { box-shadow: inset 0 -2px var(--ui-accent, AccentColor); color: var(--ui-accent-text, AccentColor); }
  .panel { min-width: 0; padding: 0 20px 24px; }
  .lead p { margin: 6px 0; }
  .why { color: var(--ui-secondary, GrayText); font-size: 13px; }

  dl { display: grid; gap: 0; margin: 10px 0; }
  dl > div { display: grid; min-width: 0; grid-template-columns: minmax(8rem, 28%) minmax(0, 1fr); gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--ui-separator, color-mix(in srgb, CanvasText 11%, transparent)); }
  dt { color: var(--ui-secondary, GrayText); font-size: 12px; }
  dd { min-width: 0; margin: 0; overflow-wrap: anywhere; white-space: pre-wrap; }

  .link-list { display: flex; flex-wrap: wrap; gap: 7px; }
  .link-list button { display: flex; min-width: 0; gap: 7px; align-items: center; padding: 5px 9px; }
  code { overflow-wrap: anywhere; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }

  .evidence-panel { display: grid; gap: 10px; }
  .evidence-card { min-width: 0; padding: 13px; border: 1px solid var(--ui-separator, color-mix(in srgb, CanvasText 16%, transparent)); border-radius: 9px; }
  blockquote { margin: 9px 0; padding-inline-start: 12px; border-inline-start: 3px solid var(--ui-accent, AccentColor); white-space: pre-wrap; overflow-wrap: anywhere; }
  .evidence-card dl > div { grid-template-columns: minmax(7rem, 24%) minmax(0, 1fr); }
  .error { color: var(--ui-danger, #b42318); }

  .raw-heading { display: flex; min-width: 0; align-items: center; justify-content: space-between; gap: 10px; margin: 16px 0 8px; }
  pre { max-width: 100%; margin: 0; padding: 12px; overflow: auto; border-radius: 8px; background: var(--ui-code-bg, color-mix(in srgb, CanvasText 6%, Canvas)); font-size: 12px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
  .empty { margin: auto; padding: 36px 18px; color: var(--ui-secondary, GrayText); text-align: center; }

  @media (max-width: 639px) {
    header { flex-direction: column; padding: 14px; }
    .tabs { padding: 0 14px; }
    .panel { padding: 0 14px 20px; }
    dl > div, .evidence-card dl > div { grid-template-columns: 1fr; gap: 4px; }
  }
</style>
