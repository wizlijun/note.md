<script lang="ts">
  import { untrack } from 'svelte'
  import type { Tab } from '../../lib/tabs.svelte'
  import { openFile } from '../../lib/tabs.svelte'
  import { guestForTab, rememberGuest, guestState, guestErrorCode } from '../../lib/share-guest/state.svelte'
  import { canSubmitGuest, guestCommand, submitGuest, guestReceipts, type GuestPreview, type GuestReceipt } from '../../lib/share-guest/host'
  import { t } from '../../lib/i18n/store.svelte'
  import { save } from '@tauri-apps/plugin-dialog'
  import { writeTextFile } from '@tauri-apps/plugin-fs'
  let { tab }: { tab: Tab | null } = $props()
  const info = $derived(guestForTab(tab))
  let allowed = $state(false), busy = $state(false), message = $state(''), name = $state(''), notice = $state('')
  let receipts = $state<GuestReceipt[]>([]), preview = $state<GuestPreview | undefined>()
  const projectKey = $derived(info ? info.root + '#' + info.snapshotId : '')
  let generation = 0
  let resolveConfirm: ((yes: boolean) => void) | undefined
  $effect(() => {
    projectKey
    generation++
    busy = false
    const current = untrack(() => info)
    allowed = false; receipts = []; notice = ''
    let disposed = false
    if (current) {
      void canSubmitGuest(current).then(value => { if(!disposed) allowed = value }).catch(() => {})
      void guestCommand<{changed:boolean}>('check-version',{root:current.root}).then(result => {
        if(!disposed && result.changed) notice = t('guest.updateAvailable')
      }).catch(error => { if(!disposed) notice = errorLabel(error) })
    }
    return () => { generation++; disposed = true; resolveConfirm?.(false); resolveConfirm = undefined; preview = undefined }
  })
  function errorLabel(error: unknown): string {
    const code = guestErrorCode(error)
    if (code === 'GUEST_HTTP_409' || code === 'GUEST_PENDING_CONFLICT') return t('guest.conflict')
    if (code === 'GUEST_HTTP_403' || code === 'GUEST_READ_ONLY') return t('guest.forbidden')
    if (code === 'GUEST_HTTP_410') return t('guest.expired')
    if (code === 'GUEST_HTTP_404') return t('guest.notFound')
    return t('guest.failed')
  }
  function confirm(value: GuestPreview): Promise<boolean> {
    preview = value
    return new Promise(resolve => { resolveConfirm = resolve })
  }
  function decide(yes: boolean) { preview = undefined; resolveConfirm?.(yes); resolveConfirm = undefined }
  async function send() {
    if (!info || !tab || !allowed || busy) return
    const root = info.root, tabId = tab.id, previousId = info.lastSubmissionId, run = generation
    busy = true; notice = ''
    try {
      const next = await submitGuest(root, tabId, message, name, value => run === generation ? confirm(value) : Promise.resolve(false))
      if (run === generation) {
        rememberGuest(next)
        notice = next.outbox.length ? t('guest.pending') : t(next.lastSubmissionId !== previousId ? 'guest.sent' : 'guest.cancelled')
      }
    } catch (error) {
      if (run === generation) {
        notice = errorLabel(error)
        try { const next = await guestCommand<import('../../lib/share-guest/types').GuestInfo>('inspect',{root}); if(run === generation) rememberGuest(next) } catch {}
      }
    } finally { if(run === generation) busy = false }
  }
  async function check() {
    if (!info || busy) return
    const run = generation
    busy = true
    try { const result = await guestCommand<{changed:boolean}>('check-version',{root:info.root}); if(run === generation) notice = t(result.changed ? 'guest.updateAvailable' : 'guest.upToDate') }
    catch (error) { if(run === generation) notice = errorLabel(error) }
    finally { if(run === generation) busy = false }
  }
  async function loadReceipts() {
    if (!info || !allowed || busy) return
    const run = generation
    busy = true
    try { const next = await guestReceipts(info.root, [...info.submitted]); if(run === generation) { receipts = next; notice = '' } }
    catch (error) { if(run === generation) notice = errorLabel(error) }
    finally { if(run === generation) busy = false }
  }
  async function exportPending() {
    const pending = info?.outbox[0]
    if (!pending) return
    try { const path = await save({defaultPath:pending.submissionId+'.json'}); if(path) await writeTextFile(path,pending.body) }
    catch { notice = t('guest.exportFailed') }
  }
</script>
{#if info}
  <section class="guest-panel" aria-label={t('guest.title')}>
    <p>{t('guest.base')}: {info.snapshotId}</p>
    {#if !allowed}<p>{t('guest.readOnly')}</p>{/if}
    {#if info.outbox.length}<p>{t('guest.pending')}</p><button onclick={exportPending}>{t('guest.export')}</button>{/if}
    {#if guestState.statuses[info.root]}<p role="status">{errorLabel(guestState.statuses[info.root])}</p>{/if}
    <label>{t('guest.name')}<input bind:value={name} maxlength="80" disabled={!allowed || busy} /></label>
    <label>{t('guest.message')}<textarea bind:value={message} maxlength="2000" disabled={!allowed || busy}></textarea></label>
    <button disabled={!allowed || busy} onclick={send}>{t('guest.submit')}</button>
    <button disabled={busy} onclick={check}>{t('guest.check')}</button>
    <button disabled={!allowed || busy} onclick={loadReceipts}>{t('guest.submissions')}</button>
    {#if preview}
      <div role="alert">
        {#if preview.ownerAnnotationsTouched.length}<p>{t('guest.ownerWarning',{count:preview.ownerAnnotationsTouched.reduce((n,item)=>n+item.raw.length,0)})}</p>{/if}
        {#if preview.added.length}<p>{t('guest.addedWarning')}: {preview.added.join(', ')}</p>{/if}
        {#if preview.missing.length}<p>{t('guest.missingWarning')}: {preview.missing.join(', ')}</p>{/if}
        <button onclick={() => decide(false)}>{t('guest.cancel')}</button><button onclick={() => decide(true)}>{t('guest.continue')}</button>
      </div>
    {/if}
    {#if notice}<p role="status">{notice}</p>{/if}
    {#each receipts as row}
      <div class="receipt"><strong>{row.submissionId}</strong>
        {#if row.status === 404}<p>{t('guest.waiting')}</p>
        {:else if row.status !== 200}<p>{errorLabel('GUEST_HTTP_'+row.status)}</p>
        {:else if row.receipt}<p>{t(`guest.outcome.${row.receipt.outcome}`)} {row.receipt.files.reduce((n,f)=>n+f.accepted,0)}/{row.receipt.files.reduce((n,f)=>n+f.total,0)}</p><p>{row.receipt.reply ?? ''}</p>{/if}
      </div>
    {/each}
    <ul>{#each info.files.filter(file=>file.path.endsWith('.md')) as file}<li><button onclick={() => openFile(info!.root+'/'+file.path)}>{file.path}</button></li>{/each}</ul>
  </section>
{/if}
<style>
  .guest-panel { padding: 12px; font-size: 13px; overflow-wrap: anywhere; }
  label { display: grid; gap: 4px; margin: 12px 0; } input,textarea { width: 100%; box-sizing: border-box; }
  button { margin: 3px; } ul { padding-left: 12px; } .receipt p { white-space: pre-wrap; }
</style>
