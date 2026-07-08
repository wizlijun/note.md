import { exists, mkdir, readDir, readTextFile, writeTextFile } from '@tauri-apps/plugin-fs'
import { createAnalyticsStore, type Fs } from './store.svelte'
import { assembleRows, type AssembleDeps } from './dashboard.svelte'
import { DEFAULT_WEIGHTS } from './value'
import { fetchAudienceStatsBatch } from './audience'
import { localTzOffsetMinutes, docKeyFor } from './model'
import { renderDailyReport } from './report'
import { getDeviceId, getPluginScopedKey } from '../settings.svelte'
import { sotvaultStore } from '../sotvault.svelte'
import { getRecord, allShareRecordPaths } from '../share/records'
import { basename } from '../fs'

const fs: Fs = {
  exists: (p) => exists(p),
  mkdir: (p, o) => mkdir(p, o).then(() => {}),
  readDir: async (p) => (await readDir(p)).map((e) => ({ name: e.name, isFile: e.isFile })),
  readTextFile: (p) => readTextFile(p),
  writeTextFile: (p, c) => writeTextFile(p, c),
}

const trimSlash = (s: string) => s.replace(/\/+$/, '')

/**
 * Build the dashboard/report data dependencies (owner analytics from the Vault +
 * audience stats from the Worker, joined via share records). Shared by the
 * in-app Insights window and the `mdedit reading-insights report` CLI so the CLI
 * gets the SAME online (audience) data — the API key + share records come from
 * the loaded settings, and audience is fetched in one `/a/stats-batch` request.
 */
export function buildDashboardDeps(vaultOverride?: string | null): AssembleDeps {
  const vaultRoot = vaultOverride ?? sotvaultStore.vaultRoot
  const baseUrl = (getPluginScopedKey('share.baseUrl') as string | undefined) ?? ''
  const apiKey = (getPluginScopedKey('share.apiKey') as string | undefined) ?? ''
  return {
    readDevices: () =>
      createAnalyticsStore({
        fs,
        vaultRoot: () => vaultRoot,
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
      }
    },
    fetchAudienceBatch: (slugs, from, to) => fetchAudienceStatsBatch(baseUrl, apiKey, slugs, from, to),
    listSharedDocKeys: () => allShareRecordPaths().map((p) => docKeyFor(p, vaultRoot)),
    weights: DEFAULT_WEIGHTS,
  }
}

/** Assemble rows + render the daily report markdown (owner + audience + value). */
export async function generateInsightsReport(
  fromDay: string,
  toDay: string,
  vaultOverride?: string | null,
): Promise<{ filename: string; markdown: string }> {
  const rows = await assembleRows(buildDashboardDeps(vaultOverride), fromDay, toDay)
  return renderDailyReport(rows, fromDay, toDay)
}
