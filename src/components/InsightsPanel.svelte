<script lang="ts">
  import { mkdir, writeTextFile, exists } from '@tauri-apps/plugin-fs'
  import { invoke } from '@tauri-apps/api/core'
  import { assembleRows, type InsightRow } from '../lib/insights/dashboard.svelte'
  import { presetRange, type Preset } from '../lib/insights/value'
  import { localTzOffsetMinutes, sessionMode } from '../lib/insights/model'
  import { flushNow } from '../lib/insights/tracker.svelte'
  import { buildDashboardDeps, fetchRowAudienceSessions } from '../lib/insights/run'
  import { fmtInterval } from '../lib/insights/report'
  import type { AudienceSession } from '../lib/insights/audience'
  import { sotvaultStore } from '../lib/sotvault.svelte'
  import { t } from '../lib/i18n/store.svelte'
  import { renderDailyReport } from '../lib/insights/report'
  import { openFile } from '../lib/tabs.svelte'
  import { pushToast } from '../lib/toast.svelte'

  let preset = $state<Preset | 'custom'>('7d')
  let fromDay = $state('')
  let toDay = $state('')
  let rows = $state<InsightRow[]>([])
  let loading = $state(false)
  let sortKey = $state<keyof InsightRow>('value')
  let sortDir = $state<1 | -1>(-1)
  let expanded = $state<string | null>(null)
  // Lazily-fetched audience reading intervals, per row docKey (only when expanded).
  let audSessions = $state<Record<string, AudienceSession[]>>({})
  let audLoading = $state<Record<string, boolean>>({})

  /** Toggle a row open/closed; on open, lazily fetch its audience intervals once. */
  function toggleExpand(r: InsightRow) {
    if (expanded === r.docKey) { expanded = null; return }
    expanded = r.docKey
    if (r.slugs.length === 0 || r.docKey in audSessions || audLoading[r.docKey]) return
    audLoading = { ...audLoading, [r.docKey]: true }
    void fetchRowAudienceSessions(r.slugs, fromDay, toDay)
      .then((s) => { audSessions = { ...audSessions, [r.docKey]: s } })
      .finally(() => { audLoading = { ...audLoading, [r.docKey]: false } })
  }

  function modeLabel(s: { read_ms: number; edit_ms: number }): string {
    return t(`insights.mode.${sessionMode({ start: 0, end: 0, ...s })}`)
  }

  function applyPreset(p: Preset) {
    preset = p
    const r = presetRange(p, Date.now(), localTzOffsetMinutes())
    fromDay = r.from
    toDay = r.to
    void load()
  }

  async function load() {
    if (!fromDay || !toDay) return
    loading = true
    // The lazy audience-interval cache is keyed by docKey for the CURRENT range;
    // drop it so a new range refetches.
    audSessions = {}
    audLoading = {}
    expanded = null
    try {
      await flushNow()
      rows = await assembleRows(buildDashboardDeps(), fromDay, toDay)
      resort()
    } finally {
      loading = false
    }
  }

  function resort() {
    rows = [...rows].sort((a, b) => {
      const av = a[sortKey] as number | string
      const bv = b[sortKey] as number | string
      const cmp =
        typeof av === 'number' && typeof bv === 'number'
          ? av - bv
          : String(av).localeCompare(String(bv))
      return cmp * sortDir
    })
  }

  function setSort(k: keyof InsightRow) {
    if (sortKey === k) sortDir = sortDir === 1 ? -1 : 1
    else {
      sortKey = k
      sortDir = -1
    }
    resort()
  }

  function fmtDuration(ms: number): string {
    const s = Math.round(ms / 1000)
    if (s < 60) return s + 's'
    const m = Math.floor(s / 60)
    if (m < 60) return m + 'm ' + (s % 60) + 's'
    return Math.floor(m / 60) + 'h ' + (m % 60) + 'm'
  }

  function sortArrow(k: keyof InsightRow): string {
    if (sortKey !== k) return ''
    return sortDir === -1 ? ' ↓' : ' ↑'
  }

  /** Vault-relative path for display. Every insights doc is vault-resident
   *  (rel: docKey), so show its path under the vault, not just the basename. */
  function vaultRelLabel(r: InsightRow): string {
    return r.docKey.startsWith('rel:') ? r.docKey.slice(4) : r.label
  }

  $effect(() => {
    if (!fromDay) applyPreset('7d')
  })

  /** Open the row's md in the main editor window, if the file still exists. */
  async function openDoc(r: InsightRow) {
    if (!r.path) return
    try {
      if (!(await exists(r.path))) {
        pushToast({ level: 'error', message: t('insights.docMissing'), detail: r.path })
        return
      }
      await invoke('editor_show_and_open_path', { path: r.path })
    } catch (e) {
      pushToast({ level: 'error', message: t('insights.openFailed'), detail: e instanceof Error ? e.message : String(e) })
    }
  }

  async function generateReport() {
    const root = sotvaultStore.vaultRoot
    if (!root || rows.length === 0) return
    try {
      const { filename, markdown } = renderDailyReport(rows, fromDay, toDay)
      const base = root.replace(/\/$/, '')
      await mkdir(`${base}/stat`, { recursive: true }).catch(() => {})
      const abs = `${base}/${filename}`
      await writeTextFile(abs, markdown)
      await openFile(abs)
      pushToast({ level: 'success', message: t('insights.reportSaved') })
    } catch (e) {
      pushToast({ level: 'error', message: t('insights.reportFailed'), detail: e instanceof Error ? e.message : String(e) })
    }
  }
