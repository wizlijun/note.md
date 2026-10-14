<script lang="ts">
  import { untrack } from 'svelte'
  import HunkView from '../project-review/HunkView.svelte'
  import type { HunkDecision } from '../../lib/share-merge'
  import { composeGuest } from '../../lib/share-guest/update'
  import { updateGuest, resolveGuest, resolveGuestFile, type GuestUpdateView } from '../../lib/share-guest/host'
  import type { Tab } from '../../lib/tabs.svelte'
  import { openFile } from '../../lib/tabs.svelte'
  import { guestForTab, rememberGuest, guestState, guestErrorCode } from '../../lib/share-guest/state.svelte'
  import { isGuestMarkdownPath, canSubmitGuest, guestCommand, submitGuest, guestReceipts, type GuestPreview, type GuestReceipt } from '../../lib/share-guest/host'
  import { t } from '../../lib/i18n/store.svelte'
  import { save } from '@tauri-apps/plugin-dialog'
  import { writeTextFile } from '@tauri-apps/plugin-fs'
  let { tab }: { tab: Tab | null } = $props()
  const info = $derived(guestForTab(tab))
  let allowed = $state(false), busy = $state(false), message = $state(''), name = $state(''), notice = $state('')
  let receipts = $state<GuestReceipt[]>([]), preview = $state<GuestPreview | undefined>()
  const projectKey = $derived(info ? info.root + '#' + info.snapshotId : '')
  let updateView = $state<GuestUpdateView | undefined>(), decisions = $state<Record<string, Record<string,HunkDecision>>>({})
  let generation = 0
  let resolveConfirm: ((yes: boolean) => void) | undefined
  $effect(() => {
    projectKey
    generation++
    busy = false
    const current = untrack(() => info)
    const completed=untrack(()=>updateView)
    const keep=!!completed && completed.info.root===current?.root && completed.info.snapshotId===current?.snapshotId && !completed.info.pendingUpdate
    allowed=false;receipts=[];notice=keep?t('guest.updated'):'';message='';updateView=keep?completed:undefined;decisions={}
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
    if (['GUEST_INPUT_PENDING','GUEST_INPUT_CHANGED','GUEST_UPDATE_BUSY'].includes(code)) return t('guest.inputPending')
    if (code === 'GUEST_WORK_CHANGED') return t('guest.workChanged')
    if (code === 'GUEST_EDITOR_NOT_READY') return t('guest.editorNotReady')
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
  async function update(action?: () => Promise<GuestUpdateView>) {
    if (!info || busy || info.outbox.length) return
    const root=info.root, run=generation
    busy=true
    try {
      const next=await (action ? action() : updateGuest(root))
      if (run===generation) { updateView=next;rememberGuest(next.info);notice=t(next.info.pendingUpdate?'guest.updatePending':'guest.updated') }
    } catch(error) { if(run===generation) {notice=errorLabel(error);try {const next=await guestCommand<import('../../lib/share-guest/types').GuestInfo>('inspect',{root});if(run===generation)rememberGuest(next)} catch {}} }
    finally {if(run===generation) busy=false}
  }
  function resolved(file: NonNullable<GuestUpdateView['conflicts']>[number]): boolean {
    try {composeGuest(file.proposal,decisions[file.path]??{});return true} catch {return false}
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
    <button disabled={!allowed || busy || !!info.pendingUpdate} onclick={send}>{t('guest.submit')}</button>
    <button disabled={busy} onclick={check}>{t('guest.check')}</button>
    <button disabled={busy || !!info.outbox.length} onclick={() => update()}>{t(info.pendingUpdate ? 'guest.resumeUpdate' : 'guest.update')}</button>
    {#if updateView}
      {#each updateView.conflicts as file (file.path)}
        <h4>{file.path}</h4>
        {#each file.proposal.hunks.filter(h=>h.kind==='conflict') as hunk (hunk.id)}
          <HunkView {hunk} mode="guest" disabled={busy} decision={decisions[file.path]?.[hunk.id]} onDecide={(id,decision)=>decisions[file.path]={...decisions[file.path],[id]:decision}} />
        {/each}
        <button disabled={busy || !resolved(file)} onclick={() => update(()=>resolveGuest(info!.root,file.path,file.expectedHash,file.proposal,decisions[file.path]??{}))}>{t('guest.resolve')}</button>
      {/each}
      {#each updateView.rows.filter(row=>row.state!=='done' && !updateView!.conflicts.some(f=>f.path===row.sourcePath)) as row}
        <p>{row.sourcePath}: {t('guest.updatePending')}</p>
        <button disabled={busy} onclick={()=>update(()=>resolveGuestFile(info!.root,row.sourcePath,row.currentHash,'keep-local'))}>{t('guest.keepLocal')}</button>
        {#if row.canUseBase !== false}<button disabled={busy} onclick={()=>update(()=>resolveGuestFile(info!.root,row.sourcePath,row.currentHash,'use-base'))}>{t('guest.useBase')}</button>{/if}
      {/each}
      {#each updateView.rows.filter(row=>row.action==='retain-removed') as row}<p>{row.path}: {t('guest.removed')}</p>{/each}
    {/if}
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
    <ul>{#each info.files.filter(file=>isGuestMarkdownPath(file.path)) as file}<li><button onclick={() => openFile(info!.root+'/'+(info!.workPaths?.[file.path]??file.path))}>{file.path}</button>{#if info.workPaths?.[file.path]} <small>{info.workPaths[file.path]}</small>{/if}</li>{/each}</ul>
  </section>
{/if}
<style>
  .guest-panel { padding: 12px; font-size: 13px; overflow-wrap: anywhere; }
  label { display: grid; gap: 4px; margin: 12px 0; } input,textarea { width: 100%; box-sizing: border-box; }
  button { margin: 3px; } ul { padding-left: 12px; } .receipt p { white-space: pre-wrap; }
</style>
