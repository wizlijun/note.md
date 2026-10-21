<script lang="ts">
  import { onDestroy, tick } from 'svelte'
  import EventAssessment from './EventAssessment.svelte'
  import EventEditor from './EventEditor.svelte'
  import type { TimelineItem } from '../parser'
  import type { EventEdit } from '../edit-document'
  import { formatDuration, formatTime } from '../layout'
  import { classifyItem, CATEGORIES, type ClassificationRule } from '../classification'

  let { item, rules, zh, onclose, onlink, editable = false, onsave, onediting }: {
    item: TimelineItem
    rules: ClassificationRule[]
    zh: boolean
    onclose: () => void
    onlink: (target: string) => Promise<void>
    editable?: boolean
    onsave?: (item: TimelineItem, edit: EventEdit) => Promise<void>
    onediting?: (editing: boolean) => void
  } = $props()
  const classification = $derived(classifyItem(item, rules))
  const category = $derived(CATEGORIES.find((entry) => entry.id === classification.category)!)
  const categoryNames: Record<string, string> = { work: 'Work', interest: 'Interests', life: 'Life', leisure: 'Leisure', other: 'Other' }
  let error = $state('')
  let editing = $state<TimelineItem | null>(null)
  let saving = $state(false)
  let detail: HTMLElement | undefined
  let editId: string | undefined
  let disposed = false

  async function beginEdit(value: TimelineItem) {
    if (editing || !editable || !onsave) return
    editId = value.id
    editing = value
    onediting?.(true)
    await tick()
    if (!disposed && editing?.id === value.id) detail?.querySelector<HTMLInputElement>('.event-editor input')?.focus()
  }

  async function finishEdit() {
    if (disposed) return
    editing = null
    onediting?.(false)
    await tick()
    const trigger = [...(detail?.querySelectorAll<HTMLButtonElement>('.edit-event') ?? [])].find(button => button.dataset.editId === editId)
    trigger?.focus()
  }

  async function save(value: TimelineItem, edit: EventEdit) {
    if (!onsave) throw new Error(zh ? '请更新 note.md 后重试。' : 'Update note.md and try again.')
    await onsave(value, edit)
    await finishEdit()
  }

  function close() { if (!editing && !saving) onclose() }
  function cancel() { if (!saving) void finishEdit() }

  onDestroy(() => { disposed = true; if (editing) onediting?.(false) })

  async function follow(target: string) {
    if (editing) return
    error = ''
    try { await onlink(target) }
    catch (cause) { error = `${zh ? '无法打开来源：' : 'Could not open source: '}${cause instanceof Error ? cause.message : String(cause)}` }
  }
</script>

