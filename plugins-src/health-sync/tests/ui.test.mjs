import fs from 'node:fs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import ts from 'typescript'
import { JSDOM } from 'jsdom'

const source = fs.readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8').replace("import './style.css'", '')
const script = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText.replace('export {};', '')
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const catalog = { categories: [{ slug: 'sleep', record_count: 12, first_day: '2020-01-01', last_day: '2026-10-24', metrics: [{ metric: 'oura.sleep', source: 'oura', record_count: 12, first_day: '2020-01-01', last_day: '2026-10-24' }] }], sources: { oura: { record_count: 12, collections: { sleep: { complete_days: 6, unavailable_days: 2, failed_days: 1, first_coverage_day: '2020-01-01', last_coverage_day: '2026-10-24', undated: null } } } } }
const status = { imported: true, summary: { record_count: 24, day_count: 6, first_day: '2020-01-01', last_day: '2026-10-24', attachment_count: 3 }, source_file: '/tmp/export.zip', connections: { garmin: { connected: true, pending: false, active_account_id: 'g-one', accounts: [{ id: 'g-one', label: 'Garmin One', region: 'global', connected: true, active: true }, { id: 'g-two', label: 'Garmin Two', region: 'china', connected: true }] }, oura: { connected: true, pending: false, active_account_id: 'o-one', accounts: [{ id: 'o-one', label: 'Oura One', connected: true, active: true }, { id: 'o-two', label: 'Oura Two', connected: true }] } } }
async function mount(t, handler, locale = 'zh') {
  const dom = new JSDOM('<main id="app"></main>', { url: 'https://health.test', runScripts: 'outside-only' })
  t.after(() => dom.window.close())
  const calls = []
  dom.window.notemd = { locale, request: async (method, params) => {
    calls.push({ method, params: params ? JSON.parse(JSON.stringify(params)) : params })
    const result = handler?.(method, params)
    if (result !== undefined) return result
    if (method === 'host.vault.info') return { root: '/tmp/test-vault' }
    if (method === 'plugin.storage_status') return { configured: true, available: true, path: '/tmp/health-library' }
    if (method === 'plugin.configure_storage') return { configured: true, path: params.path }
    if (method === 'plugin.status') return status
    if (method === 'plugin.connections') return status.connections
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
  assert.deepEqual(calls.map(c => c.method), ['host.vault.info', 'plugin.storage_status', 'plugin.status', 'plugin.catalog'])
  assert.match(el('overview').textContent, /24 条记录 · 6 天 · 3 个附件/)
  assert.match(el('catalog').textContent, /睡眠.*12/)
  assert.match(el('catalog').textContent, /oura.sleep/)
  assert.match(el('coverage').textContent, /已完成天数/); assert.match(el('coverage').textContent, /Oura/)
  assert.equal(el('garmin-history-since').value, '2020-01-01')
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
  el('apple-dry-run').checked = true; el('file').value = '/tmp/export.xml'; el('import').click(); await tick()
  const call = calls.find(c => c.method === 'plugin.import')
  assert.equal(call.params.file, '/tmp/export.xml'); assert.equal(call.params.dry_run, true)
  assert.match(el('message').textContent, /预览完成/)
})

test('incomplete import reports retain details and are not shown as success', async t => {
  const { el } = await mount(t, method => method === 'plugin.import' ? { complete: false, errors: ['One source record could not be processed'] } : undefined)
  el('import').click(); await tick()
  assert.equal(el('message').className, 'error'); assert.match(el('report').textContent, /errors/)
})

test('busy imports prevent duplicate actions and reenable controls afterwards', async t => {
  let finish; const pending = new Promise(resolve => { finish = resolve })
  const { el, calls } = await mount(t, method => method === 'plugin.import' ? pending : undefined)
  el('import').click(); assert.equal(el('garmin-sync').disabled, true); el('garmin-sync').click()
  assert.equal(calls.filter(c => c.method === 'plugin.sync').length, 0)
  finish({ complete: true }); await tick(); assert.equal(el('garmin-sync').disabled, false)
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

test('history continues pending windows including unavailable warnings with one fixed account', async t => {
  let batch = 0
  const { el, calls } = await mount(t, method => method === 'plugin.sync' ? (++batch === 1 ? { complete: false, pending: true, warnings: ['one unavailable collection'], sources: [{ source: 'garmin', account_id: 'g-two', pending: true, next_day: '2020-02-01' }], errors: [] } : { complete: false, pending: false, sources: [], errors: [] }) : undefined)
  el('garmin-history-account').value = 'g-two'; el('garmin-restart').checked = true; el('garmin-history-import').click(); await tick(); await tick()
  const sync = calls.filter(c => c.method === 'plugin.sync')
  assert.equal(sync.length, 2); assert.equal(sync[0].params.max_days, 31)
  assert.deepEqual(sync.map(c => c.params.account_id), ['g-two', 'g-two'])
  assert.deepEqual(sync.map(c => c.params.history), [true, true])
  assert.deepEqual(sync.map(c => c.params.restart), [true, false])
  assert.deepEqual(sync.map(c => c.params.since), ['2020-01-01', '2020-01-01'])
  assert.equal(calls.filter(c => c.method === 'plugin.select_account').length, 0)
  assert.match(el('garmin-state').textContent, /Garmin One/)
  assert.match(el('message').textContent, /不可用或未完成项/)
})

test('stop finishes the active batch and leaves subsequent history batches for resume', async t => {
  let finish; const pending = new Promise(resolve => { finish = resolve })
  const { el, calls } = await mount(t, method => method === 'plugin.sync' ? pending : undefined)
  el('garmin-history-import').click(); assert.equal(el('garmin-history-stop').disabled, false); el('garmin-history-stop').click()
  finish({ complete: true, pending: true, sources: [{ source: 'garmin', account_id: 'g-one', pending: true, next_day: '2020-02-01' }], errors: [] }); await tick()
  assert.equal(calls.filter(c => c.method === 'plugin.sync').length, 1); assert.match(el('message').textContent, /续传/)
})

test('retry_required, fatal errors, changed accounts and unchanged cursors never loop indefinitely', async t => {
  for (const response of [{ pending: true, retry_required: true }, { pending: true, fatal_errors: ['failed'] }, { pending: true, sources: [{ source: 'garmin', account_id: 'g-one', pending: true, next_day: '2020-01-01' }], errors: [] }, { pending: true, sources: [{ source: 'garmin', account_id: 'g-two', pending: true, next_day: '2020-01-01' }] }]) {
    const { el, calls } = await mount(t, method => method === 'plugin.sync' ? response : undefined)
    el('garmin-history-import').click(); await tick(); await tick()
    assert.ok(calls.filter(c => c.method === 'plugin.sync').length <= 2); assert.equal(el('message').className, 'error')
  }
})

test('Garmin sync snapshots its current account and keeps it fixed while continuing', async t => {
  const seen = new Map()
  const { el, calls } = await mount(t, (method, params) => {
    if (method === 'plugin.sync') {
      const pending = params.source === 'garmin' && !seen.has(params.source)
      seen.set(params.source, true)
      return { pending, complete: !pending, sources: [{ source: params.source, account_id: params.account_id, pending, next_day: '2026-10-24' }] }
    }
    if (method === 'plugin.status' && seen.size) return { ...status, connections: { ...status.connections, garmin: { ...status.connections.garmin, active_account_id: 'g-two' } } }
  })
  el('garmin-sync').click(); await tick(); await tick()
  const requests = calls.filter(c => c.method === 'plugin.sync')
  assert.deepEqual(requests.map(c => c.params.source), ['garmin', 'garmin'])
  assert.deepEqual(requests.map(c => c.params.account_id), ['g-one', 'g-one'])
  assert.deepEqual(requests.map(c => c.params.file), [undefined, undefined])
  assert.ok(requests.every(c => !c.params.history && !c.params.restart))
  assert.ok(requests.every(call => call.params.since === undefined && call.params.until === undefined))
  assert.match(el('message').textContent, /当前账号同步完成/)
})

test('Garmin credentials clear immediately and never enter reports', async t => {
  let finish; const pending = new Promise(resolve => { finish = resolve })
  const { el, calls } = await mount(t, method => method === 'plugin.connect' ? pending : undefined)
  el('garmin-key').value = 'synthetic-secret'; el('garmin-connect').click()
  assert.equal(el('garmin-key').value, ''); assert.equal(calls.at(-1).params.api_key, 'synthetic-secret'); assert.equal(calls.at(-1).params.region, 'global')
  finish({ connected: true, pending: false }); await tick()
  assert.doesNotMatch(el('report').textContent, /synthetic-secret/); assert.doesNotMatch(el('message').textContent, /synthetic-secret/)
})

test('Garmin addition sends explicit region and label without changing current account', async t => {
  const { el, calls, window } = await mount(t, method => method === 'plugin.connect' ? { connected: true, account_id: 'g-two' } : undefined)
  assert.equal(el('garmin-region').value, 'global')
  el('garmin-region').value = 'china'; el('garmin-label').value = 'China account'; el('garmin-key').value = 'synthetic-secret'; el('garmin-connect').click(); await tick()
  const call = calls.find(call => call.method === 'plugin.connect')
  assert.equal(call.params.region, 'china'); assert.equal(call.params.label, 'China account')
  assert.match(el('garmin-state').textContent, /Garmin One/)
  assert.equal(el('garmin-label').value, '')
  assert.equal(el('vault').readOnly, true)
})

test('Oura authorization keeps the page alive and polls connections without storing secrets', async t => {
  let finish; const pending = new Promise(resolve => { finish = resolve })
  const { el, calls } = await mount(t, method => method === 'plugin.connect' ? { pending: true, authorization_id: 'authorization-new', authorize_url: 'https://cloud.ouraring.com/oauth/authorize?state=synthetic' } : method === 'plugin.connections' ? pending : undefined)
  el('oura-id').value = 'client'; el('oura-secret').value = 'synthetic-secret'; el('oura-connect').click(); await tick()
  assert.equal(el('oura-secret').value, ''); assert.equal(el('authorization').hidden, false)
  assert.equal(calls.find(c => c.method === 'plugin.connect').params.redirect_uri, 'http://127.0.0.1:8765/callback')
  finish({ oura: { pending: false, connected: true, authorization_id: 'authorization-new', completed_account_id: 'o-two' } }); await tick()
  assert.equal(el('authorization').hidden, true); assert.match(el('message').textContent, /账号已保存/)
  assert.doesNotMatch(el('report').textContent, /synthetic-secret/)
})

test('connection failures are sanitized while ordinary errors remain plain text', async t => {
  const { el, window } = await mount(t, method => { if (method === 'plugin.connect') throw new Error('echo synthetic-secret'); if (method === 'plugin.sync') throw new Error('<img src=x>') }, 'en')
  el('garmin-key').value = 'synthetic-secret'; el('garmin-connect').click(); await tick()
  assert.doesNotMatch(el('message').textContent, /synthetic-secret/)
  el('garmin-sync').click(); await tick(); assert.match(el('message').textContent, /Failed:.*<img/); assert.equal(window.document.querySelector('img'), null)
})

test('disconnect removes credentials without sending an archive deletion request', async t => {
  const { el, calls } = await mount(t, method => method === 'plugin.disconnect' ? { connected: false } : undefined)
  el('oura-disconnect').click(); await tick()
  const call = calls.find(c => c.method === 'plugin.disconnect'); assert.deepEqual(call.params, { vault: '/tmp/test-vault', source: 'oura', account_id: 'o-one' }); assert.match(el('message').textContent, /归档数据保留/)
})

test('changing library clears previous records, files, credentials and results before loading the new library', async t => {
  let changed = false
  const { el, calls, window } = await mount(t, (method, params) => {
    if (method === 'plugin.query') return { records: [{ old_library: true }], has_more: true, next_offset: 100 }
    if (method === 'host.dialog.open') return { paths: ['/tmp/new-library'] }
    if (method === 'plugin.configure_storage') { changed = true; return { configured: true, path: params.path } }
    if (changed && method === 'plugin.storage_status') return { configured: true, available: true, path: '/tmp/new-library' }
    if (changed && method === 'plugin.status') return { connections: {} }
    if (changed && method === 'plugin.catalog') return { categories: [] }
  })
  window.document.querySelector('.metric-row').click(); await tick()
  el('garmin-key').value = 'not-submitted'; el('oura-secret').value = 'not-submitted'
  el('storage-choose').click(); await tick()
  assert.equal(el('file').value, ''); assert.equal(el('garmin-key').value, ''); assert.equal(el('oura-secret').value, '')
  assert.equal(el('records').hidden, true); assert.equal(el('next-page').disabled, true)
  assert.equal(el('query-source').value, 'all'); assert.doesNotMatch(el('catalog').textContent, /oura.sleep/)
  assert.equal(calls.at(-1).params.vault, '/tmp/test-vault')
  assert.equal(el('storage-path').value, '/tmp/new-library')
  assert.match(el('overview').textContent, /尚未建立/); assert.equal(el('garmin-history-since').value, '2010-01-01')
})

test('automatic history start follows a first import while a user-selected date remains unchanged', async t => {
  let imported = false
  const { el, window } = await mount(t, method => {
    if (method === 'plugin.status') return imported ? status : { connections: {} }
    if (method === 'plugin.import') { imported = true; return { complete: true } }
  })
  assert.equal(el('garmin-history-since').value, '2010-01-01')
  el('file').value = '/tmp/export.xml'; el('import').click(); await tick()
  assert.equal(el('garmin-history-since').value, '2020-01-01')
  el('garmin-history-since').value = '2023-05-06'; el('garmin-history-since').dispatchEvent(new window.Event('input'))
  el('status').click(); await tick(); assert.equal(el('garmin-history-since').value, '2023-05-06')
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
  const { el } = await mount(t, method => method === 'plugin.connect' ? { pending: true, authorization_id: 'authorization-expired', authorize_url: 'https://cloud.ouraring.com/oauth/authorize?state=expired' } : method === 'plugin.connections' ? { oura: { pending: false, authorization_id: 'authorization-expired', error: 'synthetic-secret' } } : undefined)
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
  assert.deepEqual(cells, ['Oura', 'sleep', '2020-01-01 → 2026-10-24', '6', '2', '1', '0'])
  assert.equal(el('coverage').querySelectorAll('th[scope="col"]').length, 7)
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

test('Apple is file-only and API sync never sends its selected export', async t => {
  const { el, calls } = await mount(t, (method, params) => method === 'plugin.sync' ? { complete: true, sources: [{ source: params.source, account_id: params.account_id }] } : undefined)
  assert.equal(el('sync-source'), null)
  assert.equal(el('apple-panel').querySelector('[id$="-sync"]'), null)
  el('file').value = '/tmp/apple.zip'; el('garmin-sync').click(); await tick()
  const syncs = calls.filter(call => call.method === 'plugin.sync')
  assert.deepEqual(syncs.map(call => call.params.source), ['garmin'])
  assert.ok(syncs.every(call => call.params.file === undefined))
  assert.match(el('scope').textContent, /增量合并/)
})

test('manifest exposes catalog, source/date sync filters and credential-free host CLI', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../manifest.v2.json', import.meta.url)))
  assert.equal(manifest.idle_shutdown_seconds, 600)
  assert.equal(manifest.version, JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).version)
  const cli = manifest.contributes.cli
  assert.ok(cli.some(c => c.subcommand === 'health-catalog')); assert.ok(cli.some(c => c.subcommand === 'health-disconnect'))
  assert.ok(!cli.some(c => c.command === 'connect'))
  assert.ok(cli.find(c => c.command === 'sync').flags.some(f => f.long === '--max-days' && f.type === 'string'))
  assert.ok(!cli.find(c => c.command === 'sync').flags.some(f => f.long === '--file'))
  assert.ok(cli.find(c => c.command === 'query').flags.some(f => f.long === '--category'))
})

test('first-run Apple preview imports the explicitly chosen file without an API request', async t => {
  const { el, calls } = await mount(t, method => {
    if (method === 'plugin.status') return { imported: false, connections: {} }
    if (method === 'host.dialog.open') return { paths: ['/tmp/健康导出.zip'] }
    if (method === 'plugin.import') return { complete: true, dry_run: true }
  })
  el('choose').click(); await tick(); el('apple-dry-run').checked = true
  el('import').click(); await tick()
  assert.match(el('message').textContent, /预览完成/)
  const call = calls.find(c => c.method === 'plugin.import')
  assert.equal(call.params.file, '/tmp/健康导出.zip'); assert.equal(call.params.dry_run, true)
  assert.equal(calls.some(c => c.method === 'plugin.sync'), false)
})

test('saved accounts switch only on explicit action and survive status refresh', async t => {
  let active = 'g-one'
  const { el, calls, window } = await mount(t, (method, params) => {
    if (method === 'plugin.select_account') { active = params.account_id; return { active_account_id: active } }
    if (method === 'plugin.status') return { ...status, connections: { ...status.connections, garmin: { ...status.connections.garmin, active_account_id: active } } }
  })
  assert.equal(el('garmin-account').options.length, 2)
  el('garmin-account').value = 'g-two'; el('garmin-account').dispatchEvent(new window.Event('change'))
  assert.equal(calls.filter(call => call.method === 'plugin.select_account').length, 0)
  assert.match(el('garmin-state').textContent, /Garmin One/)
  el('garmin-select').click(); await tick()
  assert.deepEqual(calls.find(call => call.method === 'plugin.select_account').params, { vault: '/tmp/test-vault', source: 'garmin', account_id: 'g-two' })
  assert.match(el('garmin-state').textContent, /Garmin Two/); assert.equal(el('garmin-select').disabled, true)
  el('status').click(); await tick(); assert.equal(el('garmin-account').value, 'g-two')
})

test('disconnect targets only the selected account and keeps other accounts and archive visible', async t => {
  let disconnected = false
  const { el, calls, window } = await mount(t, method => {
    if (method === 'plugin.disconnect') { disconnected = true; return { connected: false } }
    if (method === 'plugin.status' && disconnected) return { ...status, connections: { ...status.connections, garmin: { ...status.connections.garmin, accounts: status.connections.garmin.accounts.map(account => ({ ...account, connected: account.id !== 'g-two' })) } } }
  })
  el('garmin-account').value = 'g-two'; el('garmin-account').dispatchEvent(new window.Event('change')); el('garmin-disconnect').click(); await tick()
  assert.equal(calls.find(call => call.method === 'plugin.disconnect').params.account_id, 'g-two')
  assert.equal(el('garmin-disconnect').disabled, true); assert.match(el('garmin-state').textContent, /Garmin One/)
  assert.equal(el('garmin-history-account').options.length, 1); assert.match(el('overview').textContent, /24 条记录/)
  assert.equal(calls.some(call => call.method.includes('delete')), false)
})

test('history validates dates, supports Oura and leaves current incremental dates independent', async t => {
  const { el, calls, window } = await mount(t, method => method === 'plugin.sync' ? { complete: true, sources: [{ source: 'oura', account_id: 'o-two', pending: false }] } : undefined)
  el('oura-history-account').value = 'o-two'
  el('oura-history-since').value = '2020-02-01'; el('oura-history-until').value = '2020-01-01'; el('oura-history-import').click(); await tick()
  assert.equal(calls.filter(call => call.method === 'plugin.sync').length, 0); assert.equal(el('message').className, 'error')
  el('oura-history-until').value = '2020-03-01'; el('oura-history-import').click(); await tick()
  const call = calls.find(call => call.method === 'plugin.sync')
  assert.equal(call.params.source, 'oura'); assert.equal(call.params.account_id, 'o-two'); assert.equal(call.params.history, true)
  assert.match(el('message').textContent, /当前同步账号未改变/)
  assert.match(el('oura-state').textContent, /Oura One/)
})

test('incremental sync defers dates to backend progress and account controls stay disabled during a batch', async t => {
  let finish; const pending = new Promise(resolve => { finish = resolve })
  const { el, calls, window } = await mount(t, method => method === 'plugin.sync' ? pending : undefined)
  el('garmin-history-since').value = '2015-01-01'; el('garmin-history-until').value = '2015-02-01'
  el('garmin-sync').click(); await tick()
  const call = calls.find(call => call.method === 'plugin.sync')
  assert.equal(call.params.since, undefined); assert.equal(call.params.until, undefined)
  assert.equal(el('sync-since'), null); assert.equal(el('garmin-account').disabled, true); assert.equal(el('garmin-history-import').disabled, true)
  el('garmin-select').click(); assert.equal(calls.some(call => call.method === 'plugin.select_account'), false)
  finish({ complete: true, sources: [{ source: 'garmin', account_id: 'g-one' }] }); await tick()
})

test('Oura add-account authorization cannot be satisfied by an existing connected account', async t => {
  let polls = 0, finish
  const pending = new Promise(resolve => { finish = resolve })
  const { el, window } = await mount(t, method => {
    if (method === 'plugin.connect') return { pending: true, authorization_id: 'new-auth', authorize_url: 'https://cloud.ouraring.com/oauth/authorize?state=test' }
    if (method === 'plugin.connections') return ++polls === 1 ? { oura: { ...status.connections.oura, pending: true, authorization_id: 'new-auth' } } : pending
  })
  window.setTimeout = callback => setTimeout(callback, 0)
  el('oura-connect').click(); await tick(); await tick()
  assert.equal(el('authorization').hidden, false); assert.doesNotMatch(el('message').textContent, /账号已保存/)
  finish({ oura: { ...status.connections.oura, pending: false, authorization_id: 'new-auth', completed_account_id: 'o-two' } }); await tick()
  assert.equal(el('authorization').hidden, true); assert.match(el('message').textContent, /账号已保存/)
  assert.match(el('oura-state').textContent, /Oura One/)
})

test('superseded Oura authorization fails without accepting another completed request', async t => {
  const { el } = await mount(t, method => method === 'plugin.connect' ? { pending: true, authorization_id: 'mine' } : method === 'plugin.connections' ? { oura: { connected: true, authorization_id: 'another', completed_account_id: 'o-two' } } : undefined)
  el('oura-connect').click(); await tick()
  assert.equal(el('message').className, 'error'); assert.doesNotMatch(el('message').textContent, /账号已保存/)
})

test('provider previews check their own current account without refreshing or switching accounts', async t => {
  const { el, calls } = await mount(t, (method, params) => method === 'plugin.sync' ? { dry_run: true, complete: true, sources: [{ source: params.source, account_id: params.account_id }] } : undefined)
  el('garmin-dry-run').checked = true; el('garmin-sync').click(); await tick()
  el('oura-dry-run').checked = true; el('oura-sync').click(); await tick()
  const requests = calls.filter(call => call.method === 'plugin.sync')
  assert.deepEqual(requests.map(call => call.params.source), ['garmin', 'oura'])
  assert.ok(requests.every(call => call.params.dry_run)); assert.equal(calls.filter(call => call.method === 'plugin.status').length, 1)
  assert.equal(calls.some(call => call.method === 'plugin.select_account'), false)
  assert.equal(JSON.parse(el('report').textContent).sources[0].source, 'oura')
})

test('coverage distinguishes saved accounts and query pagination preserves an account filter', async t => {
  let page = 0
  const coverage = { complete_days: 3, unavailable_days: 0, failed_days: 0, first_coverage_day: '2020-01-01', last_coverage_day: '2020-01-03' }
  const { el, calls, window } = await mount(t, method => {
    if (method === 'plugin.catalog') return { ...catalog, sources: { garmin: { accounts: { 'g-one': { collections: { sleep: coverage } }, 'g-two': { collections: { sleep: coverage } } } } } }
    if (method === 'plugin.query') return { records: [], has_more: ++page === 1, next_offset: page === 1 ? 100 : null }
  })
  assert.equal(el('coverage').querySelectorAll('tbody tr').length, 2)
  assert.match(el('coverage').textContent, /Garmin One/); assert.match(el('coverage').textContent, /Garmin Two/)
  el('query-source').value = 'garmin'; el('query-source').dispatchEvent(new window.Event('change')); el('query-account').value = 'g-two'
  el('query-form').dispatchEvent(new window.Event('submit', { cancelable: true })); await tick(); el('next-page').click(); await tick()
  const queries = calls.filter(call => call.method === 'plugin.query')
  assert.deepEqual(queries.map(call => call.params.account_id), ['g-two', 'g-two'])
  el('query-source').value = 'oura'; el('query-source').dispatchEvent(new window.Event('change'))
  assert.equal(el('query-account').value, ''); assert.equal(el('records').hidden, true)
})

test('account settings and brief Garmin key links are localized and render labels as text', async t => {
  for (const locale of ['zh', 'en']) {
    const { el, window } = await mount(t, method => method === 'plugin.status' ? { ...status, connections: { garmin: { ...status.connections.garmin, accounts: [{ ...status.connections.garmin.accounts[0], label: '<img src=x>' }] } } } : undefined, locale)
    assert.match(el('garmin-help').textContent, locale === 'zh' ? /获取 Key：中国区 \/ 国际区 → Create Key（仅显示一次）。/ : /Get a key: China \/ Global → Create Key \(shown only once\)./)
    assert.equal(el('garmin-key-cn').href, 'https://connect.garmin.cn/app/settings/personalApiToken')
    assert.equal(el('garmin-key-global').href, 'https://connect.garmin.com/app/settings/personalApiToken')
    for (const id of ['garmin-key-cn', 'garmin-key-global']) { assert.equal(el(id).target, '_blank'); assert.ok(el(id).relList.contains('noopener')) }
    assert.match(el('garmin-history-title').textContent, locale === 'zh' ? /历史导入/ : /History import/)
    assert.match(el('garmin-state').textContent, /<img src=x>/); assert.equal(window.document.querySelector('img'), null)
  }
})


test('failed Oura add-account authorization preserves the previously active account', async t => {
  const { el, calls } = await mount(t, method => {
    if (method === 'plugin.connect') return { pending: true, authorization_id: 'failed-add', authorize_url: 'https://cloud.ouraring.com/oauth/authorize?state=failure' }
    if (method === 'plugin.connections') return { ...status.connections, oura: { ...status.connections.oura, pending: false, authorization_id: 'failed-add', error: 'Authorization failed' } }
  })
  el('oura-connect').click(); await tick()
  assert.match(el('oura-state').textContent, /连接未完成.*当前：Oura One/)
  assert.equal(el('oura-account').value, 'o-one')
  assert.equal(el('oura-disconnect').disabled, false)
  assert.equal(calls.some(call => ['plugin.disconnect', 'plugin.select_account'].includes(call.method)), false)
})

test('a new Vault without saved accounts has empty selectors and keeps adding accounts available', async t => {
  const { el, calls } = await mount(t, method => method === 'plugin.status' ? { imported: false, connections: {} } : method === 'plugin.connections' ? {} : undefined)
  for (const provider of ['garmin', 'oura']) {
    assert.equal(el(`${provider}-account`).value, '')
    assert.equal(el(`${provider}-select`).disabled, true)
    assert.equal(el(`${provider}-disconnect`).disabled, true)
    assert.equal(el(`${provider}-connect`).disabled, false)
  }
  assert.equal(el('garmin-history-account').value, ''); assert.equal(el('garmin-history-import').disabled, true)
  assert.equal(el('query-account').value, '')
  el('garmin-sync').click(); await tick()
  assert.equal(calls.some(call => call.method === 'plugin.sync'), false)
  assert.match(el('message').textContent, /请先连接并设置当前账号/)
})

test('newly saved additional account appears without replacing the active account', async t => {
  let saved = false
  const { el } = await mount(t, method => {
    if (method === 'plugin.status') return { ...status, connections: { ...status.connections, garmin: { ...status.connections.garmin, accounts: status.connections.garmin.accounts.slice(0, saved ? 2 : 1) } } }
    if (method === 'plugin.connect') { saved = true; return { account_id: 'g-two', connected: true } }
  })
  assert.equal(el('garmin-account').options.length, 1)
  el('garmin-region').value = 'china'; el('garmin-key').value = 'synthetic-secret'; el('garmin-connect').click(); await tick()
  assert.equal(el('garmin-account').options.length, 2)
  assert.match(el('garmin-state').textContent, /当前：Garmin One/)
  assert.equal(el('garmin-account').value, 'g-one'); assert.equal(el('garmin-key').value, '')
})


test('pending first Oura authorization can be cancelled while busy without ending the outer operation early', async t => {
  let finishPoll
  const poll = new Promise(resolve => { finishPoll = resolve })
  const empty = { connected: false, active_account_id: null, accounts: [] }
  const cancelled = { ...empty, pending: false, authorization_id: 'first-auth', completed_account_id: null, cancelled: true }
  const { el, calls } = await mount(t, method => {
    if (method === 'plugin.status') return { connections: { oura: empty } }
    if (method === 'plugin.connect') return { pending: true, authorization_id: 'first-auth' }
    if (method === 'plugin.connections') return poll
    if (method === 'plugin.cancel_authorization') return cancelled
  })
  el('oura-connect').click(); await tick()
  assert.equal(el('oura-cancel').hidden, false); assert.equal(el('oura-cancel').disabled, false)
  assert.equal(el('oura-disconnect').disabled, true)
  el('oura-cancel').click(); await tick()
  assert.deepEqual(calls.find(call => call.method === 'plugin.cancel_authorization').params, { vault: '/tmp/test-vault', source: 'oura', authorization_id: 'first-auth' })
  assert.equal(el('oura-connect').disabled, true)
  finishPoll({ oura: cancelled }); await tick()
  assert.equal(el('oura-connect').disabled, false); assert.equal(el('oura-cancel').hidden, true)
  assert.match(el('message').textContent, /授权已取消/)
  assert.equal(calls.some(call => call.method === 'plugin.disconnect'), false)
})

test('authorization completion winning a cancellation race retains saved accounts', async t => {
  let finishPoll
  const poll = new Promise(resolve => { finishPoll = resolve })
  const completed = { ...status.connections.oura, pending: false, authorization_id: 'racing-auth', completed_account_id: 'o-two', cancelled: false }
  const { el, calls } = await mount(t, method => {
    if (method === 'plugin.connect') return { pending: true, authorization_id: 'racing-auth' }
    if (method === 'plugin.connections') return poll
    if (method === 'plugin.cancel_authorization') return completed
  })
  el('oura-connect').click(); await tick(); el('oura-cancel').click(); await tick()
  finishPoll({ oura: completed }); await tick()
  assert.match(el('message').textContent, /账号已保存/); assert.match(el('oura-state').textContent, /Oura One/)
  assert.equal(calls.some(call => call.method === 'plugin.disconnect'), false)
})

test('a restored pending authorization without any current account can be cancelled', async t => {
  let cancelled = false
  const state = () => ({ accounts: [], active_account_id: null, pending: !cancelled, authorization_id: 'restored-auth', completed_account_id: null })
  const { el, calls } = await mount(t, method => {
    if (method === 'plugin.status') return { connections: { oura: state() } }
    if (method === 'plugin.cancel_authorization') { cancelled = true; return { ...state(), cancelled: true } }
  })
  assert.equal(el('oura-cancel').disabled, false); assert.equal(el('oura-disconnect').disabled, true)
  el('oura-cancel').click(); await tick()
  assert.equal(el('oura-cancel').hidden, true); assert.match(el('message').textContent, /授权已取消/)
  assert.equal(calls.find(call => call.method === 'plugin.cancel_authorization').params.authorization_id, 'restored-auth')
})

test('Garmin ZIP chooser is separate from Apple and only accepts local ZIP files', async t => {
  let paths = ['/tmp/佳明历史.zip']
  const { el, calls } = await mount(t, method => method === 'host.dialog.open' ? { paths } : undefined)
  el('garmin-zip-choose').click(); await tick()
  assert.equal(el('garmin-zip-file').value, paths[0])
  assert.equal(el('file').value, '/tmp/export.zip')
  assert.deepEqual(calls.at(-1).params.filters[0].extensions, ['zip'])
  paths = null; el('garmin-zip-choose').click(); await tick()
  assert.equal(el('garmin-zip-file').value, '/tmp/佳明历史.zip')
})

test('Garmin ZIP requires a file and explicit region without inheriting API account settings', async t => {
  const { el, calls } = await mount(t)
  assert.equal(el('garmin-zip-region').value, '')
  el('garmin-zip-preview').click(); await tick()
  assert.match(el('message').textContent, /选择.*ZIP/)
  el('garmin-zip-file').value = '/tmp/garmin.zip'
  el('garmin-region').value = 'china'
  el('garmin-zip-import').click(); await tick()
  assert.match(el('message').textContent, /选择.*区域/)
  assert.equal(calls.filter(c => c.method === 'plugin.garmin-import').length, 0)
})

test('Garmin ZIP preview works without credentials and never switches current account', async t => {
  const { el, calls } = await mount(t, method => {
    if (method === 'plugin.status') return { imported: false, connections: {} }
    if (method === 'plugin.garmin-import') return { complete: true, dry_run: true, account_id: 'offline-account', records: 42, files: 5, parsed_files: 2, preserved_only_files: 3, file_reports: [{ path: 'private/original-health-file.json' }] }
  })
  el('garmin-zip-file').value = '/tmp/garmin.zip'; el('garmin-zip-region').value = 'china'
  el('garmin-zip-preview').click(); await tick()
  assert.deepEqual(calls.find(c => c.method === 'plugin.garmin-import').params, { vault: '/tmp/test-vault', file: '/tmp/garmin.zip', region: 'china', dry_run: true })
  assert.equal(calls.filter(c => c.method === 'plugin.status').length, 1)
  assert.equal(calls.filter(c => /plugin\.(connect|select_account|sync|import)$/.test(c.method)).length, 0)
  assert.match(el('message').textContent, /预览完成/)
  assert.match(el('report').textContent, /preserved_only_files/)
  assert.match(el('message').textContent, /42 条记录.*5 个文件.*2 个已解析.*3 个仅保留原件.*offline-/)
  assert.doesNotMatch(el('report').textContent, /private\/original-health-file/)
})

test('Garmin ZIP import has its own action, refreshes offline account catalog and preserves current API account', async t => {
  let imported = false
  const { el, calls, window } = await mount(t, method => {
    if (method === 'plugin.garmin-import') { imported = true; return { complete: true, dry_run: false } }
    if (method === 'plugin.catalog' && imported) return { categories: [], sources: { garmin: { accounts: { 'offline-account': { collections: {} } } } } }
  })
  el('apple-dry-run').checked = true
  el('garmin-zip-file').value = '/tmp/garmin.zip'; el('garmin-zip-region').value = 'global'
  el('garmin-zip-import').click(); await tick()
  assert.equal(calls.find(c => c.method === 'plugin.garmin-import').params.dry_run, false)
  assert.equal(calls.filter(c => c.method === 'plugin.status').length, 2)
  assert.match(el('message').textContent, /Garmin.*已导入/)
  assert.match(el('garmin-state').textContent, /Garmin One/)
  el('query-source').value = 'garmin'; el('query-source').dispatchEvent(new window.Event('change'))
  assert.ok([...el('query-account').options].some(item => item.value === 'offline-account'))
})

test('Garmin ZIP busy and failed operations retain details and avoid duplicate imports', async t => {
  let finish; const pending = new Promise(resolve => { finish = resolve })
  const { el, calls } = await mount(t, method => method === 'plugin.garmin-import' ? pending : undefined)
  el('garmin-zip-file').value = '/tmp/garmin.zip'; el('garmin-zip-region').value = 'china'
  el('garmin-zip-import').click(); el('garmin-zip-preview').click()
  assert.equal(el('garmin-sync').disabled, true)
  assert.equal(calls.filter(c => c.method === 'plugin.garmin-import').length, 1)
  finish({ complete: false, import: { errors: ['One source record could not be processed'] } }); await tick()
  assert.equal(el('message').className, 'error'); assert.match(el('report').textContent, /errors/)
  assert.equal(el('garmin-zip-preview').disabled, false)
})

test('changing library clears the Garmin ZIP path and region', async t => {
  const { el } = await mount(t, method => method === 'host.dialog.open' ? { paths: ['/tmp/other-library'] } : undefined)
  el('garmin-zip-file').value = '/tmp/garmin.zip'; el('garmin-zip-region').value = 'china'
  el('storage-choose').click(); await tick()
  assert.equal(el('garmin-zip-file').value, ''); assert.equal(el('garmin-zip-region').value, '')
})

test('Garmin ZIP controls and independent preview action are translated', async t => {
  const { el } = await mount(t, undefined, 'en')
  assert.equal(el('garmin-zip-title').textContent, 'Import Garmin export ZIP')
  assert.equal(el('garmin-zip-preview').textContent, 'Preview ZIP')
  assert.match(el('garmin-zip-help').textContent, /No API key/)
})

test('manifest exposes credential-free Garmin ZIP import with explicit region', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../manifest.v2.json', import.meta.url)))
  const command = manifest.contributes.cli.find(c => c.subcommand === 'health-garmin-import')
  assert.equal(command.command, 'garmin-import')
  assert.deepEqual(command.args.map(a => [a.name, a.required]), [['file', true]])
  assert.deepEqual(command.flags.map(f => f.long), ['--region', '--vault', '--dry-run'])
  assert.ok(manifest.activation.events.includes('onCli:health-garmin-import'))
})


test('Garmin ZIP coverage distinguishes observed export days and undated records from API completion', async t => {
  const { el } = await mount(t, method => method === 'plugin.catalog' ? { categories: [], sources: { garmin: { accounts: { 'offline-account': { collections: { export_sleep: { observed_days: 47, complete_days: 0, unavailable_days: 0, failed_days: 0, first_coverage_day: '2020-01-01', last_coverage_day: '2021-02-01', undated: { status: 'observed' } } } } } } } } : undefined)
  const cells = [...el('coverage').querySelectorAll('tbody td')].map(cell => cell.textContent)
  assert.deepEqual(cells.slice(3), ['0', '0', '0', '47'])
  assert.match(el('coverage').querySelector('thead').textContent, /导出中有记录/)
  assert.match(cells[1], /无日期记录: 导出中有记录/)
  assert.match(el('coverage-help').textContent, /ZIP.*不代表完整日期或 API 覆盖/)
})

test('export observed coverage labels and caveat are translated', async t => {
  const { el } = await mount(t, undefined, 'en')
  assert.match(el('coverage').querySelector('thead').textContent, /Days observed in export/)
  assert.match(el('coverage-help').textContent, /ZIP.*do not establish complete dates or API coverage/)
})

// Advance only this window's timers; requests remain explicitly controlled.
function importClock(window) {
  let now = 0, next = 0
  const timers = new Map()
  window.setTimeout = (callback, delay = 0) => { const id = ++next; timers.set(id, { at: now + delay, callback }); return id }
  window.clearTimeout = id => timers.delete(id)
  return {
    advance(ms) {
      now += ms
      for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.callback() }
    },
    get pending() { return timers.size },
  }
}
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

for (const scenario of [
  { id: 'import', method: 'plugin.import' },
  { id: 'import', method: 'plugin.import', preview: true },
  { id: 'garmin-zip-import', method: 'plugin.garmin-import' },
  { id: 'garmin-zip-preview', method: 'plugin.garmin-import' },
  { id: 'oura-file-import', method: 'plugin.oura-import' },
  { id: 'oura-file-preview', method: 'plugin.oura-import' },
  ...['garmin', 'oura'].flatMap(source => [false, true].map(preview => ({ id: `${source}-sync`, method: 'plugin.sync', source, preview }))),
  ...['garmin', 'oura'].flatMap(source => [false, true].map(preview => ({ id: `${source}-history-import`, method: 'plugin.sync', source, preview }))),
]) test(`delayed import progress: ${scenario.id}/${scenario.source ?? 'file'}/${scenario.preview ? 'preview' : 'write'}`, async t => {
  const request = deferred()
  const { el, window } = await mount(t, method => method === scenario.method ? request.promise : undefined)
  const clock = importClock(window)
  el(scenario.source ? `${scenario.source}-dry-run` : 'apple-dry-run').checked = Boolean(scenario.preview)
  el('garmin-zip-file').value = '/tmp/garmin.zip'; el('garmin-zip-region').value = 'china'
  el('oura-file').value = '/tmp/oura.csv'; el('oura-file-account').value = 'o-two'
  el(scenario.id).click(); await tick()
  clock.advance(2999); assert.equal(el('import-progress').hidden, true)
  clock.advance(1); assert.equal(el('import-progress').hidden, false)
  const bar = el('import-progress').querySelector('progress')
  assert.equal(bar.hasAttribute('value'), false)
  assert.equal(bar.hasAttribute('aria-valuenow'), false)
  assert.equal(bar.getAttribute('aria-labelledby'), 'import-progress-label')
  assert.equal(bar.closest('[aria-busy="true"]'), null)
  assert.equal(el('import-progress-label').textContent, el('message').textContent)
  request.resolve({ complete: true }); await tick()
  assert.equal(el('import-progress').hidden, true); assert.equal(clock.pending, 0)
  assert.equal(el(scenario.id).disabled, false)
})

for (const outcome of ['success', 'error', 'incomplete']) test(`fast import ${outcome} cancels delayed progress and a new import starts a fresh timer`, async t => {
  let request = deferred()
  const { el, window } = await mount(t, method => method === 'plugin.import' ? request.promise : undefined)
  const clock = importClock(window)
  el('import').click(); clock.advance(2500)
  if (outcome === 'error') request.reject(new Error('synthetic failure'))
  else request.resolve({ complete: outcome === 'success' })
  await tick()
  assert.equal(el('import-progress').hidden, true); assert.equal(clock.pending, 0)
  assert.equal(el('message').classList.contains('error'), outcome !== 'success')
  clock.advance(10000); assert.equal(el('import-progress').hidden, true)
  request = deferred(); el('import').click()
  clock.advance(2999); assert.equal(el('import-progress').hidden, true)
  clock.advance(1); assert.equal(el('import-progress').hidden, false)
  request.reject(new Error('synthetic failure')); await tick()
  assert.equal(el('import-progress').hidden, true); assert.equal(clock.pending, 0)
  assert.equal(el('import').disabled, false)
})

test('history progress spans short batches and refreshes, and stays visible until a requested stop finishes the active batch', async t => {
  const batches = [deferred(), deferred()]
  let batch = 0
  const { el, window, calls } = await mount(t, method => method === 'plugin.sync' ? batches[batch++].promise : undefined)
  const clock = importClock(window)
  el('garmin-history-import').click(); clock.advance(2000)
  const pending = { complete: false, pending: true, sources: [{ source: 'garmin', account_id: 'g-one', pending: true, next_day: '2020-02-01' }] }
  batches[0].resolve(pending); await tick()
  assert.equal(batch, 2); assert.equal(calls.filter(c => c.method === 'plugin.status').length, 2)
  clock.advance(999); assert.equal(el('import-progress').hidden, true)
  clock.advance(1); assert.equal(el('import-progress').hidden, false)
  assert.match(el('import-progress-label').textContent, /批次 2.*Garmin/)
  el('garmin-history-stop').click()
  assert.match(el('import-progress-label').textContent, /本批完成后停止/)
  assert.equal(el('import-progress').hidden, false)
  batches[1].resolve({ ...pending, sources: [{ ...pending.sources[0], next_day: '2020-03-01' }] }); await tick()
  assert.equal(batch, 2); assert.equal(el('import-progress').hidden, true)
  assert.equal(clock.pending, 0); assert.match(el('message').textContent, /已停止后续批次/)
})

test('import progress remains visible during the final catalog refresh', async t => {
  const refresh = deferred()
  let statuses = 0
  const { el, window } = await mount(t, method => {
    if (method === 'plugin.import') return { complete: true }
    if (method === 'plugin.status' && ++statuses > 1) return refresh.promise
  })
  const clock = importClock(window)
  el('import').click(); await tick(); clock.advance(3000)
  assert.equal(el('import-progress').hidden, false); assert.equal(el('import').disabled, true)
  refresh.resolve(status); await tick()
  assert.equal(el('import-progress').hidden, true); assert.equal(el('import').disabled, false)
})

for (const id of ['choose', 'garmin-zip-choose', 'status', 'garmin-connect', 'query']) test(`non-import action ${id} does not show import progress`, async t => {
  const request = deferred()
  let started = false
  const { el, window } = await mount(t, () => started ? request.promise : undefined)
  const clock = importClock(window); started = true
  el(id).click(); await tick(); clock.advance(10000)
  assert.equal(el('import-progress').hidden, true); assert.equal(clock.pending, 0)
  request.reject(new Error('synthetic failure')); await tick()
})

test('English import progress is localized', async t => {
  const request = deferred()
  const { el, window } = await mount(t, method => method === 'plugin.import' ? request.promise : undefined, 'en')
  const clock = importClock(window)
  el('import').click(); clock.advance(3000)
  assert.equal(el('import-progress-label').textContent, 'Processing…')
  request.resolve({ complete: true }); await tick()
})

test('first use gates archive and account access until a native external folder is configured', async t => {
  let configured = false
  const { el, calls, window } = await mount(t, (method, params) => {
    if (method === 'plugin.storage_status') return configured ? { configured: true, available: true, path: '/Volumes/Health/资料库' } : { configured: false }
    if (method === 'host.dialog.open') return { paths: ['/Volumes/Health/资料库'] }
    if (method === 'plugin.configure_storage') { configured = true; return { configured: true, path: params.path } }
  })
  assert.deepEqual(calls.map(call => call.method), ['host.vault.info', 'plugin.storage_status'])
  assert.equal(el('vault').readOnly, true); assert.equal(el('storage-path').readOnly, true)
  assert.equal(el('storage-path').value, '')
  assert.match(el('storage-help').textContent, /禁止使用 Vault 或其子目录/)
  for (const id of ['import', 'garmin-sync', 'oura-sync', 'garmin-history-import', 'oura-history-import', 'query', 'garmin-connect', 'oura-connect', 'garmin-zip-preview', 'garmin-zip-import', 'oura-file-preview', 'oura-file-import']) {
    assert.equal(el(id).disabled, true, id); el(id).click()
  }
  el('query-form').dispatchEvent(new window.Event('submit', { cancelable: true })); await tick()
  assert.equal(calls.length, 2)
  el('storage-choose').click(); await tick()
  assert.deepEqual(calls.find(call => call.method === 'host.dialog.open').params, { title: '选择资料库文件夹…', directory: true, multiple: false })
  assert.deepEqual(calls.find(call => call.method === 'plugin.configure_storage').params, { vault: '/tmp/test-vault', path: '/Volumes/Health/资料库' })
  assert.equal(el('storage-path').value, '/Volumes/Health/资料库'); assert.equal(el('import').disabled, false)
  assert.ok(calls.findIndex(call => call.method === 'plugin.status') > calls.findIndex(call => call.method === 'plugin.configure_storage'))
})

test('cancelled first folder selection performs no configuration or archive requests', async t => {
  const { el, calls } = await mount(t, method => method === 'plugin.storage_status' ? { configured: false } : method === 'host.dialog.open' ? { paths: null } : undefined)
  el('storage-choose').click(); await tick()
  assert.deepEqual(calls.map(call => call.method), ['host.vault.info', 'plugin.storage_status', 'host.dialog.open'])
  assert.equal(el('storage-path').value, ''); assert.equal(el('garmin-sync').disabled, true); assert.match(el('message').textContent, /已取消/)
})

for (const path of ['/tmp/test-vault', '/tmp/test-vault/health', '/tmp/link-to-vault']) test(`rejected library ${path} stays unconfigured with the backend containment error`, async t => {
  const { el, calls } = await mount(t, method => {
    if (method === 'plugin.storage_status') return { configured: false }
    if (method === 'host.dialog.open') return { paths: [path] }
    if (method === 'plugin.configure_storage') throw new Error('Health library must be outside the Vault (including symlinks)')
  })
  el('storage-choose').click(); await tick()
  assert.equal(el('storage-path').value, ''); assert.equal(el('garmin-sync').disabled, true)
  assert.equal(el('message').className, 'error'); assert.match(el('message').textContent, /outside the Vault/)
  assert.equal(calls.some(call => ['plugin.status', 'plugin.catalog', 'plugin.connections'].includes(call.method)), false)
})

test('offline library keeps its path, gates work and recovers after reconnect and check', async t => {
  let available = false
  const { el, calls } = await mount(t, method => method === 'plugin.storage_status' ? { configured: true, available, path: '/Volumes/Offline/Health', error: available ? undefined : 'Drive is offline' } : undefined)
  assert.equal(el('storage-path').value, '/Volumes/Offline/Health'); assert.equal(el('import').disabled, true)
  assert.match(el('storage-state').textContent, /重新检查/)
  assert.deepEqual(calls.map(call => call.method), ['host.vault.info', 'plugin.storage_status'])
  available = true; el('storage-check').click(); await tick()
  assert.equal(el('storage-path').value, '/Volumes/Offline/Health'); assert.equal(el('import').disabled, false)
  assert.equal(calls.some(call => call.method === 'plugin.configure_storage'), false)
})

test('storage failure clears loaded data and allows recheck without Vault fallback', async t => {
  let failed = false
  const { el, calls } = await mount(t, method => { if (failed && method === 'plugin.storage_status') throw new Error('Disk unavailable') })
  failed = true; el('status').click(); await tick()
  assert.equal(el('storage-path').value, '/tmp/health-library')
  assert.equal(el('query').disabled, true); assert.equal(el('oura-connect').disabled, true)
  assert.doesNotMatch(el('catalog').textContent, /oura.sleep/); assert.match(el('storage-state').textContent, /连接原磁盘/)
  const before = calls.length
  failed = false; el('storage-check').click(); await tick()
  assert.equal(el('query').disabled, false)
  assert.deepEqual(calls.slice(before).map(call => call.method), ['plugin.storage_status', 'plugin.status', 'plugin.catalog'])
})

test('reopening uses saved library without prompting or configuring again', async t => {
  for (let open = 0; open < 2; open++) {
    const { el, calls } = await mount(t)
    assert.equal(el('storage-path').value, '/tmp/health-library')
    assert.equal(calls.some(call => ['host.dialog.open', 'plugin.configure_storage'].includes(call.method)), false)
  }
})


test('missing host Vault never uses a default path', async t => {
  const { el, calls } = await mount(t, method => method === 'host.vault.info' ? {} : undefined)
  assert.equal(el('storage-choose').disabled, true); assert.equal(el('import').disabled, true)
  assert.match(el('message').textContent, /打开 Vault/); assert.deepEqual(calls.map(call => call.method), ['host.vault.info'])
})

test('localized library setup explains SQLite and deferred reports', async t => {
  const { el } = await mount(t, method => method === 'plugin.storage_status' ? { configured: false } : undefined, 'en')
  assert.match(el('storage-help').textContent, /outside your Vault/); assert.match(el('storage-help').textContent, /SQLite/)
  assert.match(el('storage-help').textContent, /only shows current data coverage/)
  assert.equal(el('storage-choose').textContent, 'Choose library folder…')
})

test('Oura export selects CSV, JSON or ZIP independently and cancellation preserves its file', async t => {
  let paths = ['/tmp/oura.csv']
  const { el, calls } = await mount(t, method => method === 'host.dialog.open' ? { paths } : undefined)
  el('oura-file-choose').click(); await tick()
  assert.equal(el('oura-file').value, '/tmp/oura.csv'); assert.equal(el('file').value, '/tmp/export.zip')
  assert.deepEqual(calls.at(-1).params.filters[0].extensions, ['zip', 'csv', 'json'])
  paths = null; el('oura-file-choose').click(); await tick()
  assert.equal(el('oura-file').value, '/tmp/oura.csv')
})

test('Oura file requires explicit identity and never assumes the current API account', async t => {
  const { el, calls } = await mount(t)
  assert.equal(el('oura-file-account').value, '')
  el('oura-file').value = '/tmp/oura.csv'; el('oura-file-preview').click(); await tick()
  assert.match(el('message').textContent, /明确选择数据所属账号/)
  assert.equal(calls.some(call => call.method === 'plugin.oura-import'), false)
})

for (const [button, dry_run] of [['oura-file-preview', true], ['oura-file-import', false]]) test(`Oura ${button} binds a saved historical account without switching the API account`, async t => {
  const { el, calls } = await mount(t, method => method === 'plugin.oura-import' ? { complete: true, records: 2, file_reports: [{ path: 'private.csv' }] } : undefined)
  el('oura-file').value = '/tmp/oura.json'; el('oura-file-account').value = 'o-two'; el(button).click(); await tick()
  assert.deepEqual(calls.find(call => call.method === 'plugin.oura-import').params, { vault: '/tmp/test-vault', file: '/tmp/oura.json', account_id: 'o-two', dry_run })
  assert.equal(calls.some(call => call.method === 'plugin.select_account'), false)
  assert.doesNotMatch(el('report').textContent, /private.csv/)
  assert.match(el('oura-state').textContent, /Oura One/)
  assert.equal(calls.filter(call => call.method === 'plugin.status').length, dry_run ? 1 : 2)
})

test('Oura offline profile is explicit, stable and mutually exclusive with saved account selection', async t => {
  const { el, calls, window } = await mount(t, method => method === 'plugin.oura-import' ? { complete: true } : undefined)
  el('oura-file').value = '/tmp/oura.zip'; el('oura-file-account').value = '__offline__'; el('oura-file-account').dispatchEvent(new window.Event('change'))
  assert.equal(el('oura-profile-fields').hidden, false)
  el('oura-file-preview').click(); await tick()
  assert.match(el('message').textContent, /离线账号名称/)
  assert.equal(calls.some(call => call.method === 'plugin.oura-import'), false)
  el('oura-profile').value = '  retired-account  '; el('oura-file-preview').click(); await tick()
  assert.deepEqual(calls.find(call => call.method === 'plugin.oura-import').params, { vault: '/tmp/test-vault', file: '/tmp/oura.zip', profile: 'retired-account', dry_run: true })
  el('oura-file-account').value = 'o-two'; el('oura-file-account').dispatchEvent(new window.Event('change'))
  assert.equal(el('oura-profile-fields').hidden, true)
  el('oura-file-preview').click(); await tick()
  const imports = calls.filter(call => call.method === 'plugin.oura-import')
  assert.equal(imports.at(-1).params.account_id, 'o-two'); assert.equal(imports.at(-1).params.profile, undefined)
})

test('Oura import error or incomplete result remains visible and never claims success', async t => {
  for (const outcome of ['error', 'incomplete']) {
    const { el } = await mount(t, method => {
      if (method === 'plugin.oura-import') { if (outcome === 'error') throw new Error('Unrecognized Oura schema'); return { complete: false, errors: ['bad.csv'] } }
    })
    el('oura-file').value = '/tmp/oura.zip'; el('oura-file-account').value = 'o-two'; el('oura-file-import').click(); await tick()
    assert.equal(el('message').className, 'error'); assert.doesNotMatch(el('message').textContent, /已增量导入/)
    assert.equal(el('oura-file-import').disabled, false)
  }
})

test('changing library clears Oura export identity and path', async t => {
  const { el } = await mount(t, method => method === 'host.dialog.open' ? { paths: ['/tmp/other-library'] } : undefined)
  el('oura-file').value = '/tmp/oura.zip'; el('oura-file-account').value = '__offline__'; el('oura-profile').value = 'old-person'
  el('storage-choose').click(); await tick()
  assert.equal(el('oura-file').value, ''); assert.equal(el('oura-file-account').value, ''); assert.equal(el('oura-profile').value, '')
  assert.equal(el('oura-profile-fields').hidden, true)
})

test('a pending storage lookup gates controls and cannot be bypassed by form submission', async t => {
  const pending = deferred()
  const { el, calls, window } = await mount(t, method => method === 'plugin.storage_status' ? pending.promise : undefined)
  assert.equal(el('import').disabled, true); assert.equal(el('storage-choose').disabled, true)
  el('query-form').dispatchEvent(new window.Event('submit', { cancelable: true })); await tick()
  assert.deepEqual(calls.map(call => call.method), ['host.vault.info', 'plugin.storage_status'])
  pending.resolve({ configured: true, available: true, path: '/tmp/health-library' }); await tick()
  assert.equal(el('import').disabled, false)
})

test('rejected library change keeps the current library and records usable', async t => {
  const { el, calls } = await mount(t, method => {
    if (method === 'host.dialog.open') return { paths: ['/tmp/test-vault/health'] }
    if (method === 'plugin.configure_storage') throw new Error('Library must be outside Vault')
  })
  el('storage-choose').click(); await tick()
  assert.equal(el('storage-path').value, '/tmp/health-library')
  assert.equal(el('import').disabled, false); assert.match(el('catalog').textContent, /oura.sleep/)
  assert.equal(calls.filter(call => call.method === 'plugin.status').length, 1)
})

test('Oura export can explicitly reuse a disconnected or archive-only identity without connecting', async t => {
  const { el, calls } = await mount(t, method => {
    if (method === 'plugin.status') return { ...status, connections: { oura: { accounts: [{ id: 'retired-api', label: 'Retired', connected: false }] } } }
    if (method === 'plugin.catalog') return { categories: [], sources: { oura: { accounts: { 'archived-profile': { collections: {} } } } } }
    if (method === 'plugin.oura-import') return { complete: true }
  })
  assert.ok([...el('oura-file-account').options].some(option => option.value === 'retired-api'))
  el('oura-file').value = '/tmp/oura.json'; el('oura-file-account').value = 'archived-profile'; el('oura-file-preview').click(); await tick()
  assert.equal(calls.find(call => call.method === 'plugin.oura-import').params.account_id, 'archived-profile')
  assert.equal(calls.some(call => ['plugin.connect', 'plugin.select_account'].includes(call.method)), false)
})

for (const locale of ['zh', 'en']) test(`provider sections permanently contain their own accounts, files and API forms (${locale})`, async t => {
  const { el, window } = await mount(t, undefined, locale)
  const controls = {
    garmin: ['garmin-connect', 'garmin-account', 'garmin-key', 'garmin-zip-choose', 'garmin-zip-preview', 'garmin-zip-import', 'garmin-sync', 'garmin-stop', 'garmin-history-account', 'garmin-history-since', 'garmin-history-until', 'garmin-history-import', 'garmin-history-stop'],
    oura: ['oura-connect', 'oura-account', 'oura-cancel', 'oura-file-choose', 'oura-file-account', 'oura-file-preview', 'oura-file-import', 'oura-sync', 'oura-stop', 'oura-history-account', 'oura-history-since', 'oura-history-until', 'oura-history-import', 'oura-history-stop'],
  }
  for (const [source, ids] of Object.entries(controls)) for (const id of ids) assert.equal(el(id).closest('.provider-panel')?.id, `${source}-panel`, id)
  for (const id of ['file', 'choose', 'import', 'apple-dry-run']) assert.ok(el('apple-panel').contains(el(id)), id)
  for (const id of ['storage-panel', 'catalog', 'query-panel', 'overview']) assert.equal(el(id).closest('.provider-panel'), null, id)
  const ids = [...window.document.querySelectorAll('[id]')].map(element => element.id)
  assert.equal(new Set(ids).size, ids.length, 'all rendered IDs are unique')
  for (const label of window.document.querySelectorAll('label[for]')) assert.ok(el(label.htmlFor), label.htmlFor)
  assert.equal(el('sync-source'), null); assert.equal(el('history-source'), null)
  assert.equal(el('apple-panel').querySelector('[id$="-sync"]'), null)
})

test('provider history accounts, dates and preview settings stay independent', async t => {
  const { el, calls, window } = await mount(t, (method, params) => method === 'plugin.sync' ? { complete: true, sources: [{ source: params.source, account_id: params.account_id }] } : undefined)
  el('garmin-history-account').value = 'g-two'; el('garmin-history-since').value = '2020-02-01'; el('garmin-history-until').value = '2020-03-01'; el('garmin-dry-run').checked = true
  el('oura-history-account').value = 'o-two'; el('oura-history-since').value = '2021-02-01'; el('oura-history-until').value = '2021-03-01'; el('oura-restart').checked = true
  const garminForm = el('garmin-history-panel'), ouraForm = el('oura-history-panel')
  el('garmin-history-import').click(); await tick()
  el('oura-history-import').click(); await tick()
  const syncs = calls.filter(call => call.method === 'plugin.sync')
  assert.deepEqual(syncs.map(call => [call.params.source, call.params.account_id, call.params.since, call.params.until, call.params.dry_run, call.params.restart]), [
    ['garmin', 'g-two', '2020-02-01', '2020-03-01', true, false],
    ['oura', 'o-two', '2021-02-01', '2021-03-01', false, true],
  ])
  assert.equal(el('garmin-history-panel'), garminForm); assert.equal(el('oura-history-panel'), ouraForm)
  assert.equal(garminForm.parentElement, el('garmin-panel')); assert.equal(ouraForm.parentElement, el('oura-panel'))
  el('apple-dry-run').checked = true; el('apple-dry-run').dispatchEvent(new window.Event('change'))
  assert.match(el('import').textContent, /预览/); assert.match(el('garmin-history-import').textContent, /预览/); assert.doesNotMatch(el('oura-history-import').textContent, /预览/)
})

test('a provider import locks both sections and only its own stop controls are active', async t => {
  const pending = deferred()
  const { el, calls } = await mount(t, method => method === 'plugin.sync' ? pending.promise : undefined)
  el('oura-history-import').click(); await tick()
  assert.equal(el('oura-history-stop').disabled, false); assert.equal(el('oura-stop').disabled, false)
  assert.equal(el('garmin-history-stop').disabled, true); assert.equal(el('garmin-stop').disabled, true)
  assert.equal(el('garmin-sync').disabled, true); assert.equal(el('garmin-zip-import').disabled, true)
  el('garmin-sync').click(); assert.equal(calls.filter(call => call.method === 'plugin.sync').length, 1)
  el('oura-history-stop').click()
  pending.resolve({ complete: true, pending: true, sources: [{ source: 'oura', account_id: 'o-one', pending: true, next_day: '2020-02-01' }] }); await tick()
  assert.equal(calls.filter(call => call.method === 'plugin.sync').length, 1)
  assert.equal(el('garmin-sync').disabled, false); assert.equal(el('oura-history-stop').disabled, true)
  assert.equal(el('garmin-sync').closest('.provider-panel').id, 'garmin-panel')
  assert.equal(el('oura-history-import').closest('.provider-panel').id, 'oura-panel')
})

test('a configured path without confirmed availability does not unlock library operations', async t => {
  const { el, calls } = await mount(t, method => method === 'plugin.storage_status' ? { configured: true, path: '/tmp/health-library' } : undefined)
  assert.equal(el('import').disabled, true); assert.equal(el('garmin-sync').disabled, true)
  assert.equal(el('storage-path').value, '/tmp/health-library')
  assert.deepEqual(calls.map(call => call.method), ['host.vault.info', 'plugin.storage_status'])
})
