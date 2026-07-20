import { exists, mkdir, readDir, readTextFile, writeTextFile } from '@tauri-apps/plugin-fs'
import { createAnalyticsStore, type Fs } from './store.svelte'
import { assembleRows, type AssembleDeps, type InsightRow } from './dashboard.svelte'
import { DEFAULT_WEIGHTS } from './value'
import { fetchAudienceStatsAll, fetchAudienceSessions, type AudienceSession } from './audience'
import { localTzOffsetMinutes } from './model'
import { renderDailyReport } from './report'
import { getDeviceId, getPluginScopedKey } from '../settings.svelte'
import { sotvaultStore } from '../sotvault.svelte'
import { getRecord } from '../share/records'
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
 * in-app Insights window and the `notemd reading-insights report` CLI so the CLI
 * gets the SAME online (audience) data — the API key comes from the loaded
 * settings, and ALL audience data is fetched by date in one `/a/stats-all`
 * request (no slug list needed; share records only map slugs back to paths).
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
        url: (rec && 'url' in rec ? rec.url : null) ?? null,
      }
    },
    fetchAudienceAll: (from, to) => fetchAudienceStatsAll(baseUrl, apiKey, from, to),
    resolveSrc: (src) => {
      // Absolute path (file outside the vault) → device-local abs: key, as-is.
      if (src.startsWith('/')) return { docKey: `abs:${src}`, path: src, label: basename(src) }
      // Otherwise vault-relative → rel: key + absolute path under the vault root.
      const path = vaultRoot ? trimSlash(vaultRoot) + '/' + src : null
      return { docKey: `rel:${src}`, path, label: basename(src) }
    },
    // Audience-only shares carry no local record; the public URL is baseUrl/slug.
    resolveSlugUrl: (slug) => (baseUrl ? `${trimSlash(baseUrl)}/${slug}` : null),
    weights: DEFAULT_WEIGHTS,
  }
}

/**
 * Lazily fetch and merge the audience reading intervals for a row's share slugs
 * (called when a dashboard row is expanded). Uses the loaded share API key.
 * Fail-soft: slugs that error contribute nothing. Result is sorted by start.
 */
export async function fetchRowAudienceSessions(
  slugs: string[],
  fromDay: string,
  toDay: string,
): Promise<AudienceSession[]> {
  const baseUrl = (getPluginScopedKey('share.baseUrl') as string | undefined) ?? ''
  const apiKey = (getPluginScopedKey('share.apiKey') as string | undefined) ?? ''
  if (!baseUrl || !apiKey || slugs.length === 0) return []
  const lists = await Promise.all(slugs.map((slug) => fetchAudienceSessions(baseUrl, apiKey, slug, fromDay, toDay)))
  return lists.flat().sort((a, b) => a.start - b.start)
}

/**
 * Fetch every shared row's audience reading intervals for the report, keyed by
 * docKey (a row may map several slugs → merged). Fail-soft per row. Rows with no
 * slugs are skipped. Used by both the in-app and CLI report generators.
 */
export async function buildReportAudienceSessions(
  rows: InsightRow[],
  fromDay: string,
  toDay: string,
): Promise<Record<string, AudienceSession[]>> {
  const shared = rows.filter((r) => r.slugs.length > 0)
  const entries = await Promise.all(
    shared.map(async (r) => [r.docKey, await fetchRowAudienceSessions(r.slugs, fromDay, toDay)] as const),
  )
  return Object.fromEntries(entries.filter(([, s]) => s.length > 0))
}

/** Assemble rows + render the daily report markdown (owner + audience + value +
 *  read/edit & audience time intervals). */
export async function generateInsightsReport(
  fromDay: string,
  toDay: string,
  vaultOverride?: string | null,
): Promise<{ filename: string; markdown: string }> {
  const rows = await assembleRows(buildDashboardDeps(vaultOverride), fromDay, toDay)
  const audSessions = await buildReportAudienceSessions(rows, fromDay, toDay)
  return renderDailyReport(rows, fromDay, toDay, audSessions)
}
