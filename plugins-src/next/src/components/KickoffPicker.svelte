<script lang="ts">
  import AgentPicker from '../lib/agent-picker/AgentPicker.svelte'
  import type { AgentOption } from '../lib/agent-picker/types'
  import type { DataSource } from '../lib/kickoff/template'
  import { KICKOFF_SAFETY_REASON } from '../lib/kickoff/client'
  import { t, type MessageKey } from '../lib/strings'

  let { options, selected, dataSources, onSelect, onClose, anchor }: {
    options: AgentOption[]
    selected: string
    dataSources: DataSource[]
    onSelect(id: string): void
    anchor?: HTMLElement | null
    onClose(): void
  } = $props()
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

</script>

{#snippet sources()}
  <div class="sources">
    {#if !options.length}<p>{t('kickoff.failure.agent-missing')}</p><p>{t('kickoff.market')}</p>{/if}
    <strong>{t('kickoff.dataSources')}</strong>
    {#if dataSources.some((source) => source.fallback)}<p role="status">{t('kickoff.sourceFallback')}</p>{/if}
    {#each dataSources as source}<p>{sourceLabel(source)}{#if !source.enabled} · {t('kickoff.sourceDisabled')}{/if}</p>{/each}
  </div>
{/snippet}

<AgentPicker options={localized} {selected} {label} {anchor} onselect={onSelect} onclose={onClose}
  initialOpen={true} disableUnavailable={true} footer={sources} />

<style>
  .sources { font-size: 12px; line-height: 1.6; color: var(--muted-strong); }
  .sources p { margin: 4px 0; }
</style>
