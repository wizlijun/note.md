<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import type { ReminderInput, ReminderView } from '../lib/reminders'
  import type { WorkspaceItem } from '../lib/repository'
  import { t, type MessageKey } from '../lib/strings'
  import { localDateTimeValue, localTimeZone, resolvePauseTime } from './reminder-time'

  let { item, view, saving, onCancel, onSubmit }: {
    item: WorkspaceItem
    view: ReminderView
    saving: boolean
    onCancel(): void
    onSubmit(input: ReminderInput): Promise<void>
  } = $props()

  const initial = untrack(() => view)
  const timeZone = localTimeZone()
  let policy = $state<'enabled' | 'muted'>(initial.policy)
  const initialPauseDraft = initial.status === 'paused' && initial.pausedUntil ? localDateTimeValue(initial.pausedUntil, timeZone) : ''
  let pausedUntil = $state(initialPauseDraft)
  let submitting = $state(false)
  let error = $state<MessageKey | null>(null)
  let errorDetail = $state('')
  let sheetEl: HTMLDivElement
  let formEl: HTMLFormElement | undefined = $state()
  let policyEl: HTMLSelectElement | undefined = $state()
  const closed = $derived(item.state === 'closed')
  const readonly = $derived(closed || item.state === 'unsupported' || view.status === 'legacy' || view.status === 'error')
  const busy = $derived(saving || submitting)
  const due = $derived(item.due ?? item.task?.due)
  const status = $derived(closed ? 'closed' : view.status)

  async function submit(event: SubmitEvent) {
    event.preventDefault()
    if (busy || readonly) return
    error = null
    errorDetail = ''
    let paused: string | undefined
    if (policy === 'enabled' && pausedUntil) {
      if (pausedUntil === initialPauseDraft && initial.pausedUntil) {
        // An unchanged stored instant retains its seconds and explicit DST occurrence.
        const instant = Date.parse(initial.pausedUntil)
        if (!Number.isFinite(instant) || instant <= Date.now()) {
          error = Number.isFinite(instant) ? 'reminder.validation.past' : 'reminder.validation.invalid'
          return
        }
        paused = initial.pausedUntil
      } else {
        const result = resolvePauseTime(pausedUntil, new Date(), timeZone)
        if (!result.ok) {
          error = `reminder.validation.${result.reason}`
          return
        }
        paused = result.iso
      }
    }
    submitting = true
    try {
      await onSubmit({ policy, ...(paused ? { paused_until: paused } : {}) })
    } catch (failure) {
      error = 'reminder.saveError'
      errorDetail = String(failure)
    } finally {
      submitting = false
    }
  }

  onMount(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    queueMicrotask(() => {
      if (!readonly && policyEl) policyEl.focus()
      else sheetEl?.focus()
    })
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) {
        event.preventDefault()
        onCancel()
        return
      }
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !busy && !readonly) {
        event.preventDefault()
        formEl?.requestSubmit()
        return
      }
      if (event.key !== 'Tab' || !sheetEl) return
      const focusable = [...sheetEl.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled)')]
      if (!focusable.length) {
        event.preventDefault()
        sheetEl.focus()
        return
      }
      const first = focusable[0]
      const last = focusable.at(-1)!
      if (!focusable.includes(document.activeElement as HTMLElement)) {
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      previousFocus?.focus()
    }
  })
</script>

