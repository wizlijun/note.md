import fs from 'node:fs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import ts from 'typescript'
import { JSDOM } from 'jsdom'

const source = fs.readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8').replace("import './style.css'", '')
const script = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText.replace('export {};', '')
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const catalog = { categories: [{ slug: 'sleep', record_count: 12, first_day: '2020-01-01', last_day: '2026-10-24', metrics: [{ metric: 'oura.sleep', source: 'oura', record_count: 12, first_day: '2020-01-01', last_day: '2026-10-24' }] }], sources: { oura: { record_count: 12, collections: { sleep: { complete_days: 6, unavailable_days: 2, failed_days: 1, first_coverage_day: '2020-01-01', last_coverage_day: '2026-10-24', undated: null } } } } }
const status = { imported: true, manifest: { record_count: 24, day_count: 6, first_day: '2020-01-01', last_day: '2026-10-24', attachment_count: 3 }, source_file: '/tmp/export.zip', connections: { garmin: { connected: false, pending: false }, oura: { connected: false, pending: false } } }
async function mount(t, handler, locale = 'zh') {
  const dom = new JSDOM('<main id="app"></main>', { url: 'https://health.test', runScripts: 'outside-only' })
  t.after(() => dom.window.close())
  const calls = []
  dom.window.notemd = { locale, request: async (method, params) => {
    calls.push({ method, params: params ? JSON.parse(JSON.stringify(params)) : params })
    const result = handler?.(method, params)
    if (result !== undefined) return result
    if (method === 'host.vault.info') return { root: '/tmp/test-vault' }
    if (method === 'plugin.status') return status
    if (method === 'plugin.catalog') return catalog
    throw new Error(`Unexpected request: ${method}`)
  } }
  dom.window.eval(script)
  await tick()
  return { window: dom.window, calls, el: id => dom.window.document.getElementById(id) }
}

test('loads archive counts, categories, slugs, coverage and Apple history start', async t => {
  const { el, calls } = await mount(t)
  assert.equal(el('vault').value, '/tmp/test-vault')
  assert.deepEqual(calls.map(c => c.method), ['host.vault.info', 'plugin.status', 'plugin.catalog'])
  assert.match(el('overview').textContent, /24 条记录 · 6 天 · 3 个附件/)
  assert.match(el('catalog').textContent, /睡眠.*12/)
  assert.match(el('catalog').textContent, /oura.sleep/)
  assert.match(el('coverage').textContent, /已完成天数/); assert.match(el('coverage').textContent, /Oura/)
  assert.equal(el('sync-since').value, '2020-01-01')
  assert.equal(el('file').value, '/tmp/export.zip')
})

test('file chooser accepts ZIP/XML and cancellation keeps the selected path', async t => {
  let paths = ['/tmp/new.xml']
  const { el, calls } = await mount(t, method => method === 'host.dialog.open' ? { paths } : undefined)
  el('choose').click(); await tick()
  assert.equal(el('file').value, '/tmp/new.xml')
  assert.deepEqual(calls.at(-1).params.filters[0].extensions, ['zip', 'xml'])
  paths = null; el('choose').click(); await tick()
  assert.equal(el('file').value, '/tmp/new.xml')
})

test('preview imports an explicit file without claiming archive mutation', async t => {
  const { el, calls } = await mount(t, method => method === 'plugin.import' ? { complete: true, dry_run: true } : undefined)
  el('dry-run').checked = true; el('file').value = '/tmp/export.xml'; el('import').click(); await tick()
  const call = calls.find(c => c.method === 'plugin.import')
  assert.equal(call.params.file, '/tmp/export.xml'); assert.equal(call.params.dry_run, true)
  assert.match(el('message').textContent, /预览完成/)
})

