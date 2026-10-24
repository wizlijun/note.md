import './style.css'

interface Bridge { locale?: string; request(method: string, params?: unknown): Promise<unknown> }
declare global { interface Window { notemd?: Bridge } }
type Json = Record<string, unknown>
type Connection = { connected?: boolean; pending?: boolean; error?: string; region?: string }
type Metric = { metric: string; source: string; record_count: number; first_day?: string; last_day?: string }
type Coverage = { complete_days?: number; unavailable_days?: number; failed_days?: number; first_coverage_day?: string | null; last_coverage_day?: string | null; undated?: { status: string } | null }
type SourceCoverage = Record<string, { collections?: Record<string, Coverage> }>
type Category = { slug: string; record_count: number; first_day?: string; last_day?: string; metrics: Metric[] }
const zh = (window.notemd?.locale ?? navigator.language).startsWith('zh')
const t = (cn: string, en: string) => zh ? cn : en
const title = t('健康数据同步', 'Health Sync')
const categories: Record<string, string> = {
  sleep: t('睡眠', 'Sleep'), heart: t('心脏', 'Heart'), vitals: t('生命体征', 'Vitals'),
  activity: t('活动与恢复', 'Activity & recovery'), body: t('身体测量', 'Body measurements'),
  mindfulness: t('情绪与压力', 'Mindfulness & stress'), nutrition: t('营养', 'Nutrition'),
  mobility: t('行动能力', 'Mobility'), reproductive: t('生殖健康', 'Reproductive health'),
  hearing: t('听力', 'Hearing'), environment: t('环境', 'Environment'),
  medications: t('用药', 'Medications'), clinical: t('临床记录', 'Clinical records'),
  metadata: t('个人与设备', 'Personal & device'), other: t('其他记录', 'Other records'),
}
const sources: Record<string, string> = { all: t('所有来源', 'All sources'), 'apple-health': 'Apple Health', garmin: 'Garmin', oura: 'Oura' }
document.documentElement.lang = zh ? 'zh-CN' : 'en'
document.title = title
// Only static markup enters innerHTML. Provider data always uses textContent.
document.querySelector('#app')!.innerHTML = `
<header><p class="eyebrow">APPLE HEALTH · GARMIN · OURA</p><h1></h1><p id="intro"></p></header>
<section class="panel"><label for="vault" id="vault-label"></label><input id="vault" autocomplete="off" spellcheck="false"><div id="overview" class="overview"></div></section>
<section><div class="section-heading"><h2 id="catalog-title"></h2><button id="status" class="secondary"></button></div><p id="catalog-help" class="help"></p><div id="catalog" class="catalog"></div><details><summary id="coverage-title"></summary><p id="coverage-help" class="help"></p><div id="coverage" class="coverage"></div></details></section>
<section class="panel"><h2 id="acquire-title"></h2><label for="file" id="file-label"></label><div class="file-row"><input id="file" autocomplete="off" spellcheck="false"><button id="choose" class="secondary"></button><button id="import" class="secondary"></button></div><p id="scope" class="help"></p>
<div class="dates"><div><label id="sync-source-label" for="sync-source"></label><select id="sync-source"></select></div><div><label id="sync-since-label" for="sync-since"></label><input id="sync-since" type="date" required></div><div><label id="sync-until-label" for="sync-until"></label><input id="sync-until" type="date" required></div></div>
<label class="check"><input id="restart" type="checkbox"><span id="restart-label"></span></label><label class="check"><input id="dry-run" type="checkbox"><span id="dry-run-label"></span></label><div class="actions"><button id="sync"></button><button id="stop" class="secondary" disabled></button></div><p id="sync-help" class="help"></p></section>
<section class="result"><h2 id="result-title"></h2><p id="message" role="status" aria-live="polite"></p><details id="report-details" hidden><summary id="report-title"></summary><pre id="report" hidden></pre></details></section>
<details class="panel" id="connections-panel"><summary id="connections-title"></summary>
<div class="connections"><section><h3>Garmin</h3><p id="garmin-state" role="status"></p><label id="garmin-region-label" for="garmin-region"></label><select id="garmin-region"></select><label for="garmin-key">Personal API key</label><input id="garmin-key" type="password" autocomplete="off" aria-describedby="garmin-help"><p id="garmin-help" class="help"><span id="garmin-help-prefix"></span><a id="garmin-key-cn" href="https://connect.garmin.cn/app/settings/personalApiToken" target="_blank" rel="noopener noreferrer"></a> / <a id="garmin-key-global" href="https://connect.garmin.com/app/settings/personalApiToken" target="_blank" rel="noopener noreferrer"></a><span id="garmin-help-suffix"></span></p><div class="actions"><button id="garmin-connect"></button><button id="garmin-disconnect" class="secondary"></button></div></section>
<section><h3>Oura</h3><p id="oura-state" role="status"></p><p id="oura-help" class="help"></p><label for="oura-id">Client ID</label><input id="oura-id" autocomplete="off" spellcheck="false"><label for="oura-secret">Client secret</label><input id="oura-secret" type="password" autocomplete="off"><label for="oura-redirect">Redirect URI</label><input id="oura-redirect" value="http://127.0.0.1:8765/callback" spellcheck="false"><div class="actions"><button id="oura-connect"></button><button id="oura-disconnect" class="secondary"></button></div><div id="authorization" hidden><label for="authorize-url" id="authorize-label"></label><textarea id="authorize-url" readonly rows="3"></textarea></div></section></div><p id="disconnect-help" class="help"></p></details>
<section class="panel" id="query-panel"><h2 id="query-title" tabindex="-1"></h2><form id="query-form"><div class="dates"><div><label for="category" id="category-label"></label><select id="category"></select></div><div><label for="query-source" id="query-source-label"></label><select id="query-source"></select></div></div><div class="dates"><div><label for="since" id="since-label"></label><input id="since" type="date"></div><div><label for="until" id="until-label"></label><input id="until" type="date"></div></div><label for="metric" id="metric-label"></label><input id="metric" spellcheck="false"><div class="query-actions"><div><label for="limit" id="limit-label"></label><input id="limit" type="number" min="1" max="1000" value="100" required></div><button id="query" class="secondary" type="submit"></button><button id="next-page" class="secondary" type="button" disabled></button></div></form><p id="query-count" class="help"></p><pre id="records" hidden></pre></section><footer></footer>`
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T
const input = (id: string) => el<HTMLInputElement>(id)
const select = (id: string) => el<HTMLSelectElement>(id)
const labels: Record<string, string> = {
  intro: t('汇集 Apple Health、Garmin 和 Oura，按天归档，保留原始记录。', 'Archive Apple Health, Garmin and Oura by day, preserving original records.'),
  'vault-label': t('目标 Vault', 'Destination Vault'), 'catalog-title': t('数据分类', 'Data categories'), status: t('刷新状态', 'Refresh status'),
  'catalog-help': t('选择分类或指标查看原始记录。不同设备的数据分别保留，不累加重复读数。', 'Select a category or metric to browse original records. Device data stays separate; overlapping readings are not added together.'),
  'coverage-title': t('来源覆盖明细', 'Source coverage details'), 'coverage-help': t('已完成表示该日期的采集请求已处理，不代表设备全天佩戴或全天都有读数。无数据返回也可能记为已完成。', 'Completed means collection requests for that date were processed, not continuous wear or all-day readings. An empty response can also count as completed.'), 'acquire-title': t('采集与同步', 'Collect & sync'), 'file-label': t('Apple 健康导出文件', 'Apple Health export file'),
  choose: t('选择文件…', 'Choose file…'), import: t('导入完整快照', 'Import full snapshot'),
  scope: t('请选择同一个人的完整 export.zip 或 export.xml。导入后可补充已连接的设备来源。', 'Choose a complete export.zip or export.xml for the same person, then collect connected provider data.'),
  'sync-source-label': t('采集来源', 'Collection source'), 'sync-since-label': t('起始日期', 'First date'), 'sync-until-label': t('结束日期', 'Last date'),
  'dry-run-label': t('仅预览，不修改归档或采集进度', 'Preview without changing the archive or collection progress'), sync: t('采集并续传', 'Collect & resume'), stop: t('完成本批后停止', 'Stop after this batch'),
  'restart-label': t('重新回查起始日（重建所选期间的采集进度）', 'Recheck from the first date (restart collection progress for this range)'),
  'sync-help': t('每批最多 31 天，自动继续未完成批次。Apple 优先读取上方所选文件；未选时读取上次文件。不会触发 iPhone 自动导出。', 'Process up to 31 days per batch and continue pending batches. Apple reads the selected file, or the last imported file when none is selected. This does not trigger an iPhone export.'),
  'connections-title': t('连接 Garmin / Oura', 'Connect Garmin / Oura'), 'garmin-connect': t('保存并连接', 'Save & connect'), 'oura-connect': t('授权连接', 'Authorize connection'),
  'garmin-region-label': t('账号区域', 'Account region'),
  'garmin-help-prefix': t('获取 Key：', 'Get a key: '), 'garmin-key-cn': t('中国区', 'China'), 'garmin-key-global': t('国际区', 'Global'),
  'garmin-help-suffix': t(' → Create Key（仅显示一次）。', ' → Create Key (shown only once).'),
  'garmin-disconnect': t('断开连接', 'Disconnect'), 'oura-disconnect': t('断开连接', 'Disconnect'),
  'oura-help': t('使用自己的 Oura OAuth 应用。先在开发者门户登记下方完全相同的 Redirect URI；连接时会打开浏览器授权。', 'Use your own Oura OAuth application. Register the exact Redirect URI below in the developer portal. Connecting opens your browser for authorization.'),
  'authorize-label': t('若浏览器未打开，可复制此授权地址', 'Copy this authorization URL if your browser did not open'),
  'disconnect-help': t('凭据存入 Mac 钥匙串。断开连接只移除凭据，不删除已归档数据。', 'Credentials stay in the Mac Keychain. Disconnecting removes credentials and keeps archived data.'),
  'result-title': t('操作结果', 'Result'), 'report-title': t('查看操作明细', 'View operation details'), message: t('选择健康导出或连接设备来源后开始采集。', 'Choose a health export or connect a provider to begin.'),
  'query-title': t('查看原始记录', 'Browse raw records'), 'category-label': t('分类', 'Category'), 'query-source-label': t('来源', 'Source'),
  'since-label': t('起始日期（可选）', 'First date (optional)'), 'until-label': t('结束日期（可选）', 'Last date (optional)'),
  'metric-label': t('指标 / collection（可选）', 'Metric / collection (optional)'), 'limit-label': t('每页条数', 'Page size'), query: t('查询', 'Query'), 'next-page': t('下一页', 'Next page'),
}
for (const [id, text] of Object.entries(labels)) el(id).textContent = text
document.querySelector('h1')!.textContent = title
document.querySelector('footer')!.textContent = t('ZIP/XML 文件需已下载到 Mac。无法直接读取 iCloud 健康数据库。这里呈现采集数据及覆盖情况，不替代设备应用中的统计算法。', 'ZIP/XML files must be downloaded to your Mac. This cannot read the iCloud Health database directly. Records and coverage shown here do not reproduce each device app’s statistics.')
function option(value: string, text: string) { const element = document.createElement('option'); element.value = value; element.textContent = text; return element }
for (const id of ['sync-source', 'query-source']) for (const [value, name] of Object.entries(sources)) select(id).append(option(value, name))
select('category').append(option('', t('所有分类', 'All categories')))
select('garmin-region').append(option('global', t('国际区', 'Global')), option('china', t('中国区', 'China')))
const date = new Date()
input('sync-until').value = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
input('file').placeholder = t('export.zip / 导出.xml / export.xml', 'export.zip / export.xml')
let busy = false, collecting = false, stopRequested = false
let nextOffset: number | null = null
let lastQuery: Json | null = null
let automaticSince = ''
async function request(method: string, params?: unknown): Promise<unknown> {
  if (!window.notemd) throw new Error(t('请从 note.md 插件窗口打开此页面。', 'Open this page from the note.md plugin window.'))
  return window.notemd.request(method, params)
}
function setBusy(value: boolean) {
  busy = value
  for (const control of document.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input, button, select')) control.disabled = value
  el<HTMLButtonElement>('stop').disabled = !collecting || stopRequested
  el<HTMLButtonElement>('next-page').disabled = value || nextOffset === null
  syncControls()
  el('app').setAttribute('aria-busy', String(value))
}
function message(text: string, error = false) {
  el('message').textContent = text; el('message').classList.toggle('error', error)
  if (error && !el('report-details').hidden) el<HTMLDetailsElement>('report-details').open = true
}
function report(value: unknown) { el('report').textContent = JSON.stringify(value, null, 2); el('report').hidden = false; el('report-details').hidden = false }
function clearReport() { el('report').textContent = ''; el('report').hidden = true; el('report-details').hidden = true; el<HTMLDetailsElement>('report-details').open = false }
function clearQuery() {
  nextOffset = null; lastQuery = null
  el<HTMLButtonElement>('next-page').disabled = true
  el('records').textContent = ''; el('records').hidden = true; el('query-count').textContent = ''
}
function clearAuthorization() { el('authorization').hidden = true; el<HTMLTextAreaElement>('authorize-url').value = '' }
async function operation(action: () => Promise<void>, sensitive = false) {
  if (busy) return
  setBusy(true); clearReport(); message(t('正在处理…', 'Processing…'))
  try { await action() } catch (error) {
    message(sensitive ? t('连接失败，请检查凭据和授权设置。', 'Connection failed. Check credentials and authorization settings.') : `${t('操作失败', 'Failed')}: ${error instanceof Error ? error.message : String(error)}`, true)
  } finally { collecting = false; setBusy(false) }
}
function vaultParams() { const vault = input('vault').value.trim(); if (!vault) throw new Error(t('请填写目标 Vault。', 'Enter the destination Vault.')); return { vault } }
function connectionStates(value: unknown) {
  const connections = (value ?? {}) as Record<string, Connection>
  select('garmin-region').value = connections.garmin?.region === 'china' ? 'china' : 'global'
  for (const source of ['garmin', 'oura']) {
    const connection = connections[source] ?? {}
    el(`${source}-state`).textContent = connection.pending ? t('等待浏览器授权…', 'Waiting for browser authorization…') : connection.error ? t('连接异常，请重新授权。', 'Connection needs attention. Authorize again.') : connection.connected ? t('已连接', 'Connected') : t('未连接', 'Not connected')
  }
}
function range(value: { first_day?: string; last_day?: string }) { return value.first_day ? `${value.first_day} → ${value.last_day ?? value.first_day}` : t('无日期记录', 'Undated records') }
function syncControls() {
  const appleOnly = select('sync-source').value === 'apple-health'
  for (const id of ['sync-since', 'sync-until']) { input(id).disabled = busy || appleOnly; input(id).required = !appleOnly }
  input('restart').disabled = busy || appleOnly; input('restart').closest('label')!.hidden = appleOnly
  const preview = input('dry-run').checked
  el('import').textContent = preview ? t('预览所选文件', 'Preview selected file') : labels.import
  el('sync').textContent = preview ? (appleOnly ? t('预览 Apple 快照', 'Preview Apple snapshot') : t('预览采集', 'Preview collection')) : appleOnly ? t('导入 Apple 快照', 'Import Apple snapshot') : labels.sync
  el('sync-help').textContent = appleOnly ? t('读取上方所选完整文件；未选时读取上次文件，不按日期筛选。预览不会保存文件路径。', 'Read the selected complete file, or the last imported file when none is selected, without date filtering. Preview does not save the path.') : labels['sync-help']
}
function renderCoverage(value: SourceCoverage = {}) {
  const container = el('coverage'); container.replaceChildren()
  const table = document.createElement('table'), head = document.createElement('thead'), heading = document.createElement('tr'), body = document.createElement('tbody')
  for (const label of [t('来源', 'Source'), t('集合', 'Collection'), t('日期范围', 'Date range'), t('已完成天数', 'Completed days'), t('不可用天数', 'Unavailable days'), t('失败天数', 'Failed days')]) {
    const cell = document.createElement('th'); cell.scope = 'col'; cell.textContent = label; heading.append(cell)
  }
  head.append(heading)
  const states: Record<string, string> = { complete: t('已完成', 'Completed'), unavailable: t('不可用', 'Unavailable'), failed: t('失败', 'Failed') }
  for (const [source, summary] of Object.entries(value)) for (const [collection, coverage] of Object.entries(summary.collections ?? {})) {
    const row = document.createElement('tr')
    const dates = coverage.first_coverage_day ? `${coverage.first_coverage_day} → ${coverage.last_coverage_day ?? coverage.first_coverage_day}` : t('无日期记录', 'Undated records')
    for (const text of [sources[source] ?? source, collection, dates, ...[coverage.complete_days, coverage.unavailable_days, coverage.failed_days].map(count => (count ?? 0).toLocaleString())]) {
      const cell = document.createElement('td'); cell.textContent = text; row.append(cell)
    }
    if (coverage.undated) {
      const note = document.createElement('small'); note.textContent = `${t('无日期记录', 'Undated records')}: ${states[coverage.undated.status] ?? coverage.undated.status}`
      row.children[1].append(note)
    }
    body.append(row)
  }
  if (!body.childElementCount) { container.textContent = t('尚无来源覆盖记录。导入或采集后会显示各集合的处理情况。', 'No source coverage yet. Import or collect data to see processing status by collection.'); return }
  table.append(head, body); container.append(table)
}
function renderCatalog(value: { categories?: Category[]; sources?: SourceCoverage }) {
  const container = el('catalog'); container.replaceChildren()
  const selected = select('category').value; select('category').replaceChildren(option('', t('所有分类', 'All categories')))
  for (const category of value.categories ?? []) {
    select('category').append(option(category.slug, `${categories[category.slug] ?? category.slug} · ${category.slug}`))
    const card = document.createElement('article'); card.className = 'category-card'
    const heading = document.createElement('button'); heading.className = 'category-heading secondary'; heading.textContent = `${categories[category.slug] ?? category.slug} · ${category.record_count.toLocaleString()}`
    heading.addEventListener('click', () => { select('category').value = category.slug; input('metric').value = ''; select('query-source').value = 'all'; void query() })
    const slug = document.createElement('code'); slug.textContent = category.slug
    const coverage = document.createElement('p'); coverage.className = 'help'; coverage.textContent = range(category)
    const details = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = `${category.metrics.length} ${t('项指标', 'metrics')}`; details.append(summary)
    for (const metric of category.metrics) {
      const button = document.createElement('button'); button.className = 'metric-row secondary'
      const name = document.createElement('span'); name.textContent = metric.metric
      const info = document.createElement('small'); info.textContent = `${sources[metric.source] ?? metric.source} · ${metric.record_count.toLocaleString()} · ${range(metric)}`
      button.append(name, info); button.addEventListener('click', () => { select('category').value = category.slug; input('metric').value = metric.metric; select('query-source').value = metric.source; void query() }); details.append(button)
    }
    card.append(heading, slug, coverage, details); container.append(card)
  }
  if (!container.childElementCount) container.textContent = t('尚无数据。先导入 Apple 健康档案，或采集已连接的来源。', 'No records yet. Import Apple Health or collect a connected provider.')
  select('category').value = selected
  renderCoverage(value.sources)
}
async function refresh() {
  const params = vaultParams()
  const status = await request('plugin.status', params) as { imported?: boolean; manifest?: Json; source_file?: string; connections?: unknown; connections_error?: string }
  const manifest = status.manifest
  el('overview').textContent = manifest ? `${Number(manifest.record_count ?? 0).toLocaleString()} ${t('条记录', 'records')} · ${manifest.day_count ?? 0} ${t('天', 'days')} · ${manifest.attachment_count ?? 0} ${t('个附件', 'attachments')}\n${manifest.first_day ?? '—'} → ${manifest.last_day ?? '—'}` : t('尚未建立健康档案', 'No health archive yet')
  if (!input('sync-since').value || input('sync-since').value === automaticSince) {
    automaticSince = typeof manifest?.first_day === 'string' ? manifest.first_day : '2010-01-01'
    input('sync-since').value = automaticSince
  }
  if (status.source_file && !input('file').value) input('file').value = status.source_file
  connectionStates(status.connections)
  if (status.connections_error) for (const source of ['garmin', 'oura']) el(`${source}-state`).textContent = t('无法读取连接状态', 'Connection status unavailable')
  renderCatalog(await request('plugin.catalog', params) as { categories?: Category[]; sources?: SourceCoverage })
  clearQuery()
  setBusy(busy)
}
async function query(offset = 0) {
  await operation(async () => {
    const params: Json = offset > 0 && lastQuery ? { ...lastQuery, offset } : { ...vaultParams(), limit: Number(input('limit').value), offset: 0 }
    clearQuery()
    if (offset === 0) {
      const since = input('since').value, until = input('until').value
      if (since && until && since > until) throw new Error(t('起始日期不能晚于结束日期。', 'The first date must not be after the last date.'))
      if (!Number.isInteger(params.limit) || Number(params.limit) < 1 || Number(params.limit) > 1000) throw new Error(t('每页条数应为 1–1000 的整数。', 'Page size must be an integer from 1 to 1000.'))
      for (const key of ['since', 'until', 'metric']) if (input(key).value.trim()) params[key] = input(key).value.trim()
      if (select('category').value) params.category = select('category').value
      if (select('query-source').value !== 'all') params.source = select('query-source').value
    }
    lastQuery = { ...params }
    const result = await request('plugin.query', params) as { records?: unknown[]; has_more?: boolean; next_offset?: number }
    nextOffset = result.has_more && typeof result.next_offset === 'number' ? result.next_offset : null
    el('records').textContent = JSON.stringify(result.records ?? [], null, 2); el('records').hidden = false
    const count = result.records?.length ?? 0
    el('query-count').textContent = `${count ? `${offset + 1}–${offset + count}` : t('0 条记录', '0 records')} · ${result.has_more ? t('还有更多记录', 'More records available') : t('本次查询已结束', 'End of results')}`
    message(t('查询完成', 'Query complete'))
    el('query-title').focus(); el('query-title').scrollIntoView?.({ block: 'nearest' })
  })
}
el('query-form').addEventListener('submit', event => { event.preventDefault(); void query() })
el('next-page').addEventListener('click', () => { if (nextOffset !== null) void query(nextOffset) })
for (const id of ['category', 'query-source', 'since', 'until', 'metric', 'limit']) el(id).addEventListener('input', clearQuery)
el('vault').addEventListener('input', () => {
  clearQuery(); clearReport(); clearAuthorization()
  for (const id of ['file', 'sync-since', 'since', 'until', 'metric', 'garmin-key', 'oura-id', 'oura-secret']) input(id).value = ''
  automaticSince = ''; input('restart').checked = false; select('query-source').value = 'all'
  el('overview').textContent = t('请刷新以读取此 Vault。', 'Refresh to load this Vault.')
  renderCatalog({}); connectionStates({})
})
el('vault').addEventListener('change', () => { void operation(async () => { await refresh(); message(t('已切换目标 Vault。', 'Destination Vault updated.')) }) })
el('status').addEventListener('click', () => { void operation(async () => { await refresh(); message(t('状态已刷新', 'Status refreshed')) }) })
el('choose').addEventListener('click', () => { void operation(async () => {
  const result = await request('host.dialog.open', { title: labels['file-label'], multiple: false, filters: [{ name: 'Apple Health', extensions: ['zip', 'xml'] }] }) as { paths: string[] | null }
  if (result.paths?.[0]) input('file').value = result.paths[0]
  message(t('文件已就绪', 'File selection ready'))
}) })
el('import').addEventListener('click', () => { void operation(async () => {
  const file = input('file').value.trim(); if (!file) throw new Error(t('请先选择健康导出文件。', 'Choose a health export file first.'))
  const preview = input('dry-run').checked
  const result = await request('plugin.import', { ...vaultParams(), file, dry_run: preview }) as Json
  report(result); if (!preview) await refresh()
  message(result.complete === false ? t('导入有未完成项，请查看结果。', 'Import has unfinished items. Review the result.') : preview ? t('预览完成，未修改归档。', 'Preview complete; archive unchanged.') : t('Apple 健康快照已导入。', 'Apple Health snapshot imported.'), result.complete === false)
}) })
el('stop').addEventListener('click', () => { stopRequested = true; setBusy(busy); message(t('本批完成后停止，进度将保留。', 'Stopping after this batch; progress will be retained.')) })
el('sync-source').addEventListener('change', syncControls)
el('dry-run').addEventListener('change', syncControls)
el('sync').addEventListener('click', () => { void operation(async () => {
  const source = select('sync-source').value, appleOnly = source === 'apple-health'
  const since = input('sync-since').value, until = input('sync-until').value
  const params = { ...vaultParams(), source, max_days: 31, dry_run: input('dry-run').checked, ...(!appleOnly ? { since, until } : {}) }
  if (!appleOnly && (!since || !until || since > until)) throw new Error(t('请选择有效的采集日期范围。', 'Choose a valid collection date range.'))
  collecting = true; stopRequested = false; setBusy(true)
  const queue = [params.source]
  const cursors = new Map<string, string>()
  let batch = 0, hadWarnings = false
  while (queue.length) {
    const source = queue.shift()!
    message(`${t('正在采集批次', 'Collecting batch')} ${++batch}…`)
    const file = (source === 'all' || source === 'apple-health') ? input('file').value.trim() : ''
    const result = await request('plugin.sync', { ...params, source, ...(file ? { file } : {}), restart: !appleOnly && batch === 1 && input('restart').checked }) as Json
    report(result)
    if (!params.dry_run) await refresh()
    const errors = [result.fatal_errors, result.errors].some(value => Array.isArray(value) && value.length > 0)
    if (errors || result.retry_required) { message(t('本批未完成，已保留进度。请查看结果后重试。', 'This batch is incomplete; progress was retained. Review the result and retry.'), true); break }
    if (params.dry_run) { message(result.complete === false ? t('预览有未完成项，请查看操作明细。', 'Preview has unfinished items. Review the operation details.') : t('预览完成，未修改归档或进度。', 'Preview complete; archive and progress unchanged.'), result.complete === false); break }
    if (appleOnly) { message(result.complete === false ? t('Apple 快照仍有未完成项，请查看操作明细。', 'Apple snapshot has unfinished items. Review the operation details.') : t('Apple 完整快照已导入。', 'The complete Apple snapshot has been imported.'), result.complete === false); break }
    hadWarnings ||= (Array.isArray(result.warnings) && result.warnings.length > 0) || (result.complete === false && !result.pending)
    const pendingSources = Array.isArray(result.sources) ? result.sources.filter(item => item.pending === true && (item.source === 'garmin' || item.source === 'oura')) : []
    let stalled = false
    for (const item of pendingSources) {
      const next = String(item.next_day ?? '')
      if (!next || cursors.get(item.source) === next) { stalled = true; break }
      cursors.set(item.source, next)
      if (!queue.includes(item.source)) queue.push(item.source)
    }
    if (stalled || (result.pending && pendingSources.length === 0)) { message(t('采集游标未前进，已停止。请查看结果后重试。', 'Collection cursor did not advance. Review the result before retrying.'), true); break }
    if (!queue.length) { message(hadWarnings ? t('采集已结束，仍有不可用或未完成项，请查看结果与覆盖明细。', 'Collection finished with unavailable or unfinished items. Review results and coverage.') : t('所选日期范围采集完成。', 'Collection complete for the selected dates.')); break }
    if (stopRequested) { message(t('已停止后续批次；再次采集将续传。', 'Further batches stopped. Collect again to resume.')); break }
  }
}) })
for (const source of ['garmin', 'oura']) {
  el(`${source}-connect`).addEventListener('click', () => { void operation(async () => {
    const params: Json = { ...vaultParams(), source }
    if (source === 'garmin') { params.region = select('garmin-region').value; params.api_key = input('garmin-key').value; input('garmin-key').value = '' }
    else { params.client_id = input('oura-id').value.trim(); params.client_secret = input('oura-secret').value; params.redirect_uri = input('oura-redirect').value.trim(); input('oura-secret').value = '' }
    clearAuthorization()
    try {
      let result: Json
      try { result = await request('plugin.connect', params) as Json } finally { delete params.api_key; delete params.client_secret }
      if (typeof result.authorize_url === 'string') { el<HTMLTextAreaElement>('authorize-url').value = result.authorize_url; el('authorization').hidden = false }
      if (result.pending) {
        message(t('请在浏览器完成 Oura 授权。', 'Complete Oura authorization in your browser.'))
        const deadline = Date.now() + 300_000
        while (true) {
          const connections = await request('plugin.connections', vaultParams()) as Record<string, Connection>
          connectionStates(connections)
          const state = connections[source] ?? {}
          if (state.error) throw new Error('Authorization failed')
          if (!state.pending && state.connected) break
          if (!state.pending || Date.now() >= deadline) throw new Error('Authorization did not complete')
          await new Promise(resolve => window.setTimeout(resolve, 1000))
        }
      }
      await refresh(); message(t('连接成功。可以开始采集。', 'Connected. Ready to collect.'))
    } catch (error) {
      el(`${source}-state`).textContent = t('连接未完成，请检查设置后重试。', 'Connection incomplete. Check settings and retry.')
      throw error
    } finally { clearAuthorization() }
  }, true) })
  el(`${source}-disconnect`).addEventListener('click', () => { void operation(async () => { await request('plugin.disconnect', { ...vaultParams(), source }); await refresh(); message(t('已断开连接，归档数据保留。', 'Disconnected; archived data retained.')) }, true) })
}
void operation(async () => {
  const info = await request('host.vault.info') as { root?: string }
  if (info.root) { input('vault').value = info.root; await refresh() }
  message(labels.message)
})
