import { describe, expect, it } from 'vitest'
import type { InstalledV2 } from '../market/types'
import type { FileViewContribution, PluginManifest } from '../plugins/types'
import { appIcon, buildHomeApps } from './catalog'

const installed = (id: string, patch: Partial<InstalledV2> = {}): InstalledV2 => ({
  id, version: '1', enabled: true, name: id, capabilities: [], ...patch,
})
const manifest = (id: string, patch: Partial<PluginManifest> = {}): PluginManifest => ({
  id, name: id, version: '1', binary: '', host_capabilities: [], ...patch,
})
const view = (id: string, command?: string): FileViewContribution => ({ id, entry: 'index.html', selectors: [{ file_extensions: ['md'] }], open_command: command })

describe('installed home app catalog', () => {
  it('only resolves declared windows and file views in safe priority order', () => {
    const rows = ['explicit', 'window', 'file', 'ambiguous', 'ordinary', 'views', 'missing-command'].map((id) => installed(id))
    const apps = buildHomeApps(rows, [
      manifest('explicit', { open_windows: { other: 'secondary', open: 'main' }, file_views: [view('v', 'view')] }),
      manifest('window', { open_windows: { show: 'main' }, file_views: [view('v', 'view')] }),
      manifest('file', { file_views: [view('v', 'read')] }),
      manifest('ambiguous', { open_windows: { first: 'a', second: 'b' }, file_views: [view('v', 'view')] }),
      manifest('ordinary', { menus: [{ location: 'plugins', label: 'Save now', command: 'save-now' }] }),
      manifest('views', { file_views: [view('one', 'read-one'), view('two', 'read-two')] }),
      manifest('missing-command', { file_views: [view('one')] }),
    ], 'en')
    expect(apps.map((app) => app.entry)).toEqual([
      { kind: 'command', command: 'open' }, { kind: 'command', command: 'show' },
      { kind: 'command', command: 'read' }, { kind: 'details' }, { kind: 'details' },
      { kind: 'details' }, { kind: 'details' },
    ])
  })

  it('retains disabled and unavailable installations, localizes and uses existing categories', () => {
    const apps = buildHomeApps([
      installed('notemd.next', { name: 'NEXT', enabled: false, i18n: { zh: { name: '任务', description: '安排任务' } } }),
      installed('third.party', { description: 'Fallback', category: 'inspiration' }),
    ], [manifest('third.party', { i18n: { zh: { name: '第三方', description: '补充说明' } } }), manifest('uninstalled')], 'zh-CN')
    expect(apps).toHaveLength(2)
    expect(apps[0]).toMatchObject({ id: 'notemd.next', name: '任务（NEXT）', compactName: '任务', description: '安排任务', category: 'advance', enabled: false, available: false, entry: { kind: 'details' } })
    expect(apps[1]).toMatchObject({ description: '补充说明', category: 'create', enabled: true, available: true })
  })

  it('deduplicates installed identities and assigns stable local icon choices', () => {
    expect(buildHomeApps([installed('a'), installed('a')], [], 'en')).toHaveLength(1)
    expect(appIcon('notemd.next')).toEqual(appIcon('notemd.next'))
    expect(appIcon('notemd.next').glyph).not.toBe('app')
    expect(appIcon('notemd.meetings').glyph).toBe('meeting')
    expect(appIcon('notemd.knowledge-browser').glyph).toBe('knowledge')
    expect(appIcon('unknown')).toEqual({ glyph: 'app', tone: 'blue' })
  })
})