<div class="scrim" role="presentation" onclick={(event) => event.target === event.currentTarget && !busy && onCancel()}>
  <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="reminder-title" aria-busy={busy} tabindex="-1" bind:this={sheetEl}>
    <header>
      <h2 id="reminder-title">{t('reminder.title', { title: item.title })}</h2>
      {#if !readonly}<button type="button" class="close" aria-label={t('common.cancel')} disabled={busy} onclick={onCancel}>×</button>{/if}
    </header>
    <div class="summary">
      <dl>
        <dt>{t('reminder.due')}</dt><dd data-reminder-due>{due || t('reminder.noDue')}</dd>
        <dt>{t('reminder.state')}</dt><dd data-reminder-status>{t(`reminder.status.${status}`, { time: view.pausedUntil ? localDateTimeValue(view.pausedUntil, timeZone).replace('T', ' ') : '' })}</dd>
      </dl>
      {#if closed}<p>{t('reminder.closedHelp')}</p>{/if}
      {#if item.state === 'unsupported'}<p>{t('reminder.unsupportedHelp')}</p>{/if}
      {#if view.status === 'legacy'}<p>{t('reminder.legacyHelp')}</p>{/if}
      {#if view.status === 'error'}<p role="alert">{t('reminder.errorHelp')}{view.error ? ` ${view.error}` : ''}</p>{/if}
      {#if !readonly}
        <p>{t('reminder.help')}</p>
        <p>{t('reminder.resumeHelp')}</p>
      {/if}
      <p>{t('reminder.syncHelp')}</p>
    </div>
    {#if readonly}
      <footer class="readonly-footer">
        <button type="button" class="cancel" disabled={busy} onclick={onCancel}>{t('common.close')}</button>
      </footer>
    {:else}
      <form data-form="reminder" bind:this={formEl} onsubmit={submit}>
        <label for="reminder-policy">{t('reminder.policy')}</label>
        <select id="reminder-policy" name="reminderPolicy" bind:this={policyEl} value={policy} onchange={(event) => policy = event.currentTarget.value as 'enabled' | 'muted'} disabled={busy}>
          <option value="enabled">{t('reminder.status.automatic')}</option>
          <option value="muted">{t('reminder.mute')}</option>
        </select>
        <label for="reminder-pause">{t('reminder.pauseUntil')}</label>
        <input id="reminder-pause" name="pausedUntil" type="datetime-local" bind:value={pausedUntil}
          disabled={busy || policy === 'muted'} aria-describedby="reminder-timezone" />
        <p id="reminder-timezone" class="wide help">{t('reminder.timeZone', { zone: timeZone })}</p>
        {#if error}<p class="wide error" role="alert">{t(error)}{errorDetail ? ` ${errorDetail}` : ''}</p>{/if}
        <footer>
          <button type="button" class="cancel" disabled={busy} onclick={onCancel}>{t('common.cancel')}</button>
          <button type="submit" class="submit" disabled={busy}>{t('reminder.save')}</button>
        </footer>
      </form>
    {/if}
  </div>
</div>

<style>
  .scrim { position: fixed; inset: 0; z-index: 20; display: grid; place-items: center; padding: 24px; background: color-mix(in srgb, #000 32%, transparent); backdrop-filter: blur(8px); }
  .sheet { width: min(560px, 100%); max-height: calc(100vh - 48px); overflow: auto; box-sizing: border-box; border: 1px solid var(--line); border-radius: 20px; background: var(--sheet); color: var(--fg); box-shadow: 0 24px 80px color-mix(in srgb, #000 30%, transparent); }
  header { display: flex; justify-content: space-between; gap: 16px; padding: 22px 24px 16px; }
  h2 { margin: 0; font-size: 19px; line-height: 1.3; }
  .close { flex: none; width: 28px; height: 28px; border: none; border-radius: 50%; background: var(--chip); color: var(--muted-strong); font-size: 20px; line-height: 1; cursor: pointer; }
  .summary { padding: 0 24px 18px; font-size: 12px; color: var(--muted); }
  dl { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 8px 14px; margin: 0 0 14px; color: var(--fg); }
  dt { font-weight: 650; }
  dd { margin: 0; overflow-wrap: anywhere; }
  p { margin: 7px 0 0; line-height: 1.5; overflow-wrap: anywhere; }
  form { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: 12px 14px; padding: 20px 24px 22px; border-top: 1px solid var(--line); }
  label { font-size: 12px; font-weight: 650; }
  input, select { width: 100%; box-sizing: border-box; border: 1px solid var(--line-strong); border-radius: 11px; background: var(--input); color: var(--fg); padding: 10px 12px; font: inherit; outline: none; }
  input:focus, select:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
  input:disabled, select:disabled { opacity: 0.6; }
  .wide { grid-column: 1 / -1; }
  .help { font-size: 12px; color: var(--muted); }
  .error { font-size: 12px; color: var(--danger); }
  footer { grid-column: 1 / -1; display: flex; justify-content: flex-end; gap: 8px; padding-top: 8px; }
  .readonly-footer { padding: 4px 24px 22px; }
  footer button { border-radius: 9px; padding: 8px 14px; font: inherit; font-weight: 650; cursor: pointer; }
  button:disabled { opacity: 0.45; cursor: default; }
  .cancel { border: 1px solid var(--line); background: transparent; color: var(--fg); }
  .submit { border: 1px solid var(--accent); background: var(--accent); color: #fff; }
  @media (max-width: 520px) { form { grid-template-columns: 1fr; } }
</style>