test('incomplete import reports retain details and are not shown as success', async t => {
  const { el } = await mount(t, method => method === 'plugin.import' ? { complete: false, summary_conflicts: ['health/daily/2026-10-01.md'] } : undefined)
  el('import').click(); await tick()
  assert.equal(el('message').className, 'error'); assert.match(el('report').textContent, /summary_conflicts/)
})

test('busy imports prevent duplicate actions and reenable controls afterwards', async t => {
  let finish; const pending = new Promise(resolve => { finish = resolve })
  const { el, calls } = await mount(t, method => method === 'plugin.import' ? pending : undefined)
  el('import').click(); assert.equal(el('sync').disabled, true); el('sync').click()
  assert.equal(calls.filter(c => c.method === 'plugin.sync').length, 0)
  finish({ complete: true }); await tick(); assert.equal(el('sync').disabled, false)
})

test('category/metric navigation queries the correct source and follows next_offset', async t => {
  let page = 0
  const { el, calls, window } = await mount(t, method => method === 'plugin.query' ? { records: [{ raw: '<img src=x>' }], has_more: ++page === 1, next_offset: page === 1 ? 100 : null } : undefined)
  window.document.querySelector('.metric-row').click(); await tick()
  let call = calls.at(-1)
  assert.equal(call.params.category, 'sleep'); assert.equal(call.params.metric, 'oura.sleep'); assert.equal(call.params.source, 'oura'); assert.equal(call.params.limit, 100)
  assert.equal(window.document.activeElement, el('query-title'))
  assert.equal(window.document.querySelector('img'), null)
  el('next-page').click(); await tick(); call = calls.at(-1)
  assert.equal(call.params.offset, 100); assert.equal(call.params.source, 'oura'); assert.equal(el('next-page').disabled, true)
})

test('query forwards dates and explicit category/source filters', async t => {
  const { el, calls, window } = await mount(t, method => method === 'plugin.query' ? { records: [], has_more: false } : undefined)
  el('since').value = '2026-10-01'; el('until').value = '2026-10-24'; el('category').value = 'sleep'; el('query-source').value = 'apple-health'
  el('query-form').dispatchEvent(new window.Event('submit', { cancelable: true })); await tick()
  assert.equal(calls.at(-1).params.since, '2026-10-01'); assert.equal(calls.at(-1).params.until, '2026-10-24'); assert.equal(calls.at(-1).params.source, 'apple-health')
})

test('collection continues pending windows including unavailable warnings', async t => {
  let batch = 0
  const { el, calls } = await mount(t, method => method === 'plugin.sync' ? (++batch === 1 ? { complete: false, pending: true, warnings: ['one unavailable collection'], sources: [{ source: 'oura', pending: true, next_day: '2020-02-01' }], errors: [] } : { complete: false, pending: false, sources: [], errors: [] }) : undefined)
  el('sync').click(); await tick(); await tick()
  const sync = calls.filter(c => c.method === 'plugin.sync')
  assert.equal(sync.length, 2); assert.equal(sync[0].params.max_days, 31); assert.equal(sync[0].params.source, 'all')
  assert.match(el('message').textContent, /不可用或未完成项/); assert.doesNotMatch(el('message').textContent, /范围采集完成/)
})

test('stop finishes the active batch and leaves subsequent batches for resume', async t => {
  let finish; const pending = new Promise(resolve => { finish = resolve })
  const { el, calls } = await mount(t, method => method === 'plugin.sync' ? pending : undefined)
  el('sync').click(); assert.equal(el('stop').disabled, false); el('stop').click()
  finish({ complete: true, pending: true, sources: [{ source: 'oura', pending: true, next_day: '2020-02-01' }], errors: [] }); await tick()
  assert.equal(calls.filter(c => c.method === 'plugin.sync').length, 1); assert.match(el('message').textContent, /续传/)
})

