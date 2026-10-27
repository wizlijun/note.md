<script lang="ts">
  import { onMount } from 'svelte'
  import AgentPicker from '../lib/agent-picker/AgentPicker.svelte'
  import type { AgentOption } from '../lib/agent-picker/types'
  import type { DataSource } from '../lib/kickoff/template'
  import { KICKOFF_SAFETY_REASON } from '../lib/kickoff/client'
  import { t, type MessageKey } from '../lib/strings'

  let { options, selected, dataSources, onSelect, onClose, returnFocus }: {
    options: AgentOption[]
    selected: string
    dataSources: DataSource[]
    onSelect(id: string): void
    returnFocus?: HTMLElement | null
    onClose(): void
  } = $props()
  let dialog: HTMLDivElement
  const localized = $derived(options.map((option) => ({
    ...option,
    harness: option.harness ? { ...option.harness, hint: option.harness.hint?.replace(KICKOFF_SAFETY_REASON, t('kickoff.unverifiedProvider')) } : option.harness,
  })))
  const label = (key: string, values?: Record<string, string | number>) => t(key.replace('agentPicker.', 'kickoff.picker.') as MessageKey, values)

  function sourceLabel(source: DataSource): string {
    if (source.fallback) return t('kickoff.source.taskOnly')
    // Only translate shipped labels. User-edited skill declarations keep their
    // own labels, including custom sources and scopes.
    const defaults: Record<string, string[]> = {
      task: ['任务文件及其 sources', '任务文件'],
      marks: ['批注笔记（你的判断）'],
      'done-tasks': ['同项目的已完成任务与完成笔记'],
      diary: ['日记与决策记录'],
    }
    return defaults[source.id]?.includes(source.label)
      ? t(`kickoff.source.${source.id}` as MessageKey) : source.label
  }

  onMount(() => {
    const previous = returnFocus?.isConnected ? returnFocus
      : document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialog.focus()
    return () => previous?.focus()
  })

  function keydown(event: KeyboardEvent) {
    if (event.key === 'Escape') onClose()
    if (event.key !== 'Tab') return
    const fields = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled)')]
    const first = fields[0]
    const last = fields.at(-1)!
    if (!fields.includes(document.activeElement as HTMLElement) || (event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
      event.preventDefault()
      ;(event.shiftKey ? last : first).focus()
    }
  }
</script>

{#snippet sources()}
  <div class="sources"><strong>{t('kickoff.dataSources')}</strong>
    {#if dataSources.some((source) => source.fallback)}<p role="status">{t('kickoff.sourceFallback')}</p>{/if}
    {#each dataSources as source}<p>{sourceLabel(source)}{#if !source.enabled} · {t('kickoff.sourceDisabled')}{/if}</p>{/each}
  </div>
{/snippet}

<svelte:window onkeydown={keydown} />
<div class="scrim" role="presentation" onclick={(event) => event.target === event.currentTarget && onClose()}>
  <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="kickoff-picker-title" tabindex="-1" bind:this={dialog}>
    <h2 id="kickoff-picker-title">{t('kickoff.picker.title')}</h2>
    {#if options.length}
      <AgentPicker options={localized} {selected} {label} onselect={onSelect} initialOpen={true} disableUnavailable={true} footer={sources} />
    {:else}
      <p>{t('kickoff.failure.agent-missing')}</p><p>{t('kickoff.market')}</p>
    {/if}
    {#if !options.length}{@render sources()}{/if}
    <button type="button" class="close" onclick={onClose}>{t('common.close')}</button>
  </div>
</div>

<style>
  .scrim { position: fixed; inset: 0; z-index: 100; display: grid; place-items: center; padding: 20px; background: #0005; }
  .sheet { width: min(480px, 100%); padding: 24px; box-sizing: border-box; border: 1px solid var(--line); border-radius: 18px; background: var(--sheet); color: var(--fg); box-shadow: 0 24px 80px #0004; }
  h2 { margin: 0 0 16px; font-size: 19px; }
  p, .sources { font-size: 12px; line-height: 1.6; color: var(--muted-strong); }
  .sources { margin-top: 12px; padding-top: 8px; border-top: 1px solid var(--line); }
  .sources p { margin: 4px 0; }
  .close { margin-top: 16px; padding: 8px 12px; border: 1px solid var(--line); border-radius: 8px; background: transparent; color: var(--fg); font: inherit; font-size: 12px; cursor: pointer; }
  .close:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
</style>
