<script module lang="ts">
  import type { Diagnostic } from '../lib/types'

  export type DiagnosticsText = (key: string, values?: Record<string, string | number>) => string

  export interface DiagnosticsViewProps {
    diagnostics: readonly Diagnostic[]
    browseableCount?: number
    isolatedCount?: number
    referenceIssueCount?: number
    text: DiagnosticsText
    onSelect: (diagnostic: Diagnostic) => void
    onRetry?: () => void
  }
</script>

<script lang="ts">
  let {
    diagnostics,
    browseableCount = 0,
    isolatedCount = 0,
    referenceIssueCount = 0,
    text,
    onSelect,
    onRetry,
  }: DiagnosticsViewProps = $props()

  const errors = $derived(diagnostics.filter(item => item.severity === 'error').length)
  const warnings = $derived(diagnostics.length - errors)
</script>

<section class="diagnostics" aria-labelledby="diagnostics-heading">
  <header>
    <div>
      <h2 id="diagnostics-heading">{text('diagnostics.title')}</h2>
      <p>{text('diagnostics.summary', { errors, warnings })}</p>
    </div>
    {#if onRetry}<button type="button" onclick={onRetry}>{text('action.retry')}</button>{/if}
  </header>

  <div class="counts" aria-label={text('diagnostics.counts')}>
    <span>{text('diagnostics.browseable', { count: browseableCount })}</span>
    <span>{text('diagnostics.isolated', { count: isolatedCount })}</span>
    <span>{text('diagnostics.referenceIssues', { count: referenceIssueCount })}</span>
  </div>

  {#if diagnostics.length === 0}
    <p class="empty" role="status">{text('diagnostics.empty')}</p>
  {:else}
    <ol>
      {#each diagnostics as diagnostic, index (`${diagnostic.code}:${diagnostic.pointer}:${index}`)}
        <li class:error={diagnostic.severity === 'error'}>
          <button type="button" onclick={() => onSelect(diagnostic)}>
            <span class="topline">
              <strong>{text(`severity.${diagnostic.severity}`)}</strong>
              <code>{diagnostic.code}</code>
              {#if diagnostic.objectId}<code>{diagnostic.objectId}</code>{/if}
            </span>
            <span class="message">{diagnostic.message}</span>
            <span class="pointer">{diagnostic.pointer}</span>
            <span class="suggestion">{text('diagnostics.suggestion')}: {diagnostic.suggestion}</span>
          </button>
        </li>
      {/each}
    </ol>
  {/if}
</section>

<style>
  .diagnostics { min-width: 0; min-height: 0; overflow: auto; color: CanvasText; }
  header { display: flex; min-width: 0; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 16px 18px 10px; }
  h2 { margin: 0; font-size: 18px; }
  header p { margin: 5px 0 0; color: var(--ui-secondary, GrayText); font-size: 12px; }
  header button { flex: none; padding: 5px 10px; }

  .counts { display: flex; min-width: 0; flex-wrap: wrap; gap: 6px; padding: 0 18px 12px; }
  .counts span { padding: 3px 8px; border-radius: 999px; background: var(--ui-hover, color-mix(in srgb, CanvasText 7%, transparent)); color: var(--ui-secondary, GrayText); font-size: 12px; }
  ol { min-width: 0; margin: 0; padding: 0 18px 26px; list-style: none; }
  li { min-width: 0; margin: 8px 0; border-inline-start: 3px solid var(--ui-warning, #b26a00); }
  li.error { border-inline-start-color: var(--ui-danger, #b42318); }
  button { border: 1px solid var(--ui-control-border, color-mix(in srgb, CanvasText 20%, transparent)); border-radius: 7px; background: var(--ui-surface, Canvas); color: inherit; font: inherit; cursor: pointer; }
  button:hover { background: var(--ui-hover, color-mix(in srgb, CanvasText 7%, transparent)); }
  button:focus-visible { outline: 2px solid var(--ui-accent, AccentColor); outline-offset: 2px; }
  li button { display: grid; width: 100%; min-width: 0; gap: 5px; padding: 10px 12px; border-inline-start: 0; border-start-start-radius: 0; border-end-start-radius: 0; text-align: start; }
  .topline { display: flex; min-width: 0; flex-wrap: wrap; align-items: baseline; gap: 6px 9px; }
  .topline strong { color: var(--ui-warning, #8a5100); font-size: 12px; }
  li.error .topline strong { color: var(--ui-danger, #b42318); }
  code, .pointer { color: var(--ui-secondary, GrayText); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; overflow-wrap: anywhere; }
  .message, .suggestion { line-height: 1.45; overflow-wrap: anywhere; }
  .suggestion { color: var(--ui-secondary, GrayText); font-size: 12px; }
  .empty { padding: 36px 18px; color: var(--ui-secondary, GrayText); text-align: center; }

  @media (max-width: 639px) {
    header { flex-direction: column; padding-inline: 12px; }
    .counts, ol { padding-inline: 12px; }
  }
</style>