test('retry_required, fatal errors and unchanged cursors never loop indefinitely', async t => {
  for (const response of [{ pending: true, retry_required: true }, { pending: true, fatal_errors: ['failed'] }, { pending: true, sources: [{ source: 'oura', pending: true, next_day: '2020-01-01' }], errors: [] }]) {
    const { el, calls } = await mount(t, method => method === 'plugin.sync' ? response : undefined)
    el('sync').click(); await tick(); await tick()
    assert.ok(calls.filter(c => c.method === 'plugin.sync').length <= 2); assert.equal(el('message').className, 'error')
  }
})

test('automatic continuation visits only pending providers and restarts only the first batch', async t => {
  let batch = 0
  const responses = [
    { pending: true, complete: false, sources: [{ source: 'garmin', pending: true, next_day: '2020-02-01' }, { source: 'oura', pending: true, next_day: '2020-02-01' }] },
    { pending: true, complete: false, sources: [{ source: 'garmin', pending: true, next_day: '2020-03-01' }] },
    { pending: false, complete: true, sources: [{ source: 'oura', pending: false }] },
    { pending: false, complete: true, sources: [{ source: 'garmin', pending: false }] },
  ]
  const { el, calls } = await mount(t, method => method === 'plugin.sync' ? responses[batch++] : undefined)
  el('restart').checked = true; el('sync').click(); await tick(); await tick()
  const requests = calls.filter(c => c.method === 'plugin.sync')
  assert.deepEqual(requests.map(c => c.params.source), ['all', 'garmin', 'oura', 'garmin'])
  assert.deepEqual(requests.map(c => c.params.restart), [true, false, false, false])
  assert.deepEqual(requests.map(c => c.params.file), ['/tmp/export.zip', undefined, undefined, undefined])
  assert.match(el('message').textContent, /所选日期范围采集完成/)
})

test('Garmin credentials clear immediately and never enter reports', async t => {
  let finish; const pending = new Promise(resolve => { finish = resolve })
  const { el, calls } = await mount(t, method => method === 'plugin.connect' ? pending : undefined)
  el('garmin-key').value = 'synthetic-secret'; el('garmin-connect').click()
  assert.equal(el('garmin-key').value, ''); assert.equal(calls.at(-1).params.api_key, 'synthetic-secret'); assert.equal(calls.at(-1).params.region, 'global')
  finish({ connected: true, pending: false }); await tick()
  assert.doesNotMatch(el('report').textContent, /synthetic-secret/); assert.doesNotMatch(el('message').textContent, /synthetic-secret/)
})

test('Garmin region is explicit, restored from status, and reset for a new Vault', async t => {
  let connected = false
  const { el, calls, window } = await mount(t, method => {
    if (method === 'plugin.connect') { connected = true; return { connected: true } }
    if (method === 'plugin.status' && connected) return { ...status, connections: { garmin: { connected: true, region: 'china' } } }
  })
  assert.equal(el('garmin-region').value, 'global')
  el('garmin-region').value = 'china'; el('garmin-key').value = 'synthetic-secret'; el('garmin-connect').click(); await tick()
  assert.equal(calls.find(call => call.method === 'plugin.connect').params.region, 'china')
  assert.equal(el('garmin-region').value, 'china')
  el('garmin-region').value = 'global'; el('status').click(); await tick()
  assert.equal(el('garmin-region').value, 'china')
  el('vault').value = '/tmp/new-vault'; el('vault').dispatchEvent(new window.Event('input'))
  assert.equal(el('garmin-region').value, 'global')
})

test('Oura authorization keeps the page alive and polls connections without storing secrets', async t => {
  let finish; const pending = new Promise(resolve => { finish = resolve })
  const { el, calls } = await mount(t, method => method === 'plugin.connect' ? { pending: true, authorize_url: 'https://cloud.ouraring.com/oauth/authorize?state=synthetic' } : method === 'plugin.connections' ? pending : undefined)
  el('oura-id').value = 'client'; el('oura-secret').value = 'synthetic-secret'; el('oura-connect').click(); await tick()
  assert.equal(el('oura-secret').value, ''); assert.equal(el('authorization').hidden, false)
  assert.equal(calls.find(c => c.method === 'plugin.connect').params.redirect_uri, 'http://127.0.0.1:8765/callback')
  finish({ oura: { pending: false, connected: true } }); await tick()
  assert.equal(el('authorization').hidden, true); assert.match(el('message').textContent, /连接成功/)
  assert.doesNotMatch(el('report').textContent, /synthetic-secret/)
})