{#snippet entry(value: TimelineItem, nested: boolean)}
  <div class:child={nested} class="entry">
    {#if nested}
      <div class="child-heading"><strong>{value.action || (zh ? '活动' : 'Activity')}</strong><span>{formatTime(value.start)}–{formatTime(value.end)}</span></div>
    {/if}
    {#if editing?.id === value.id}
      {#key value.id}<EventEditor item={value} {zh} onsave={(edit) => save(value, edit)} oncancel={cancel} onbusy={(busy) => { saving = busy }} />{/key}
    {:else if editable && onsave}
      <button class="edit-event" data-edit-id={value.id} disabled={!!editing} aria-label={`${zh ? '编辑' : 'Edit'} ${value.action || value.text}`} onclick={() => beginEdit(value)}>{zh ? '编辑' : 'Edit'}</button>
    {/if}
    <p class="entry-text">{value.text}</p>
    <EventAssessment item={value} {zh} />
    {#if value.links.length}
      <div class="sources" aria-label={zh ? '来源' : 'Sources'}>
        {#each value.links as link}
          <button class="source-link" disabled={!!editing} title={link.target} onclick={() => follow(link.target)}><span aria-hidden="true">↗</span> {link.label || (zh ? '来源' : 'Source')}</button>
        {/each}
      </div>
    {/if}
    {#each value.children as child (child.id)}{@render entry(child, true)}{/each}
  </div>
{/snippet}

<svelte:window onkeydown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (editing) cancel(); else close() } }} />

<aside bind:this={detail} class="detail" aria-labelledby="detail-title">
  <div class="detail-top"><span class="category" data-category={category.id}>{zh ? category.label : categoryNames[category.id]}</span><button class="close" disabled={!!editing} aria-label={zh ? '关闭详情' : 'Close details'} onclick={close}>×</button></div>
  <h2 id="detail-title">{item.action || classification.action || (zh ? '活动' : 'Activity')}</h2>
  <div class="time-range">{formatTime(item.start)} <span>—</span> {formatTime(item.end)}<span class="duration">{formatDuration(item, zh)}</span></div>
  <p class="source-limit">{zh ? '来源按钮仅打开文件，当前不能定位行号；证据 ID 与行号保留供核对。' : 'Source buttons open files only and cannot navigate to line numbers; evidence IDs and line numbers are retained for review.'}</p>
  {#if !editable}<p class="edit-limit">{zh ? '当前视图为只读；编辑卡片需要支持此功能的新版 note.md。' : 'This view is read-only. Update note.md to a version that supports editing cards.'}</p>{/if}
  {@render entry(item, false)}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</aside>

<style>
  .detail { border-left: 1px solid var(--ui-separator); background: var(--ui-surface); padding: 20px; overflow-y: auto; min-width: 0; height: 100%; box-sizing: border-box; }
  .detail-top { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
  .category { border: 1px solid var(--category-border); background: var(--category-bg); color: CanvasText; border-radius: 5px; padding: 3px 8px; font-size: 11px; }
  .close { width: 28px; height: 28px; border: 0; background: transparent; border-radius: 6px; color: var(--ui-secondary); font-size: 21px; cursor: pointer; }
  .close:hover { background: var(--ui-hover); }
  button:disabled { cursor: default; opacity: .45; }
  .edit-event { border: 1px solid var(--ui-separator); background: var(--ui-bg); color: var(--ui-accent-text); border-radius: 6px; padding: 4px 9px; font: inherit; font-size: 11px; cursor: pointer; margin-top: 10px; }
  .edit-event:hover:not(:disabled) { background: var(--ui-selection); }
  h2 { font-size: 19px; line-height: 1.45; margin: 18px 0 8px; overflow-wrap: anywhere; }
  .time-range { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; font-size: 12px; font-variant-numeric: tabular-nums; padding-bottom: 20px; border-bottom: 1px solid var(--ui-separator); }
  .time-range > span { color: var(--ui-tertiary); }
  .duration { margin-left: auto; }
  .entry-text { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.8; margin: 16px 0 10px; }
  .sources { display: flex; align-items: flex-start; flex-wrap: wrap; gap: 6px; margin: 8px 0 16px; }
  .source-link { border: 1px solid var(--ui-separator); background: var(--ui-bg); color: var(--ui-accent-text); padding: 5px 8px; border-radius: 5px; text-align: left; font-size: 11px; max-width: 100%; overflow-wrap: anywhere; cursor: pointer; }
  .source-link:hover { background: var(--ui-selection); }
  .child { margin: 16px 0 0; padding-left: 12px; border-left: 2px solid var(--ui-separator); }
  .child-heading { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; font-size: 12px; }
  .child-heading span { color: var(--ui-tertiary); font-size: 10px; font-variant-numeric: tabular-nums; }
  .child .entry-text { margin-top: 6px; }
  .source-limit, .edit-limit { color: var(--ui-secondary); font-size: 10px; line-height: 1.6; }
  .error { color: var(--ui-danger); overflow-wrap: anywhere; }
  @media (max-width: 780px) { .detail { border-left: 0; border-bottom: 1px solid var(--ui-separator); height: auto; max-height: 42vh; padding: 14px 20px; } h2 { margin-top: 8px; } }
</style>
