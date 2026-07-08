<script lang="ts">
  import { exists, mkdir, readDir, readTextFile, writeTextFile } from '@tauri-apps/plugin-fs'
  import { createAnalyticsStore, type Fs } from '../lib/insights/store.svelte'
  import { assembleRows, type AssembleDeps, type InsightRow } from '../lib/insights/dashboard.svelte'
  import { DEFAULT_WEIGHTS, presetRange, type Preset } from '../lib/insights/value'
  import { fetchAudienceStats } from '../lib/insights/audience'
  import { localTzOffsetMinutes } from '../lib/insights/model'
  import { flushNow } from '../lib/insights/tracker.svelte'
  import { getDeviceId, getPluginScopedKey } from '../lib/settings.svelte'
  import { sotvaultStore } from '../lib/sotvault.svelte'
  import { getRecord } from '../lib/share/records'
  import { basename } from '../lib/fs'
  import { t } from '../lib/i18n/store.svelte'
  import { renderDailyReport } from '../lib/insights/report'
  import { openFile } from '../lib/tabs.svelte'
  import { pushToast } from '../lib/toast.svelte'

  const fs: Fs = {
    exists: (p) => exists(p),
    mkdir: (p, o) => mkdir(p, o).then(() => {}),
    readDir: async (p) => (await readDir(p)).map((e) => ({ name: e.name, isFile: e.isFile })),
    readTextFile: (p) => readTextFile(p),
    writeTextFile: (p, c) => writeTextFile(p, c),
  }

  function trimSlash(s: string): string {
    return s.replace(/\/+$/, '')
  }

  function buildDeps(): AssembleDeps {
    const vaultRoot = sotvaultStore.vaultRoot
    const baseUrl = (getPluginScopedKey('share.baseUrl') as string | undefined) ?? ''
    return {
      readDevices: () =>
        createAnalyticsStore({
          fs,
          vaultRoot: () => sotvaultStore.vaultRoot,
          deviceId: getDeviceId(),
          deviceName: '',
          tzOffsetMinutes: localTzOffsetMinutes(),
        }).readAllDevices(),
      resolveShare: (docKey) => {
        const path = docKey.startsWith('rel:')
          ? vaultRoot
            ? trimSlash(vaultRoot) + '/' + docKey.slice(4)
            : null
          : docKey.slice(4) // 'abs:'
        const rec = path ? getRecord(path) : undefined
        return {
          path,
          label: path ? basename(path) : docKey,
          slug: (rec && 'slug' in rec ? rec.slug : null) ?? null,
          editToken: (rec && 'edit_token' in rec ? rec.edit_token : null) ?? null,
        }
      },
      fetchAudience: (slug, editToken, from, to, base) =>
        fetchAudienceStats(base, editToken, slug, from, to),
      baseUrl,
      weights: DEFAULT_WEIGHTS,
    }
  }

  let preset = $state<Preset | 'custom'>('7d')
  let fromDay = $state('')
  let toDay = $state('')
  let rows = $state<InsightRow[]>([])
  let loading = $state(false)
  let sortKey = $state<keyof InsightRow>('value')
  let sortDir = $state<1 | -1>(-1)
  let expanded = $state<string | null>(null)

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
    try {
      await flushNow()
      rows = await assembleRows(buildDeps(), fromDay, toDay)
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

  $effect(() => {
    if (!fromDay) applyPreset('7d')
  })

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
              onclick={() => { expanded = expanded === r.docKey ? null : r.docKey }}
            >
              <td class="col-doc">
                <span class="doc-label">{r.label}</span>
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
                    {#if r.path}
                      {@const rec = getRecord(r.path)}
                      {#if rec && 'url' in rec && rec.url}
                        <a class="detail-url" href={rec.url} target="_blank" rel="noopener noreferrer">{rec.url}</a>
                      {/if}
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

  .report-btn {
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

  .report-btn:hover:not(:disabled) {
    background: color-mix(in srgb, CanvasText 8%, transparent);
    color: CanvasText;
  }

  .report-btn:disabled {
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
</style>