test('connection failures are sanitized while ordinary errors remain plain text', async t => {
  const { el, window } = await mount(t, method => { if (method === 'plugin.connect') throw new Error('echo synthetic-secret'); if (method === 'plugin.sync') throw new Error('<img src=x>') }, 'en')
  el('garmin-key').value = 'synthetic-secret'; el('garmin-connect').click(); await tick()
  assert.doesNotMatch(el('message').textContent, /synthetic-secret/)
  el('sync').click(); await tick(); assert.match(el('message').textContent, /Failed:.*<img/); assert.equal(window.document.querySelector('img'), null)
})

test('disconnect removes credentials without sending an archive deletion request', async t => {
  const { el, calls } = await mount(t, method => method === 'plugin.disconnect' ? { connected: false } : undefined)
  el('oura-disconnect').click(); await tick()
  const call = calls.find(c => c.method === 'plugin.disconnect'); assert.deepEqual(call.params, { vault: '/tmp/test-vault', source: 'oura' }); assert.match(el('message').textContent, /归档数据保留/)
})

test('changing Vault clears previous archive, file, credentials and results before loading the new Vault', async t => {
  const { el, calls, window } = await mount(t, (method, params) => {
    if (method === 'plugin.query') return { records: [{ old_vault: true }], has_more: true, next_offset: 100 }
    if (params?.vault === '/tmp/another-vault' && method === 'plugin.status') return { connections: {} }
    if (params?.vault === '/tmp/another-vault' && method === 'plugin.catalog') return { categories: [] }
  })
  window.document.querySelector('.metric-row').click(); await tick()
  el('garmin-key').value = 'not-submitted'; el('oura-secret').value = 'not-submitted'
  el('vault').value = '/tmp/another-vault'; el('vault').dispatchEvent(new window.Event('input'))
  assert.equal(el('file').value, ''); assert.equal(el('garmin-key').value, ''); assert.equal(el('oura-secret').value, '')
  assert.equal(el('records').hidden, true); assert.equal(el('next-page').disabled, true)
  assert.equal(el('query-source').value, 'all'); assert.doesNotMatch(el('catalog').textContent, /oura.sleep/)
  el('vault').dispatchEvent(new window.Event('change')); await tick()
  assert.equal(calls.at(-1).params.vault, '/tmp/another-vault')
  assert.match(el('overview').textContent, /尚未建立/); assert.equal(el('sync-since').value, '2010-01-01')
})

test('automatic history start follows a first import while a user-selected date remains unchanged', async t => {
  let imported = false
  const { el, window } = await mount(t, method => {
    if (method === 'plugin.status') return imported ? status : { connections: {} }
    if (method === 'plugin.import') { imported = true; return { complete: true } }
  })
  assert.equal(el('sync-since').value, '2010-01-01')
  el('file').value = '/tmp/export.xml'; el('import').click(); await tick()
  assert.equal(el('sync-since').value, '2020-01-01')
  el('sync-since').value = '2023-05-06'; el('sync-since').dispatchEvent(new window.Event('input'))
  el('status').click(); await tick(); assert.equal(el('sync-since').value, '2023-05-06')
})

