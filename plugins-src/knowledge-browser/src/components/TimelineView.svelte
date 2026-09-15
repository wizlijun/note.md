<script module lang="ts">
  import type { ViewRecord } from '../lib/normalizer'
  import type { TimeValue } from '../lib/types'

  export type TimelineText = (key: string, values?: Record<string, string | number>) => string
  export type TimelineTimeKind = 'point' | 'range' | 'unknown' | 'not-applicable' | 'unstandardized'

  export interface TimelineEntry {
    key: string
    label: string
    secondary?: string
    record?: ViewRecord
    time?: TimeValue
    timeKind: TimelineTimeKind
    sortKey?: string
    group?: string
    context?: boolean
  }

  export interface TimelineViewProps {
    dimension: 'event' | 'valid' | 'source' | 'system'
    entries: readonly TimelineEntry[]
    text: TimelineText
    onSelect: (entry: TimelineEntry) => void
  }
</script>

<script lang="ts">
  let { dimension, entries, text, onSelect }: TimelineViewProps = $props()

  const ordered = $derived(entries
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => {
      if (left.entry.sortKey === right.entry.sortKey) return left.index - right.index
      if (!left.entry.sortKey) return 1
      if (!right.entry.sortKey) return -1
      return left.entry.sortKey.localeCompare(right.entry.sortKey)
    })
    .map(item => item.entry))

  function displayTime(entry: TimelineEntry): string {
    if (entry.timeKind === 'unknown') return text('time.unknown')
    if (entry.timeKind === 'not-applicable') return text('time.notApplicable')
    if (entry.timeKind === 'unstandardized') {
      return text('time.unstandardized', { value: String(entry.time ?? '') })
    }
    if (Array.isArray(entry.time)) {
      return text('time.range', {
        start: entry.time[0] ?? text('time.openStart'),
        end: entry.time[1] ?? text('time.openEnd'),
      })
    }
    return String(entry.time ?? text('time.unknown'))
  }
</script>

<section class="timeline" aria-labelledby="timeline-heading">
  <header>
    <h2 id="timeline-heading">{text('timeline.title')}</h2>
    <p>{text(`timeline.dimension.${dimension}`)} · {text('timeline.count', { count: entries.length })}</p>
  </header>

  {#if entries.length === 0}
    <p class="empty" role="status">{text('timeline.empty')}</p>
  {:else}
    <ol aria-label={text(`timeline.dimension.${dimension}`)}>
      {#each ordered as entry (entry.key)}
        <li class:context={entry.context} class:uncertain={entry.timeKind === 'unknown' || entry.timeKind === 'unstandardized'}>
          <span class="rail" aria-hidden="true"><span></span></span>
          <button type="button" onclick={() => onSelect(entry)}>
            <span class="time">
              {displayTime(entry)}
              {#if entry.group}<small>{entry.group}</small>{/if}
            </span>
            <span class="copy">
              <strong>{entry.label}</strong>
              {#if entry.secondary}<span>{entry.secondary}</span>{/if}
              <span class="badges">
                <span>{text(`time.kind.${entry.timeKind}`)}</span>
                {#if entry.context}<span>{text('timeline.context')}</span>{/if}
              </span>
            </span>
          </button>
        </li>
      {/each}
    </ol>
  {/if}
</section>

<style>
  .timeline { min-width: 0; min-height: 0; overflow: auto; color: CanvasText; }
  header { padding: 16px 18px 10px; }
  h2 { margin: 0; font-size: 18px; }
  header p { margin: 5px 0 0; color: var(--ui-secondary, GrayText); font-size: 12px; }
  ol { min-width: 0; margin: 0; padding: 4px 18px 26px; list-style: none; }
  li { display: grid; min-width: 0; grid-template-columns: 18px minmax(0, 1fr); }
  .rail { position: relative; display: flex; justify-content: center; }
  .rail::before { position: absolute; inset-block: 0; width: 1px; background: var(--ui-separator-strong, color-mix(in srgb, CanvasText 30%, transparent)); content: ''; }
  .rail span { position: relative; width: 9px; height: 9px; margin-top: 18px; border: 2px solid var(--ui-accent, AccentColor); border-radius: 50%; background: var(--ui-surface, Canvas); z-index: 1; }
  li.uncertain .rail span { border-style: dashed; }

  button { display: grid; width: 100%; min-width: 0; grid-template-columns: minmax(9rem, 28%) minmax(0, 1fr); gap: 14px; margin: 4px 0 10px; padding: 11px 12px; border: 1px solid var(--ui-separator, color-mix(in srgb, CanvasText 16%, transparent)); border-radius: 9px; background: var(--ui-surface, Canvas); color: inherit; font: inherit; text-align: start; cursor: pointer; }
  button:hover { background: var(--ui-hover, color-mix(in srgb, CanvasText 7%, transparent)); }
  button:focus-visible { outline: 2px solid var(--ui-accent, AccentColor); outline-offset: 2px; }
  li.context button { border-inline-start: 3px solid var(--ui-warning, #b26a00); }
  .time, .copy { display: grid; min-width: 0; align-content: start; gap: 4px; overflow-wrap: anywhere; }
  .time { color: var(--ui-secondary, GrayText); font-size: 12px; font-variant-numeric: tabular-nums; }
  .time small { font-size: 11px; }
  .copy strong { line-height: 1.45; }
  .copy > span:not(.badges) { color: var(--ui-secondary, GrayText); font-size: 12px; }
  .badges { display: flex; min-width: 0; flex-wrap: wrap; gap: 5px; color: var(--ui-secondary, GrayText); font-size: 11px; }
  .badges span { padding: 2px 6px; border-radius: 999px; background: var(--ui-hover, color-mix(in srgb, CanvasText 7%, transparent)); }
  .empty { padding: 36px 18px; color: var(--ui-secondary, GrayText); text-align: center; }

  @media (max-width: 639px) {
    header { padding-inline: 12px; }
    ol { padding-inline: 8px 12px; }
    button { grid-template-columns: 1fr; gap: 8px; }
  }
</style>
