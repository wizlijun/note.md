<script lang="ts">
  import { untrack } from 'svelte'
  import type { TimelineItem, TimelineImportance } from '../parser'
  import type { EventEdit } from '../edit-document'

  let { item, zh, onsave, oncancel, onbusy }: {
    item: TimelineItem
    zh: boolean
    onsave: (edit: EventEdit) => Promise<void>
    oncancel: () => void
    onbusy: (busy: boolean) => void
  } = $props()

  function editTime(minutes: number): string {
    const seconds = Math.round(minutes * 60)
    const hh = String(Math.floor(seconds / 3600)).padStart(2, '0')
    const mm = String(Math.floor(seconds / 60) % 60).padStart(2, '0')
    return `${hh}:${mm}${seconds % 60 ? `:${String(seconds % 60).padStart(2, '0')}` : ''}`
  }

  // This component is keyed by event ID in TimelineDetail, so each draft starts once.
  let start = $state(untrack(() => editTime(item.start)))
  let end = $state(untrack(() => editTime(item.end)))
  let title = $state(untrack(() => item.action))
  let text = $state(untrack(() => item.text))
  let importance = $state<TimelineImportance>(untrack(() => item.metadata.importance))
  let busy = $state(false)
  let error = $state('')

  function seconds(value: string): number | null {
    const parts = value.trim().match(/^(\d{2}):([0-5]\d)(?::([0-5]\d))?$/)
    if (!parts) return null
    const result = Number(parts[1]) * 3600 + Number(parts[2]) * 60 + Number(parts[3] ?? 0)
    return result <= 86400 ? result : null
  }

  async function save(event: SubmitEvent) {
    event.preventDefault()
    if (busy) return
    error = ''
    const startSeconds = seconds(start)
    const endSeconds = seconds(end)
    if (startSeconds === null || endSeconds === null) {
      error = zh ? '时间格式应为 HH:mm 或 HH:mm:ss，范围为 00:00 至 24:00。' : 'Use HH:mm or HH:mm:ss between 00:00 and 24:00.'
      return
    }
    if (endSeconds < startSeconds) {
      error = zh ? '结束时间不能早于开始时间。' : 'End time cannot be earlier than start time.'
      return
    }
    if (!title.trim() && !text.trim()) {
      error = zh ? '标题和事件描述不能同时为空。' : 'Enter a title or event description.'
      return
    }
    if (/[\r\n]/.test(title) || /[\r\n]/.test(text)) {
      error = zh ? '标题和事件描述需各自保持一行，请删除换行后保存。' : 'Keep the title and event description on one line each.'
      return
    }
    busy = true
    onbusy(true)
    try { await onsave({ start: start.trim(), end: end.trim(), title: title.trim(), text: text.trim(), importance }) }
    catch (cause) { error = `${zh ? '保存失败：' : 'Could not save: '}${cause instanceof Error ? cause.message : String(cause)}` }
    finally { busy = false; onbusy(false) }
  }
</script>

<form class="event-editor" aria-label={zh ? '编辑事件' : 'Edit event'} aria-busy={busy} onsubmit={save}>
  <fieldset disabled={busy}>
    <label>{zh ? '标题' : 'Title'}<input aria-label={zh ? '标题' : 'Title'} bind:value={title} placeholder={zh ? '活动' : 'Activity'} autocomplete="off" /></label>
    <label>{zh ? '事件描述' : 'Event description'}<textarea aria-label={zh ? '事件描述' : 'Event description'} bind:value={text} rows="3"></textarea></label>
    <div class="times">
      <label>{zh ? '开始时间' : 'Start time'}<input aria-label={zh ? '开始时间' : 'Start time'} bind:value={start} inputmode="numeric" placeholder="09:00:00" autocomplete="off" spellcheck="false" /></label>
      <label>{zh ? '结束时间' : 'End time'}<input aria-label={zh ? '结束时间' : 'End time'} bind:value={end} inputmode="numeric" placeholder="10:00:00" autocomplete="off" spellcheck="false" /></label>
    </div>
    <label>{zh ? '重要程度' : 'Importance'}<select aria-label={zh ? '重要程度' : 'Importance'} bind:value={importance}>
      <option value="high">{zh ? '重要' : 'High'}</option>
      <option value="normal">{zh ? '普通' : 'Normal'}</option>
      <option value="unknown">{zh ? '待判断' : 'Unknown'}</option>
    </select></label>
    <p class="edit-hint">{zh ? '标题对应卡片的活动名称，事件描述限单行。手动调整重要程度会保留原有来源证据。' : 'The title is the activity name on the card; the description must be a single line. Manual importance changes preserve existing source evidence.'}</p>
    <div class="actions"><button type="button" onclick={oncancel}>{zh ? '取消' : 'Cancel'}</button><button type="submit" class="save">{busy ? (zh ? '保存中…' : 'Saving…') : (zh ? '保存' : 'Save')}</button></div>
  </fieldset>
  {#if error}<p class="edit-error" role="alert">{error}</p>{/if}
</form>

<style>
  .event-editor { margin: 12px 0; padding: 12px; border: 1px solid var(--ui-separator); border-radius: 8px; background: var(--ui-bg); }
  fieldset { border: 0; padding: 0; margin: 0; min-width: 0; display: grid; gap: 12px; }
  label { display: flex; flex-direction: column; gap: 5px; min-width: 0; color: var(--ui-secondary); font-size: 11px; }
  input, select, textarea { box-sizing: border-box; width: 100%; min-width: 0; padding: 7px 8px; border: 1px solid var(--ui-separator); border-radius: 6px; background: var(--ui-surface); color: CanvasText; font: inherit; font-size: 13px; }
  textarea { resize: vertical; line-height: 1.6; }
  input:focus-visible, select:focus-visible, textarea:focus-visible, button:focus-visible { outline: 2px solid var(--ui-accent-text); outline-offset: 2px; }
  .times { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .times input { font-variant-numeric: tabular-nums; }
  .edit-hint { margin: 0; font-size: 10px; color: var(--ui-secondary); line-height: 1.6; }
  .actions { display: flex; justify-content: flex-end; gap: 8px; }
  button { border: 1px solid var(--ui-separator); border-radius: 6px; background: var(--ui-surface); color: CanvasText; padding: 6px 12px; font: inherit; font-size: 12px; cursor: pointer; }
  button:hover { background: var(--ui-hover); }
  button.save { color: var(--ui-accent-text); background: var(--ui-selection); }
  fieldset:disabled { opacity: .65; }
  fieldset:disabled button { cursor: wait; }
  .edit-error { color: var(--ui-danger); font-size: 12px; line-height: 1.6; margin: 10px 0 0; overflow-wrap: anywhere; }
</style>