test('changed filters and archive refresh invalidate displayed records and pagination', async t => {
  const { el, window } = await mount(t, method => method === 'plugin.query' ? { records: [{ previous: true }], has_more: true, next_offset: 100 } : undefined)
  window.document.querySelector('.metric-row').click(); await tick()
  el('since').value = '2026-10-01'; el('since').dispatchEvent(new window.Event('input'))
  assert.equal(el('records').hidden, true); assert.equal(el('query-count').textContent, ''); assert.equal(el('next-page').disabled, true)
  window.document.querySelector('.metric-row').click(); await tick()
  el('status').click(); await tick()
  assert.equal(el('records').textContent, ''); assert.equal(el('next-page').disabled, true)
})

test('category navigation validates date order and page size before querying', async t => {
  const { el, calls, window } = await mount(t)
  el('since').value = '2026-10-24'; el('until').value = '2026-10-01'
  window.document.querySelector('.category-heading').click(); await tick()
  assert.match(el('message').textContent, /起始日期不能晚于结束日期/)
  el('until').value = ''; el('limit').value = '1.5'
  window.document.querySelector('.category-heading').click(); await tick()
  assert.match(el('message').textContent, /1–1000 的整数/)
  assert.equal(calls.filter(call => call.method === 'plugin.query').length, 0)
})

test('failed Oura authorization clears the expired URL and waiting status', async t => {
  const { el } = await mount(t, method => method === 'plugin.connect' ? { pending: true, authorize_url: 'https://cloud.ouraring.com/oauth/authorize?state=expired' } : method === 'plugin.connections' ? { oura: { pending: false, error: 'synthetic-secret' } } : undefined)
  el('oura-connect').click(); await tick()
  assert.equal(el('authorization').hidden, true); assert.equal(el('authorize-url').value, '')
  assert.match(el('oura-state').textContent, /连接未完成/)
  assert.doesNotMatch(el('message').textContent, /synthetic-secret/)
})

test('successful operation details stay collapsed, incomplete details open, and new actions clear stale reports', async t => {
  let complete = true
  const { el } = await mount(t, method => method === 'plugin.import' ? { complete, marker: 'this-import' } : undefined)
  el('import').click(); await tick()
  assert.equal(el('report-details').hidden, false); assert.equal(el('report-details').open, false)
  complete = false; el('import').click(); await tick(); assert.equal(el('report-details').open, true)
  el('status').click(); await tick()
  assert.equal(el('report-details').hidden, true); assert.equal(el('report').textContent, '')
})

test('coverage table uses real source_summary fields and distinguishes processing from all-day readings', async t => {
  const { el } = await mount(t)
  const cells = [...el('coverage').querySelectorAll('tbody td')].map(cell => cell.textContent)
  assert.deepEqual(cells, ['Oura', 'sleep', '2020-01-01 → 2026-10-24', '6', '2', '1'])
  assert.equal(el('coverage').querySelectorAll('th[scope="col"]').length, 6)
  assert.match(el('coverage-help').textContent, /不代表设备全天佩戴/)
  assert.match(el('coverage-help').textContent, /无数据返回也可能记为已完成/)
})

test('coverage has an empty state and preserves undated collection status without injecting markup', async t => {
  let sources = {}
  const { el, window } = await mount(t, method => method === 'plugin.catalog' ? { categories: [], sources } : undefined)
  assert.match(el('coverage').textContent, /尚无来源覆盖记录/)
  assert.equal(el('coverage').querySelector('table'), null)
  sources = { oura: { collections: { '<img src=x>': { complete_days: 0, unavailable_days: 0, failed_days: 0, first_coverage_day: null, last_coverage_day: null, undated: { status: 'complete', record_count: 1 } } } } }
  el('status').click(); await tick()
  assert.match(el('coverage').textContent, /无日期记录: 已完成/)
  assert.match(el('coverage').textContent, /<img src=x>/)
  assert.equal(window.document.querySelector('img'), null)
})