</script>

<div class="insights-panel">
  <div class="controls">
    <div class="presets">
      <button
        class:active={preset === 'today'}
        onclick={() => applyPreset('today')}
      >{t('insights.preset.today')}</button>
      <button
        class:active={preset === 'yesterday'}
        onclick={() => applyPreset('yesterday')}
      >{t('insights.preset.yesterday')}</button>
      <button
        class:active={preset === '7d'}
        onclick={() => applyPreset('7d')}
      >{t('insights.preset.7d')}</button>
      <button
        class:active={preset === '30d'}
        onclick={() => applyPreset('30d')}
      >{t('insights.preset.30d')}</button>
      <button
        class:active={preset === 'month'}
        onclick={() => applyPreset('month')}
      >{t('insights.preset.month')}</button>
    </div>
    <div class="date-range">
      <input
        type="date"
        bind:value={fromDay}
        onchange={() => { preset = 'custom'; void load() }}
      />
      <span class="date-sep">–</span>
      <input
        type="date"
        bind:value={toDay}
        onchange={() => { preset = 'custom'; void load() }}
      />
    </div>
    <button
      class="refresh-btn"
      onclick={() => void load()}
      disabled={loading}
      title={t('insights.refresh')}
    >{loading ? '…' : '↻'} {t('insights.refresh')}</button>
    <button
      class="report-btn"
      onclick={() => void generateReport()}
      disabled={rows.length === 0}
    >{t('insights.generateReport')}</button>
  </div>

  {#if loading}
    <p class="status-msg">{t('insights.loading')}</p>
  {:else if rows.length === 0}
    <p class="status-msg empty">{t('insights.empty')}</p>
  {:else}
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th><button onclick={() => setSort('label')}>{t('insights.col.doc')}{sortArrow('label')}</button></th>
            <th><button onclick={() => setSort('read_ms')}>{t('insights.col.read')}{sortArrow('read_ms')}</button></th>
            <th><button onclick={() => setSort('edit_ms')}>{t('insights.col.edit')}{sortArrow('edit_ms')}</button></th>
            <th><button onclick={() => setSort('edit_sessions')}>{t('insights.col.sessions')}{sortArrow('edit_sessions')}</button></th>
            <th><button onclick={() => setSort('mark_ops')}>{t('insights.col.marks')}{sortArrow('mark_ops')}</button></th>
            <th><button onclick={() => setSort('aud_read_ms')}>{t('insights.col.aud')}{sortArrow('aud_read_ms')}</button></th>
            <th><button onclick={() => setSort('unique_readers')}>{t('insights.col.readers')}{sortArrow('unique_readers')}</button></th>
            <th><button onclick={() => setSort('value')}>{t('insights.col.value')}{sortArrow('value')}</button></th>
          </tr>
        </thead>
        <tbody>
          {#each rows as r (r.docKey)}
            <tr
              class="data-row"
              class:expanded={expanded === r.docKey}
              onclick={() => toggleExpand(r)}
            >
              <td class="col-doc">
                {#if r.path}
                  <button
                    class="doc-label doc-open"
                    title={t('insights.openDoc')}
                    onclick={(e) => { e.stopPropagation(); void openDoc(r) }}
                  >{vaultRelLabel(r)}</button>
                {:else}
                  <span class="doc-label">{vaultRelLabel(r)}</span>
                {/if}
                {#if r.shared}<span class="shared-badge" title="Shared">🔗</span>{/if}
              </td>
              <td>{fmtDuration(r.read_ms)}</td>
              <td>{fmtDuration(r.edit_ms)}</td>
              <td>{r.edit_sessions}</td>
              <td>{r.mark_ops}</td>
              <td>{fmtDuration(r.aud_read_ms)}</td>
              <td>{r.unique_readers}</td>
              <td class="col-value">{r.value.toFixed(1)}</td>
            </tr>
            {#if expanded === r.docKey}
              <tr class="detail-row">
                <td colspan="8">
                  <div class="detail">
                    {#if r.path}
                      <span class="detail-path">{r.path}</span>
                    {/if}
                    {#each r.urls as u}
                      <a class="detail-url" href={u} target="_blank" rel="noopener noreferrer">{u}</a>
                    {/each}

                    {#if r.owner_sessions.length > 0}
                      <div class="sessions">
                        <span class="sessions-title">{t('insights.sessions.mine')}</span>
                        <ul class="sessions-list">
                          {#each r.owner_sessions as s}
                            <li>
                              <span class="ivl">{fmtInterval(s.start, s.end)}</span>
                              <span class="ivl-mode">· {modeLabel(s)}</span>
                              <span class="ivl-dur">· {fmtDuration(s.read_ms + s.edit_ms)}</span>
                            </li>
                          {/each}
                        </ul>
                      </div>
                    {/if}

                    {#if r.slugs.length > 0}
                      <div class="sessions">
                        <span class="sessions-title">{t('insights.sessions.audience')}</span>
                        {#if audLoading[r.docKey]}
                          <span class="sessions-empty">{t('insights.sessions.loading')}</span>
                        {:else if (audSessions[r.docKey]?.length ?? 0) === 0}
                          <span class="sessions-empty">{t('insights.sessions.none')}</span>
                        {:else}
                          <ul class="sessions-list">
                            {#each audSessions[r.docKey] as s}
                              <li>
                                <span class="ivl">{fmtInterval(s.start, s.end)}</span>
                                <span class="ivl-dur">· {fmtDuration(s.ms)}</span>
                              </li>
                            {/each}
                          </ul>
                        {/if}
                      </div>
                    {/if}
                  </div>
                </td>
              </tr>
            {/if}
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>

<style>
  .insights-panel {
    display: flex;
    flex-direction: column;
    gap: 12px;
    font-size: 13px;
  }

  .controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }

  .presets {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
  }

  .presets button {
    padding: 3px 10px;
    border-radius: 4px;
    border: 1px solid color-mix(in srgb, CanvasText 20%, transparent);
    background: transparent;
    color: color-mix(in srgb, CanvasText 75%, transparent);
    font-size: 12px;
    cursor: pointer;
    transition: background 0.1s, color 0.1s;
  }

  .presets button:hover {
    background: color-mix(in srgb, CanvasText 8%, transparent);
    color: CanvasText;
  }

  .presets button.active {
    background: color-mix(in srgb, CanvasText 14%, transparent);
    color: CanvasText;
    border-color: color-mix(in srgb, CanvasText 35%, transparent);
  }

  .date-range {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .date-range input[type='date'] {
    font-size: 12px;
    padding: 2px 6px;
    border: 1px solid color-mix(in srgb, CanvasText 20%, transparent);
    border-radius: 4px;
    background: transparent;
    color: CanvasText;
  }

  .date-sep {
    color: color-mix(in srgb, CanvasText 50%, transparent);
  }

  .report-btn, .refresh-btn {
    padding: 3px 10px;
    border-radius: 4px;
    border: 1px solid color-mix(in srgb, CanvasText 20%, transparent);
    background: transparent;
    color: color-mix(in srgb, CanvasText 75%, transparent);
    font-size: 12px;
    cursor: pointer;
    transition: background 0.1s, color 0.1s;
    white-space: nowrap;
  }

  .report-btn:hover:not(:disabled), .refresh-btn:hover:not(:disabled) {
    background: color-mix(in srgb, CanvasText 8%, transparent);
    color: CanvasText;
  }

  .report-btn:disabled, .refresh-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .status-msg {
    font-size: 12px;
    color: color-mix(in srgb, CanvasText 55%, transparent);
    margin: 4px 0;
  }

  .status-msg.empty {
    font-style: italic;
  }

  .table-wrap {
    overflow-x: auto;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }

  thead tr {
    border-bottom: 1px solid color-mix(in srgb, CanvasText 15%, transparent);
  }

  th {
    padding: 0;
    text-align: left;
    font-weight: 600;
    white-space: nowrap;
  }

  th button {
    all: unset;
    display: block;
    padding: 4px 8px;
    cursor: pointer;
    color: color-mix(in srgb, CanvasText 70%, transparent);
    font-size: 11px;
    font-weight: 600;
    white-space: nowrap;
  }

  th button:hover {
    color: CanvasText;
  }

  tbody tr.data-row {
    border-bottom: 1px solid color-mix(in srgb, CanvasText 8%, transparent);
    cursor: pointer;
  }

  tbody tr.data-row:hover {
    background: color-mix(in srgb, CanvasText 5%, transparent);
  }

  tbody tr.data-row.expanded {
    background: color-mix(in srgb, CanvasText 6%, transparent);
  }

  td {
    padding: 5px 8px;
    color: color-mix(in srgb, CanvasText 85%, transparent);
    white-space: nowrap;
  }

  .col-doc {
    max-width: 200px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: CanvasText;
  }

  .doc-label {
    vertical-align: middle;
  }

  button.doc-open {
    all: unset;
    vertical-align: middle;
    cursor: pointer;
    color: CanvasText;
    max-width: 180px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  button.doc-open:hover {
    text-decoration: underline;
  }

  .shared-badge {
    margin-left: 4px;
    font-size: 10px;
    vertical-align: middle;
    opacity: 0.7;
  }

  .col-value {
    font-weight: 600;
    font-family: ui-monospace, monospace;
    color: CanvasText;
  }

  .detail-row td {
    padding: 0;
  }

  .detail {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 6px 8px 8px 16px;
    background: color-mix(in srgb, CanvasText 4%, transparent);
    border-bottom: 1px solid color-mix(in srgb, CanvasText 8%, transparent);
  }

  .detail-path {
    font-size: 11px;
    font-family: ui-monospace, monospace;
    color: color-mix(in srgb, CanvasText 60%, transparent);
    word-break: break-all;
  }

  .detail-url {
    font-size: 11px;
    color: color-mix(in srgb, CanvasText 55%, transparent);
    text-decoration: underline;
    word-break: break-all;
  }

  .detail-url:hover {
    color: CanvasText;
  }

  .sessions {
    display: flex;
    flex-direction: column;
    gap: 1px;
    margin-top: 6px;
  }

  .sessions-title {
    font-size: 11px;
    font-weight: 600;
    color: color-mix(in srgb, CanvasText 70%, transparent);
  }

  .sessions-empty {
    font-size: 11px;
    color: color-mix(in srgb, CanvasText 45%, transparent);
  }

  .sessions-list {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .sessions-list li {
    font-size: 11px;
    color: color-mix(in srgb, CanvasText 60%, transparent);
  }

  .ivl {
    font-family: ui-monospace, monospace;
    color: color-mix(in srgb, CanvasText 75%, transparent);
  }

  .ivl-mode,
  .ivl-dur {
    color: color-mix(in srgb, CanvasText 50%, transparent);
  }
</style>
