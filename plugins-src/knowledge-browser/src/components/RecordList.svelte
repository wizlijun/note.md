<script module lang="ts">
  import type { ViewRecord } from '../lib/normalizer'

  export type RecordListText = (key: string, values?: Record<string, string | number>) => string

  export interface RecordListProps {
    records: readonly ViewRecord[]
    selectedId?: string | null
    contextIds?: ReadonlySet<string>
    text: RecordListText
    onSelect: (record: ViewRecord) => void
  }
</script>

<script lang="ts">
  let {
    records,
    selectedId = null,
    contextIds = new Set<string>(),
    text,
    onSelect,
  }: RecordListProps = $props()

  function focusRecord(list: HTMLElement, index: number): void {
    const buttons = [...list.querySelectorAll<HTMLButtonElement>('[data-record-button]')]
    buttons.at(Math.max(0, Math.min(index, buttons.length - 1)))?.focus()
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const target = event.target
    if (!(target instanceof HTMLButtonElement)) return
    const list = event.currentTarget
    if (!(list instanceof HTMLElement)) return
    const buttons = [...list.querySelectorAll<HTMLButtonElement>('[data-record-button]')]
    const current = buttons.indexOf(target)
    if (current < 0) return
    event.preventDefault()
    if (event.key === 'Home') return focusRecord(list, 0)
    if (event.key === 'End') return focusRecord(list, buttons.length - 1)
    focusRecord(list, current + (event.key === 'ArrowDown' ? 1 : -1))
  }
</script>

<section class="record-list" aria-label={text('recordList.ariaLabel')}>
  <header>
    <strong>{text('recordList.results', { count: records.length })}</strong>
  </header>

  {#if records.length === 0}
    <p class="empty" role="status">{text('recordList.empty')}</p>
  {:else}
    <div class="items" role="listbox" aria-label={text('recordList.ariaLabel')} tabindex="-1" onkeydown={handleKeydown}>
      {#each records as record (record.key)}
        <button
          type="button"
          role="option"
          data-record-button
          aria-selected={record.id === selectedId}
          class:selected={record.id === selectedId}
          class:context={contextIds.has(record.id)}
          onclick={() => onSelect(record)}
        >
          <span class="record-heading">
            <span class="label">{record.label}</span>
            <span class="id">{record.id}</span>
          </span>
          <span class="metadata">
            <span>{text(`kind.${record.kind}`)}</span>
            <span>{record.secondary}</span>
            <span>{text(`status.${record.status}`)}</span>
            <span>{text(record.importance === 0 ? 'importance.core' : 'importance.supporting')}</span>
            {#if contextIds.has(record.id)}<span>{text('recordList.context')}</span>{/if}
          </span>
          <span class="why">{record.why}</span>
        </button>
      {/each}
    </div>
  {/if}
</section>

<style>
  .record-list {
    display: flex;
    min-width: 0;
    min-height: 0;
    flex-direction: column;
    color: CanvasText;
  }

  header {
    flex: none;
    padding: 10px 12px;
    border-bottom: 1px solid var(--ui-separator, color-mix(in srgb, CanvasText 16%, transparent));
    font-size: 12px;
  }

  .items {
    min-width: 0;
    overflow: auto;
  }

  button {
    display: grid;
    width: 100%;
    min-width: 0;
    gap: 6px;
    padding: 11px 12px;
    border: 0;
    border-bottom: 1px solid var(--ui-separator, color-mix(in srgb, CanvasText 12%, transparent));
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: start;
    cursor: pointer;
  }

  button:hover { background: var(--ui-hover, color-mix(in srgb, CanvasText 7%, transparent)); }
  button.selected { background: var(--ui-selection, color-mix(in srgb, AccentColor 14%, transparent)); }
  button.context { border-inline-start: 3px solid var(--ui-warning, #b26a00); }
  button:focus-visible { position: relative; outline: 2px solid var(--ui-accent, AccentColor); outline-offset: -2px; }

  .record-heading, .metadata {
    display: flex;
    min-width: 0;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 5px 8px;
  }

  .label {
    min-width: 0;
    flex: 1 1 14rem;
    overflow-wrap: anywhere;
    font-weight: 650;
    line-height: 1.4;
  }

  .id, .metadata {
    color: var(--ui-secondary, GrayText);
    font-size: 12px;
  }

  .id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .metadata > span:not(:last-child)::after { content: ' ·'; }

  .why {
    display: -webkit-box;
    overflow: hidden;
    color: var(--ui-secondary, GrayText);
    font-size: 13px;
    line-height: 1.45;
    overflow-wrap: anywhere;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
  }

  .empty {
    margin: auto;
    padding: 28px 16px;
    color: var(--ui-secondary, GrayText);
    text-align: center;
  }
</style>