test('Apple-only sync ignores date ranges and restart and describes rereading the complete snapshot', async t => {
  const { el, calls, window } = await mount(t, method => method === 'plugin.sync' ? { complete: true, record_count: 24 } : undefined)
  el('sync-source').value = 'apple-health'; el('sync-source').dispatchEvent(new window.Event('change'))
  assert.equal(el('sync-since').disabled, true); assert.equal(el('sync-until').required, false)
  assert.equal(el('restart').closest('label').hidden, true)
  assert.match(el('sync').textContent, /导入 Apple 快照/)
  el('sync-since').value = ''; el('sync-until').value = ''; el('restart').checked = true
  el('sync').click(); await tick()
  const call = calls.find(call => call.method === 'plugin.sync')
  assert.equal(call.params.source, 'apple-health'); assert.equal(call.params.since, undefined); assert.equal(call.params.until, undefined); assert.equal(call.params.restart, false)
  assert.match(el('message').textContent, /Apple 完整快照已导入/)
  assert.doesNotMatch(el('message').textContent, /所选日期范围采集完成/)
  assert.equal(el('sync-since').disabled, true)
  el('sync-source').value = 'oura'; el('sync-source').dispatchEvent(new window.Event('change'))
  assert.equal(el('sync-since').disabled, false); assert.equal(el('sync-until').required, true)
  assert.equal(el('restart').closest('label').hidden, false)
})

test('incomplete Apple-only sync and preview never claim complete collection', async t => {
  const { el, window } = await mount(t, method => method === 'plugin.sync' ? { complete: false } : undefined)
  el('sync-source').value = 'apple-health'; el('sync-source').dispatchEvent(new window.Event('change'))
  el('sync').click(); await tick()
  assert.match(el('message').textContent, /Apple 快照仍有未完成项/); assert.equal(el('report-details').open, true)
  el('dry-run').checked = true; el('sync').click(); await tick()
  assert.match(el('message').textContent, /预览有未完成项/)
  assert.doesNotMatch(el('message').textContent, /快照已导入/)
})

test('manifest exposes catalog, source/date sync filters and credential-free host CLI', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../manifest.v2.json', import.meta.url)))
  assert.equal(manifest.idle_shutdown_seconds, 600)
  assert.equal(manifest.version, '0.1.1')
  const cli = manifest.contributes.cli
  assert.ok(cli.some(c => c.subcommand === 'health-catalog')); assert.ok(cli.some(c => c.subcommand === 'health-disconnect'))
  assert.ok(!cli.some(c => c.command === 'connect'))
  assert.ok(cli.find(c => c.command === 'sync').flags.some(f => f.long === '--max-days' && f.type === 'string'))
  assert.ok(cli.find(c => c.command === 'sync').flags.some(f => f.long === '--file' && f.type === 'string'))
  assert.ok(cli.find(c => c.command === 'query').flags.some(f => f.long === '--category'))
})

test('first-run primary preview consumes the selected file for Apple and all sources', async t => {
  for (const source of ['apple-health', 'all']) {
    const { el, calls, window } = await mount(t, (method, params) => {
      if (method === 'plugin.status') return { imported: false, connections: {} }
      if (method === 'plugin.catalog') return { categories: [], sources: {} }
      if (method === 'host.dialog.open') return { paths: ['/tmp/健康导出.zip'] }
      if (method === 'plugin.sync') {
        if (!params.file) throw new Error('No remembered export; run health-import first')
        return { complete: true, dry_run: true }
      }
    })
    el('choose').click(); await tick()
    el('sync-source').value = source; el('sync-source').dispatchEvent(new window.Event('change'))
    el('dry-run').checked = true; el('dry-run').dispatchEvent(new window.Event('change'))
    assert.match(el('sync').textContent, /预览/); assert.equal(el('import').textContent, '预览所选文件')
    el('sync').click(); await tick()
    assert.match(el('message').textContent, /预览完成/)
    const call = calls.find(c => c.method === 'plugin.sync')
    assert.equal(call.params.file, '/tmp/健康导出.zip'); assert.equal(call.params.dry_run, true)
    assert.equal(calls.filter(c => c.method === 'plugin.status').length, 1)
  }
})
