<script lang="ts">
  import { parseFolderRules } from '../lib/home-content/model'
  import { clearAutomaticFolderExclusion, saveNewContentFolders, type NewContentFolderSettings } from '../lib/home-content/store.svelte'
  import { t } from '../lib/i18n/store.svelte'

  let { settings }: { settings: NewContentFolderSettings } = $props()
  let panel: HTMLDetailsElement | undefined
  let summary: HTMLElement | undefined
  let include = $state('')
  let exclude = $state('')
  let invalid = $state(false)
  let saving = $state(false)

  function resetDraft() {
    if (!panel?.open) return
    include = settings.include.join('\n')
    exclude = settings.exclude.join('\n')
    invalid = false
  }

  function closePanel() {
    if (panel) panel.open = false
    summary?.focus()
  }

  async function commit(run: () => Promise<void>, close = false) {
    if (saving) return
    saving = true
    try {
      await run()
      if (close) closePanel()
    } catch { /* The store exposes persistence errors on the home page. */ }
    finally { saving = false }
  }

  function save(event: SubmitEvent) {
    event.preventDefault()
    const included = parseFolderRules(include), excluded = parseFolderRules(exclude)
    invalid = included === null || excluded === null
    if (included === null || excluded === null) return
    void commit(() => saveNewContentFolders(settings.root, included, excluded), true)
  }
</script>

<details class="folder-rules" bind:this={panel} ontoggle={resetDraft}>
  <summary bind:this={summary}>{t('homeContent.folderRules')}</summary>
  <form onsubmit={save}>
    <p>{t('homeContent.folderHint')}</p>
    <label>
      {t('homeContent.folderInclude')}
      <textarea rows="3" bind:value={include} disabled={saving} aria-describedby="new-content-include-hint"></textarea>
    </label>
    <p id="new-content-include-hint">{t('homeContent.folderIncludeHint')}</p>
    <label>
      {t('homeContent.folderExclude')}
      <textarea rows="3" bind:value={exclude} disabled={saving}></textarea>
    </label>
    {#if invalid}<p class="folder-error" role="alert">{t('homeContent.folderInvalid')}</p>{/if}
    <div class="folder-actions">
      <button type="button" class="home-control" disabled={saving} onclick={closePanel}>{t('common.cancel')}</button>
      <button type="submit" class="home-control" disabled={saving}>{t('dialog.save')}</button>
    </div>
  </form>
  <div class="folder-automatic">
    <h3>{t('homeContent.folderAutomatic')}</h3>
    <p>{t('homeContent.folderAutomaticHint')}</p>
    {#if settings.automatic.length}
      <ul>
        {#each settings.automatic as folder (folder)}
          <li>
            <span>{folder}</span>
            <button class="home-control" disabled={saving} aria-label={t('homeContent.folderRestore', { path: folder })} onclick={() => void commit(() => clearAutomaticFolderExclusion(settings.root, folder))}>{t('homeContent.folderRestoreButton')}</button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</details>

<style>
  .folder-rules { margin:0 0 10px; font-size:12px; }
  summary { width:fit-content; color:GrayText; cursor:pointer; }
  form { display:grid; gap:8px; margin-top:8px; }
  form, .folder-automatic { padding:10px; border:1px solid color-mix(in srgb,CanvasText 10%,transparent); border-radius:8px; }
  label { display:grid; gap:4px; font-weight:500; }
  textarea { box-sizing:border-box; width:100%; resize:vertical; padding:6px 8px; border:1px solid color-mix(in srgb,CanvasText 18%,transparent); border-radius:5px; background:Canvas; color:CanvasText; font:inherit; }
  p { margin:0; color:GrayText; line-height:1.5; }
  .folder-error { color:var(--ui-danger,#b3261e); }
  .folder-actions { display:flex; justify-content:flex-end; gap:6px; }
  .folder-automatic { margin-top:6px; }
  h3 { margin:0 0 4px; font-size:12px; font-weight:600; }
  ul { display:grid; gap:4px; margin:6px 0 0; padding:0; list-style:none; }
  li { display:flex; align-items:center; justify-content:space-between; gap:8px; overflow-wrap:anywhere; }
  li button { flex:none; }
</style>
