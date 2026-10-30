import './style.css'

interface Bridge { locale?: string; request(method: string, params?: unknown): Promise<unknown> }
declare global { interface Window { notemd?: Bridge } }
type Json = Record<string, unknown>
type StorageStatus = { configured: boolean; path?: string; available: boolean; error?: string }
type Account = { id: string; label?: string; region?: string; connected?: boolean; active?: boolean; generation?: string }
type Connection = { connected?: boolean; pending?: boolean; error?: string; region?: string; active_account_id?: string; accounts?: Account[]; authorization_id?: string; completed_account_id?: string }
type CollectionJob = { source: string; account_id?: string; history?: boolean; since?: string; until?: string; restart?: boolean }
type Metric = { metric: string; source: string; record_count: number; first_day?: string; last_day?: string }
type Coverage = { observed_days?: number; complete_days?: number; unavailable_days?: number; failed_days?: number; first_coverage_day?: string | null; last_coverage_day?: string | null; undated?: { status: string } | null }
type SourceCoverage = Record<string, { collections?: Record<string, Coverage>; accounts?: Record<string, { collections?: Record<string, Coverage> }> }>
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
const providers = ['garmin', 'oura'] as const
const sources: Record<string, string> = { all: t('所有来源', 'All sources'), 'apple-health': 'Apple Health', garmin: 'Garmin', oura: 'Oura' }
document.documentElement.lang = zh ? 'zh-CN' : 'en'
document.title = title
// Only static markup enters innerHTML. Provider data always uses textContent.
document.querySelector('#app')!.innerHTML = `
<div id="import-progress" hidden><p id="import-progress-label" role="status"></p><progress aria-labelledby="import-progress-label"></progress></div>
<header><p class="eyebrow">APPLE HEALTH · GARMIN · OURA</p><h1></h1><p id="intro"></p></header>
<section class="panel" id="storage-panel"><h2 id="storage-title"></h2><p id="storage-help" class="help"></p><label for="storage-path" id="storage-path-label"></label><input id="storage-path" readonly aria-describedby="storage-help storage-state"><p id="storage-state" role="status"></p><div class="actions"><button id="storage-choose"></button><button id="storage-check" class="secondary"></button></div><p id="storage-change-help" class="help"></p><label for="vault" id="vault-label"></label><input id="vault" readonly><div id="overview" class="overview"></div></section>
<section><div class="section-heading"><h2 id="catalog-title"></h2><button id="status" class="secondary"></button></div><p id="catalog-help" class="help"></p><div id="catalog" class="catalog"></div><details><summary id="coverage-title"></summary><p id="coverage-help" class="help"></p><div id="coverage" class="coverage"></div></details></section>
<section class="panel" id="apple-panel"><h2 id="acquire-title"></h2><label for="file" id="file-label"></label><div class="file-row"><input id="file" autocomplete="off" spellcheck="false"><button id="choose" class="secondary"></button><button id="import" class="secondary"></button></div><p id="scope" class="help"></p>
<label class="check"><input id="apple-dry-run" type="checkbox"><span id="apple-dry-run-label"></span></label></section>
<section id="api-sync-template"><label id="sync-source-label" for="sync-source"></label><select id="sync-source"></select>
<label class="check"><input id="dry-run" type="checkbox"><span id="dry-run-label"></span></label><div class="actions"><button id="sync"></button><button id="stop" class="secondary" disabled></button></div><p id="sync-help" class="help"></p></section>
<section class="panel" id="history-panel"><h2 id="history-title"></h2><p id="history-help" class="help"></p><div class="dates"><div><label id="history-source-label" for="history-source"></label><select id="history-source"></select></div><div><label id="history-account-label" for="history-account"></label><select id="history-account"></select></div></div><div class="dates"><div><label id="history-since-label" for="history-since"></label><input id="history-since" type="date" required></div><div><label id="history-until-label" for="history-until"></label><input id="history-until" type="date" required></div></div><label class="check"><input id="restart" type="checkbox"><span id="restart-label"></span></label><div class="actions"><button id="history-import" class="secondary"></button><button id="history-stop" class="secondary" disabled></button></div></section>
<details class="panel" id="garmin-zip-panel"><summary id="garmin-zip-title"></summary><p id="garmin-zip-help" class="help"></p><label for="garmin-zip-file" id="garmin-zip-file-label"></label><div class="file-row"><input id="garmin-zip-file" autocomplete="off" spellcheck="false"><button id="garmin-zip-choose" class="secondary"></button></div><label for="garmin-zip-region" id="garmin-zip-region-label"></label><select id="garmin-zip-region"></select><div class="actions"><button id="garmin-zip-preview" class="secondary"></button><button id="garmin-zip-import"></button></div></details>
<details class="panel" id="oura-file-panel"><summary id="oura-file-title"></summary><p id="oura-file-help" class="help"></p><label for="oura-file" id="oura-file-label"></label><div class="file-row"><input id="oura-file" autocomplete="off" spellcheck="false"><button id="oura-file-choose" class="secondary"></button></div><label for="oura-file-account" id="oura-file-account-label"></label><select id="oura-file-account"></select><div id="oura-profile-fields" hidden><label for="oura-profile" id="oura-profile-label"></label><input id="oura-profile" autocomplete="off"><p id="oura-profile-help" class="help"></p></div><div class="actions"><button id="oura-file-preview" class="secondary"></button><button id="oura-file-import"></button></div></details>
<section class="result"><h2 id="result-title"></h2><p id="message" role="status" aria-live="polite"></p><details id="report-details" hidden><summary id="report-title"></summary><pre id="report" hidden></pre></details></section>
<details class="panel" id="connections-panel"><summary id="connections-title"></summary>
<div class="connections"><section><h3>Garmin</h3><p id="garmin-state" role="status"></p><label id="garmin-account-label" for="garmin-account"></label><select id="garmin-account"></select><div class="actions"><button id="garmin-select" class="secondary"></button><button id="garmin-disconnect" class="secondary"></button></div><details class="add-account"><summary id="garmin-add-title"></summary><label id="garmin-label-label" for="garmin-label"></label><input id="garmin-label" autocomplete="off"><label id="garmin-region-label" for="garmin-region"></label><select id="garmin-region"></select><label for="garmin-key">Personal API key</label><input id="garmin-key" type="password" autocomplete="off" aria-describedby="garmin-help"><p id="garmin-help" class="help"><span id="garmin-help-prefix"></span><a id="garmin-key-cn" href="https://connect.garmin.cn/app/settings/personalApiToken" target="_blank" rel="noopener noreferrer"></a> / <a id="garmin-key-global" href="https://connect.garmin.com/app/settings/personalApiToken" target="_blank" rel="noopener noreferrer"></a><span id="garmin-help-suffix"></span></p><div class="actions"><button id="garmin-connect"></button></div></details></section>
<section><h3>Oura</h3><p id="oura-state" role="status"></p><button id="oura-cancel" class="secondary" hidden></button><label id="oura-account-label" for="oura-account"></label><select id="oura-account"></select><div class="actions"><button id="oura-select" class="secondary"></button><button id="oura-disconnect" class="secondary"></button></div><details class="add-account"><summary id="oura-add-title"></summary><label id="oura-label-label" for="oura-label"></label><input id="oura-label" autocomplete="off"><p id="oura-help" class="help"></p><label for="oura-id">Client ID</label><input id="oura-id" autocomplete="off" spellcheck="false"><label for="oura-secret">Client secret</label><input id="oura-secret" type="password" autocomplete="off"><label for="oura-redirect">Redirect URI</label><input id="oura-redirect" value="http://localhost:8765/callback" spellcheck="false"><div class="actions"><button id="oura-connect"></button></div><div id="authorization" hidden><label for="authorize-url" id="authorize-label"></label><textarea id="authorize-url" readonly rows="3"></textarea></div></details></section></div><p id="disconnect-help" class="help"></p></details>
<section class="panel" id="query-panel"><h2 id="query-title" tabindex="-1"></h2><form id="query-form"><div class="dates"><div><label for="category" id="category-label"></label><select id="category"></select></div><div><label for="query-source" id="query-source-label"></label><select id="query-source"></select></div><div><label for="query-account" id="query-account-label"></label><select id="query-account"></select></div></div><div class="dates"><div><label for="since" id="since-label"></label><input id="since" type="date"></div><div><label for="until" id="until-label"></label><input id="until" type="date"></div></div><label for="metric" id="metric-label"></label><input id="metric" spellcheck="false"><div class="query-actions"><div><label for="limit" id="limit-label"></label><input id="limit" type="number" min="1" max="1000" value="100" required></div><button id="query" class="secondary" type="submit"></button><button id="next-page" class="secondary" type="button" disabled></button></div></form><p id="query-count" class="help"></p><pre id="records" hidden></pre></section><footer></footer>`
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T
const input = (id: string) => el<HTMLInputElement>(id)
const select = (id: string) => el<HTMLSelectElement>(id)
// Keep progress announcements outside the busy controls' accessibility subtree.
el('app').after(el('import-progress'))
const labels: Record<string, string> = {
  intro: t('在独立资料库保存 Apple Health、Garmin 和 Oura，查看当前数据情况。', 'Keep Apple Health, Garmin and Oura in a separate library and review current data coverage.'),
  'storage-title': t('健康原始资料库', 'Health data library'),
  'storage-help': t('首次使用请选择 Vault 之外的文件夹。原始明细存入 SQLite，附件保存为文件；禁止使用 Vault 或其子目录，避免大量数据影响笔记同步。Vault 仅存放以后由程序和 Agent 分析完成的报告，此处默认只显示数据情况。', 'Choose a folder outside your Vault on first use. Raw records are stored in SQLite and attachments as files. The Vault and its subfolders are not allowed, to keep bulk data out of note sync. The Vault is reserved for final program and Agent analysis reports; this view only shows current data coverage.'),
  'storage-path-label': t('资料库位置', 'Library location'), 'storage-choose': t('选择资料库文件夹…', 'Choose library folder…'), 'storage-check': t('重新检查', 'Check again'),
  'storage-change-help': t('更换仅切换资料库，不移动数据。外接盘离线时请重新连接，不会自动改存到 Vault。', 'Changing location switches libraries without moving data. Reconnect an offline drive; data never falls back to the Vault.'),
  'vault-label': t('关联 Vault（仅用于分析报告）', 'Associated Vault (analysis reports only)'), 'catalog-title': t('数据分类', 'Data categories'), status: t('刷新状态', 'Refresh status'),
  'catalog-help': t('选择分类或指标查看原始记录。不同设备的数据分别保留，不累加重复读数。', 'Select a category or metric to browse original records. Device data stays separate; overlapping readings are not added together.'),
  'coverage-title': t('来源覆盖明细', 'Source coverage details'), 'coverage-help': t('已完成表示该日期的采集请求已处理，不代表设备全天佩戴或全天都有读数。无数据返回也可能记为已完成。ZIP 的“导出中有记录”仅表示包中观察到记录，不代表完整日期或 API 覆盖。', 'Completed means collection requests for that date were processed, not continuous wear or all-day readings. An empty response can also count as completed. ZIP observations only indicate records present in the export and do not establish complete dates or API coverage.'), 'acquire-title': 'Apple Health', 'file-label': t('Apple 健康导出文件', 'Apple Health export file'),
  choose: t('选择文件…', 'Choose file…'), import: t('增量导入文件', 'Import file incrementally'),
  scope: t('选择同一个人的 Apple 健康导出 ZIP 或 XML，增量合并记录，保留已有数据。Apple 仅通过文件导入。', 'Choose an Apple Health export ZIP or XML for the same person. Records are merged incrementally and existing data is retained. Apple is imported from files only.'),
  'sync-source-label': t('采集来源', 'Collection source'),
  'apple-dry-run-label': t('仅预览，不修改资料库', 'Preview without changing the library'),
  'dry-run-label': t('仅预览，不修改归档或采集进度', 'Preview without changing the archive or collection progress'), sync: t('同步当前账号', 'Sync current accounts'), stop: t('完成本批后停止', 'Stop after this batch'),
  'restart-label': t('重新回查起始日（重建所选期间的采集进度）', 'Recheck from the first date (restart collection progress for this range)'),
  'sync-help': t('通过 API 同步 Garmin 和 Oura 当前账号，默认最近 14 天；已有同步进度会继续。其他历史请用下方导入。', 'Sync current Garmin and Oura accounts through their APIs: start with the last 14 days, or resume existing progress. Use history import below for other dates.'),
  'connections-title': t('Garmin / Oura 账号', 'Garmin / Oura accounts'), 'garmin-connect': t('保存并连接', 'Save & connect'), 'oura-connect': t('授权连接', 'Authorize connection'),
  'garmin-region-label': t('账号区域', 'Account region'),
  'garmin-help-prefix': t('获取 Key：', 'Get a key: '), 'garmin-key-cn': t('中国区', 'China'), 'garmin-key-global': t('国际区', 'Global'),
  'garmin-help-suffix': t(' → Create Key（仅显示一次）。', ' → Create Key (shown only once).'),
  'garmin-disconnect': t('断开所选账号', 'Disconnect selected'), 'oura-disconnect': t('断开所选账号', 'Disconnect selected'),
  'history-title': t('Garmin / Oura 历史导入', 'Garmin / Oura history import'), 'history-help': t('选择已保存账号和日期，补齐历史；不会切换当前同步账号。预览选项同上。', 'Choose a saved account and dates to import history without changing the current sync account. The preview option above also applies.'),
  'history-source-label': t('来源', 'Source'), 'history-account-label': t('历史账号', 'History account'), 'history-since-label': t('起始日期', 'First date'), 'history-until-label': t('结束日期', 'Last date'), 'history-import': t('导入历史并续传', 'Import history & resume'), 'history-stop': t('完成本批后停止', 'Stop after this batch'),
  'garmin-zip-title': t('导入 Garmin 导出 ZIP', 'Import Garmin export ZIP'),
  'garmin-zip-help': t('选择官网导出 ZIP 和账号区域，无需 API Key。自动识别文件账号，分别保留数据；不切换当前同步账号。', 'Choose an official export ZIP and its account region. No API key is needed. The file account is identified automatically and archived separately; the current sync account stays unchanged.'),
  'garmin-zip-file-label': t('Garmin 导出 ZIP', 'Garmin export ZIP'), 'garmin-zip-region-label': t('导出账号区域', 'Export account region'),
  'garmin-zip-choose': t('选择文件…', 'Choose file…'), 'garmin-zip-preview': t('预览 ZIP', 'Preview ZIP'), 'garmin-zip-import': t('导入 ZIP', 'Import ZIP'),
  'oura-file-title': t('导入 Oura 导出文件', 'Import Oura export file'),
  'oura-file-help': t('支持 CSV、JSON 或包含这些文件的 ZIP，按 Oura 字段识别。请明确选择数据所属账号；不同账号分别保存，不切换当前 API 账号。未识别的文件会说明原因。', 'Supports CSV, JSON, or ZIP containing these files, recognized by Oura fields. Explicitly choose the account this data belongs to. Accounts stay separate and the current API account is unchanged. Unrecognized files report a reason.'),
  'oura-file-label': t('Oura 导出文件', 'Oura export file'), 'oura-file-choose': t('选择文件…', 'Choose file…'),
  'oura-file-account-label': t('数据所属账号', 'Data account'), 'oura-profile-label': t('离线账号名称', 'Offline account name'),
  'oura-profile-help': t('同一账号每次使用相同名称，不同账号使用不同名称。此身份独立于 API 账号。', 'Reuse the same name for exports from the same account, and a different name for each account. This identity is separate from API accounts.'),
  'oura-file-preview': t('预览文件', 'Preview file'), 'oura-file-import': t('增量导入文件', 'Import file incrementally'),
  'oura-cancel': t('取消授权', 'Cancel authorization'),
  'oura-help': t('使用自己的 Oura OAuth 应用。先在开发者门户登记下方完全相同的 Redirect URI；HTTP 回调请用 localhost，不能填 127.0.0.1。', 'Use your own Oura OAuth application. Register the exact Redirect URI below in the developer portal. For HTTP callbacks, use localhost, not 127.0.0.1.'),
  'authorize-label': t('若浏览器未打开，可复制此授权地址', 'Copy this authorization URL if your browser did not open'),
  'disconnect-help': t('凭据存入 Mac 钥匙串。每个来源只设一个当前同步账号；其他账号可导入历史。断开只移除凭据，保留归档。', 'Credentials stay in the Mac Keychain. Each provider has one current sync account; other accounts can import history. Disconnecting removes credentials and keeps the archive.'),
  'result-title': t('操作结果', 'Result'), 'report-title': t('查看操作明细', 'View operation details'), message: t('选择健康导出或连接设备来源后开始采集。', 'Choose a health export or connect a provider to begin.'),
  'query-account-label': t('账号（可选）', 'Account (optional)'), 'query-title': t('查看原始记录', 'Browse raw records'), 'category-label': t('分类', 'Category'), 'query-source-label': t('来源', 'Source'),
  'since-label': t('起始日期（可选）', 'First date (optional)'), 'until-label': t('结束日期（可选）', 'Last date (optional)'),
  'metric-label': t('指标 / collection（可选）', 'Metric / collection (optional)'), 'limit-label': t('每页条数', 'Page size'), query: t('查询', 'Query'), 'next-page': t('下一页', 'Next page'),
}
for (const provider of ['garmin', 'oura']) Object.assign(labels, { [`${provider}-account-label`]: t('已保存账号', 'Saved accounts'), [`${provider}-select`]: t('设为当前', 'Set as current'), [`${provider}-add-title`]: t('添加 / 重新授权账号', 'Add / reauthorize an account'), [`${provider}-label-label`]: t('账号备注（可选）', 'Account label (optional)') })
for (const [id, text] of Object.entries(labels)) el(id).textContent = text
// Build fixed provider sections once; their forms never move during use.
function sourceForm(template: HTMLElement, source: string) {
  const form = template.cloneNode(true) as HTMLElement
  const ids = new Map<string, string>()
  for (const element of [form, ...form.querySelectorAll<HTMLElement>('[id]')]) if (element.id) {
    ids.set(element.id, `${source}-${element.id}`); element.id = `${source}-${element.id}`
  }
  for (const label of form.querySelectorAll<HTMLLabelElement>('label[for]')) label.htmlFor = ids.get(label.htmlFor) ?? label.htmlFor
  return form
}
const accountSections = [...document.querySelectorAll<HTMLElement>('.connections > section')]
for (const [index, source] of providers.entries()) {
  const section = document.createElement('section'); section.id = `${source}-panel`; section.className = 'panel provider-panel'
  const heading = document.createElement('h2'); heading.textContent = sources[source]; section.append(heading)
  const accounts = accountSections[index]; accounts.id = `${source}-account-settings`
  accounts.querySelector('h3')!.textContent = t('账号', 'Accounts')
  const help = el('disconnect-help').cloneNode(true) as HTMLElement; help.id = `${source}-disconnect-help`; accounts.append(help)
  section.append(accounts, el(source === 'garmin' ? 'garmin-zip-panel' : 'oura-file-panel'))
  const sync = sourceForm(el('api-sync-template'), source); sync.id = `${source}-sync-panel`
  sync.querySelector(`#${source}-sync-source-label`)!.remove(); sync.querySelector(`#${source}-sync-source`)!.remove()
  const syncTitle = document.createElement('h3'); syncTitle.textContent = t('API 增量同步', 'Incremental API sync'); sync.prepend(syncTitle)
  sync.querySelector(`#${source}-sync-help`)!.textContent = t('同步本来源的当前账号，默认最近 14 天；已有同步进度会继续。', 'Sync this provider’s current account: start with the last 14 days, or resume existing progress.')
  const history = sourceForm(el('history-panel'), source); history.classList.remove('panel')
  history.querySelector(`#${source}-history-source`)!.parentElement!.remove()
  const historyTitle = document.createElement('h3'); historyTitle.id = `${source}-history-title`; historyTitle.textContent = t('历史导入', 'History import')
  history.querySelector(`#${source}-history-title`)!.replaceWith(historyTitle)
  section.append(sync, history)
  document.querySelector('.result')!.before(section)
}
el('api-sync-template').remove(); el('history-panel').remove(); el('connections-panel').remove()
document.querySelector('h1')!.textContent = title
document.querySelector('footer')!.textContent = t('ZIP/XML 文件需已下载到 Mac。无法直接读取 iCloud 健康数据库。这里呈现采集数据及覆盖情况，不替代设备应用中的统计算法。', 'ZIP/XML files must be downloaded to your Mac. This cannot read the iCloud Health database directly. Records and coverage shown here do not reproduce each device app’s statistics.')
function option(value: string, text: string) { const element = document.createElement('option'); element.value = value; element.textContent = text; return element }
for (const [value, name] of Object.entries(sources)) select('query-source').append(option(value, name))
select('category').append(option('', t('所有分类', 'All categories')))
select('garmin-region').append(option('global', t('国际区', 'Global')), option('china', t('中国区', 'China')))
select('garmin-zip-region').append(option('', t('请选择区域…', 'Choose a region…')), option('china', t('中国区', 'China')), option('global', t('国际区', 'Global')))
function localDate(date: Date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` }
for (const source of providers) input(`${source}-history-until`).value = localDate(new Date())
input('file').placeholder = t('export.zip / 导出.xml / export.xml', 'export.zip / export.xml')
let busy = false, collecting = false, stopRequested = false
let collectingSource: string | null = null
let storageReady = false, associatedVault = ''
let nextOffset: number | null = null
let lastQuery: Json | null = null
let automaticSince: Record<string, string> = {}
let connections: Record<string, Connection> = {}
let archiveSources: SourceCoverage = {}
let authorizationAttempt: { source: string; vault: string; id: string; cancelled: boolean } | null = null
let cancellingAuthorization = false
async function request(method: string, params?: unknown): Promise<unknown> {
  if (!window.notemd) throw new Error(t('请从 note.md 插件窗口打开此页面。', 'Open this page from the note.md plugin window.'))
  return window.notemd.request(method, params)
}
function setBusy(value: boolean) {
  busy = value
  for (const control of document.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input, button, select')) control.disabled = value || !storageReady
  for (const source of providers) for (const action of ['stop', 'history-stop']) el<HTMLButtonElement>(`${source}-${action}`).disabled = !collecting || collectingSource !== source || stopRequested
  el<HTMLButtonElement>('next-page').disabled = value || !storageReady || nextOffset === null
  syncControls(); accountControls(); queryAccounts(); cancellationControls()
  for (const id of ['storage-choose', 'storage-check']) el<HTMLButtonElement>(id).disabled = value || !associatedVault
  input('vault').disabled = false; input('storage-path').disabled = false
  el('app').setAttribute('aria-busy', String(value))
}
function message(text: string, error = false) {
  el('import-progress-label').textContent = text
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
async function operation(action: () => Promise<void>, { sensitive = false, progress = false, setup = false }: { sensitive?: boolean; progress?: boolean; setup?: boolean } = {}) {
  if (busy || (!setup && !storageReady)) return
  setBusy(true); clearReport(); message(t('正在处理…', 'Processing…'))
  // One timer spans the whole import, including batches and catalog refreshes.
  const progressTimer = progress ? window.setTimeout(() => { el('import-progress').hidden = false }, 3000) : undefined
  try { await action() } catch (error) {
    message(sensitive ? t('连接失败，请检查凭据和授权设置。', 'Connection failed. Check credentials and authorization settings.') : `${t('操作失败', 'Failed')}: ${error instanceof Error ? error.message : String(error)}`, true)
  } finally {
    window.clearTimeout(progressTimer); el('import-progress').hidden = true
    collecting = false; collectingSource = null; setBusy(false)
  }
}
function vaultParams() { if (!associatedVault) throw new Error(t('请先在 note.md 打开 Vault。', 'Open a Vault in note.md first.')); return { vault: associatedVault } }
function accountName(account: Account) {
  const region = account.region === 'china' ? t('中国区', 'China') : account.region === 'global' ? t('国际区', 'Global') : ''
  return `${account.label || `${t('账号', 'Account')} ${account.id.slice(0, 8)}`}${region ? ` · ${region}` : ''}`
}
function accountControls() {
  for (const source of ['garmin', 'oura']) {
    const account = connections[source]?.accounts?.find(item => item.id === select(`${source}-account`).value)
    el<HTMLButtonElement>(`${source}-select`).disabled = busy || !storageReady || !account?.connected || account.id === connections[source]?.active_account_id
    el<HTMLButtonElement>(`${source}-disconnect`).disabled = busy || !storageReady || !account?.connected
  }
  for (const source of providers) el<HTMLButtonElement>(`${source}-history-import`).disabled = busy || !storageReady || !select(`${source}-history-account`).value
}
function historyAccounts() {
  for (const source of providers) {
    const list = select(`${source}-history-account`), previous = list.value
    list.replaceChildren()
    for (const account of connections[source]?.accounts ?? []) if (account.connected) list.append(option(account.id, accountName(account)))
    if (!list.options.length) list.append(option('', t('请先连接账号', 'Connect an account first')))
    else if ([...list.options].some(item => item.value === previous)) list.value = previous
  }
  accountControls()
}
function connectionStates(value: unknown) {
  connections = (value ?? {}) as Record<string, Connection>
  for (const source of ['garmin', 'oura']) {
    const connection = connections[source] ?? {}, accounts = connection.accounts ?? []
    const list = select(`${source}-account`), previous = list.value
    list.replaceChildren(...accounts.map(account => option(account.id, `${accountName(account)}${account.id === connection.active_account_id ? t(' · 当前', ' · Current') : ''}${!account.connected ? t(' · 已断开', ' · Disconnected') : ''}`)))
    if (!accounts.length) list.append(option('', t('尚无账号', 'No saved accounts')))
    else list.value = accounts.some(account => account.id === previous) ? previous : connection.active_account_id ?? accounts[0].id
    const current = accounts.find(account => account.id === connection.active_account_id)
    el(`${source}-state`).textContent = connection.pending ? t('等待浏览器授权…', 'Waiting for browser authorization…') : connection.error ? t('连接异常，请重新授权。', 'Connection needs attention. Authorize again.') : current ? `${t('当前：', 'Current: ')}${accountName(current)}${!current.connected ? t('（已断开）', ' (disconnected)') : ''}` : t('未设置当前账号', 'No current account')
  }
  historyAccounts(); queryAccounts(); ouraExportAccounts(); cancellationControls()
}
function cancellationTarget() {
  if (authorizationAttempt && !authorizationAttempt.cancelled) return authorizationAttempt
  const state = connections.oura
  return state?.pending && state.authorization_id ? { source: 'oura', vault: input('vault').value.trim(), id: state.authorization_id, cancelled: false } : null
}
function cancellationControls() {
  const target = cancellationTarget(), button = el<HTMLButtonElement>('oura-cancel')
  button.hidden = !target; button.disabled = !target || cancellingAuthorization || (busy && !authorizationAttempt)
}
function queryAccounts() {
  const source = select('query-source').value, list = select('query-account'), previous = list.value
  const known = connections[source]?.accounts ?? []
  const ids = new Set([...known.map(account => account.id), ...Object.keys(archiveSources[source]?.accounts ?? {})])
  list.replaceChildren(option('', t('所有账号', 'All accounts')))
  for (const id of ids) list.append(option(id, accountName(known.find(account => account.id === id) ?? { id })))
  if (ids.has(previous)) list.value = previous
  list.disabled = busy || !storageReady || ids.size === 0
}
function ouraExportAccounts() {
  const list = select('oura-file-account'), previous = list.value
  const known = connections.oura?.accounts ?? []
  const ids = new Set([...known.map(account => account.id), ...Object.keys(archiveSources.oura?.accounts ?? {})])
  list.replaceChildren(option('', t('请选择账号…', 'Choose an account…')), option('__offline__', t('独立离线账号…', 'Separate offline account…')))
  for (const id of ids) list.append(option(id, accountName(known.find(account => account.id === id) ?? { id })))
  if (previous === '__offline__' || ids.has(previous)) list.value = previous
  el('oura-profile-fields').hidden = list.value !== '__offline__'
}
function range(value: { first_day?: string; last_day?: string }) { return value.first_day ? `${value.first_day} → ${value.last_day ?? value.first_day}` : t('无日期记录', 'Undated records') }
function syncControls() {
  el('import').textContent = input('apple-dry-run').checked ? t('预览所选文件', 'Preview selected file') : labels.import
  for (const source of providers) {
    const preview = input(`${source}-dry-run`).checked
    el(`${source}-sync`).textContent = preview ? t('预览采集', 'Preview collection') : labels.sync
    el(`${source}-history-import`).textContent = preview ? t('预览历史导入', 'Preview history import') : labels['history-import']
  }
}
function renderCoverage(value: SourceCoverage = {}) {
  const container = el('coverage'); container.replaceChildren()
  const table = document.createElement('table'), head = document.createElement('thead'), heading = document.createElement('tr'), body = document.createElement('tbody')
  for (const label of [t('来源', 'Source'), t('集合', 'Collection'), t('日期范围', 'Date range'), t('已完成天数', 'Completed days'), t('不可用天数', 'Unavailable days'), t('失败天数', 'Failed days'), t('导出中有记录（天）', 'Days observed in export')]) {
    const cell = document.createElement('th'); cell.scope = 'col'; cell.textContent = label; heading.append(cell)
  }
  head.append(heading)
  const states: Record<string, string> = { complete: t('已完成', 'Completed'), unavailable: t('不可用', 'Unavailable'), failed: t('失败', 'Failed'), observed: t('导出中有记录', 'Observed in export') }
  for (const [source, summary] of Object.entries(value)) {
    const accounts = summary.accounts && Object.keys(summary.accounts).length ? Object.entries(summary.accounts) : [['', summary] as const]
    for (const [id, account] of accounts) for (const [collection, coverage] of Object.entries(account.collections ?? {})) {
      const row = document.createElement('tr')
      const dates = coverage.first_coverage_day ? `${coverage.first_coverage_day} → ${coverage.last_coverage_day ?? coverage.first_coverage_day}` : t('无日期记录', 'Undated records')
      const name = `${sources[source] ?? source}${id ? ` · ${accountName(connections[source]?.accounts?.find(item => item.id === id) ?? { id })}` : ''}`
      for (const text of [name, collection, dates, ...[coverage.complete_days, coverage.unavailable_days, coverage.failed_days, coverage.observed_days].map(count => (count ?? 0).toLocaleString())]) {
        const cell = document.createElement('td'); cell.textContent = text; row.append(cell)
      }
      if (coverage.undated) {
        const note = document.createElement('small'); note.textContent = `${t('无日期记录', 'Undated records')}: ${states[coverage.undated.status] ?? coverage.undated.status}`
        row.children[1].append(note)
      }
      body.append(row)
    }
  }
  if (!body.childElementCount) { container.textContent = t('尚无来源覆盖记录。导入或采集后会显示各集合的处理情况。', 'No source coverage yet. Import or collect data to see processing status by collection.'); return }
  table.append(head, body); container.append(table)
}
function renderCatalog(value: { categories?: Category[]; sources?: SourceCoverage }) {
  archiveSources = value.sources ?? {}; queryAccounts(); ouraExportAccounts()
  const container = el('catalog'); container.replaceChildren()
  const selected = select('category').value; select('category').replaceChildren(option('', t('所有分类', 'All categories')))
  for (const category of value.categories ?? []) {
    select('category').append(option(category.slug, `${categories[category.slug] ?? category.slug} · ${category.slug}`))
    const card = document.createElement('article'); card.className = 'category-card'
    const heading = document.createElement('button'); heading.className = 'category-heading secondary'; heading.textContent = `${categories[category.slug] ?? category.slug} · ${category.record_count.toLocaleString()}`
    heading.addEventListener('click', () => { select('category').value = category.slug; input('metric').value = ''; select('query-source').value = 'all'; queryAccounts(); void query() })
    const slug = document.createElement('code'); slug.textContent = category.slug
    const coverage = document.createElement('p'); coverage.className = 'help'; coverage.textContent = range(category)
    const details = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = `${category.metrics.length} ${t('项指标', 'metrics')}`; details.append(summary)
    for (const metric of category.metrics) {
      const button = document.createElement('button'); button.className = 'metric-row secondary'
      const name = document.createElement('span'); name.textContent = metric.metric
      const info = document.createElement('small'); info.textContent = `${sources[metric.source] ?? metric.source} · ${metric.record_count.toLocaleString()} · ${range(metric)}`
      button.append(name, info); button.addEventListener('click', () => { select('category').value = category.slug; input('metric').value = metric.metric; select('query-source').value = metric.source; queryAccounts(); void query() }); details.append(button)
    }
    card.append(heading, slug, coverage, details); container.append(card)
  }
  if (!container.childElementCount) container.textContent = t('尚无数据。先导入 Apple 健康档案，或采集已连接的来源。', 'No records yet. Import Apple Health or collect a connected provider.')
  select('category').value = selected
  renderCoverage(value.sources)
}
async function refresh() {
  const params = vaultParams()
  const status = await request('plugin.status', params) as { imported?: boolean; summary?: Json; source_file?: string; connections?: unknown; connections_error?: string }
  const summary = status.summary
  el('overview').textContent = summary ? `${Number(summary.record_count ?? 0).toLocaleString()} ${t('条记录', 'records')} · ${summary.day_count ?? 0} ${t('天', 'days')} · ${summary.attachment_count ?? 0} ${t('个附件', 'attachments')}\n${summary.first_day ?? '—'} → ${summary.last_day ?? '—'}` : t('尚未建立健康档案', 'No health archive yet')
  for (const source of providers) {
    const since = input(`${source}-history-since`)
    if (!since.value || since.value === automaticSince[source]) {
      automaticSince[source] = typeof summary?.first_day === 'string' ? summary.first_day : '2010-01-01'
      since.value = automaticSince[source]
    }
  }
  const rememberedSource = status.source_file ?? ''
  if (rememberedSource && !input('file').value) input('file').value = rememberedSource
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
      if (select('query-account').value) params.account_id = select('query-account').value
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
for (const id of ['category', 'query-source', 'query-account', 'since', 'until', 'metric', 'limit']) el(id).addEventListener('input', clearQuery)
el('query-source').addEventListener('change', () => { select('query-account').value = ''; queryAccounts(); clearQuery() })
function clearLibraryView() {
  clearQuery(); clearReport(); clearAuthorization()
  for (const id of ['file', 'garmin-zip-file', 'oura-file', 'oura-profile', 'since', 'until', 'metric', 'garmin-key', 'garmin-label', 'oura-label', 'oura-id', 'oura-secret']) input(id).value = ''
  select('oura-file-account').value = ''
  automaticSince = {}; select('garmin-zip-region').value = ''; select('garmin-region').value = 'global'; select('query-source').value = 'all'
  for (const source of providers) { input(`${source}-history-since`).value = ''; input(`${source}-restart`).checked = false; select(`${source}-history-account`).replaceChildren() }
  el('overview').textContent = ''
  renderCatalog({}); connectionStates({})
}
async function checkStorage() {
  storageReady = false; setBusy(busy)
  let state: StorageStatus
  try { state = await request('plugin.storage_status', vaultParams()) as StorageStatus }
  catch (error) {
    clearLibraryView()
    el('storage-state').textContent = t('无法访问资料库。请连接原磁盘后重新检查，或选择资料库文件夹。', 'Library unavailable. Reconnect its drive and check again, or choose a library folder.')
    el('storage-state').classList.add('error')
    throw error
  }
  input('storage-path').value = state.path ?? ''
  storageReady = state.configured && state.available === true
  const unavailable = state.configured && !storageReady
  el('storage-state').classList.toggle('error', unavailable)
  el('storage-state').textContent = storageReady ? t('资料库已就绪。', 'Library ready.') : unavailable ? `${t('资料库不可用，请连接原磁盘后重新检查。', 'Library unavailable. Reconnect its drive and check again.')}${state.error ? ` ${state.error}` : ''}` : t('请先选择 Vault 之外的健康资料库文件夹。', 'Choose a health library folder outside your Vault to begin.')
  el('storage-choose').textContent = state.configured ? t('更换资料库文件夹…', 'Change library folder…') : labels['storage-choose']
  if (!storageReady) clearLibraryView()
  setBusy(busy)
  return storageReady
}
async function reloadLibrary() {
  if (await checkStorage()) { await refresh(); message(t('状态已刷新', 'Status refreshed')) }
  else message(el('storage-state').textContent ?? '', el('storage-state').classList.contains('error'))
}
el('storage-choose').addEventListener('click', () => { void operation(async () => {
  const result = await request('host.dialog.open', { title: labels['storage-choose'], directory: true, multiple: false }) as { paths: string[] | null }
  if (!result.paths?.[0]) { message(t('已取消选择，资料库保持不变。', 'Selection cancelled; library unchanged.')); return }
  const state = await request('plugin.configure_storage', { ...vaultParams(), path: result.paths[0] }) as StorageStatus
  input('storage-path').value = state.path ?? result.paths[0]
  clearLibraryView()
  await reloadLibrary()
}, { setup: true }) })
for (const id of ['status', 'storage-check']) el(id).addEventListener('click', () => { void operation(reloadLibrary, { setup: true }) })
el('choose').addEventListener('click', () => { void operation(async () => {
  const result = await request('host.dialog.open', { title: labels['file-label'], multiple: false, filters: [{ name: 'Apple Health', extensions: ['zip', 'xml'] }] }) as { paths: string[] | null }
  if (result.paths?.[0]) input('file').value = result.paths[0]
  message(t('文件已就绪', 'File selection ready'))
}) })
el('import').addEventListener('click', () => { void operation(async () => {
  const file = input('file').value.trim(); if (!file) throw new Error(t('请先选择健康导出文件。', 'Choose a health export file first.'))
  const preview = input('apple-dry-run').checked
  const result = await request('plugin.import', { ...vaultParams(), file, dry_run: preview }) as Json
  report(result); if (!preview) await refresh()
  message(result.complete === false ? t('导入有未完成项，请查看结果。', 'Import has unfinished items. Review the result.') : preview ? t('预览完成，未修改归档。', 'Preview complete; archive unchanged.') : t('Apple 健康数据已增量导入。', 'Apple Health records imported incrementally.'), result.complete === false)
}, { progress: true }) })
el('garmin-zip-choose').addEventListener('click', () => { void operation(async () => {
  const result = await request('host.dialog.open', { title: labels['garmin-zip-file-label'], multiple: false, filters: [{ name: 'Garmin', extensions: ['zip'] }] }) as { paths: string[] | null }
  if (result.paths?.[0]) input('garmin-zip-file').value = result.paths[0]
  message(t('文件已就绪', 'File selection ready'))
}) })
for (const [id, preview] of [['garmin-zip-preview', true], ['garmin-zip-import', false]] as const) el(id).addEventListener('click', () => { void operation(async () => {
  const file = input('garmin-zip-file').value.trim(), region = select('garmin-zip-region').value
  if (!file) throw new Error(t('请先选择 Garmin 导出 ZIP。', 'Choose a Garmin export ZIP first.'))
  if (!['china', 'global'].includes(region)) throw new Error(t('请选择导出账号区域。', 'Choose the export account region.'))
  const result = await request('plugin.garmin-import', { ...vaultParams(), file, region, dry_run: preview }) as Json
  // Keep the summary visible without listing every private source filename.
  const { file_reports: _files, ...summary } = result
  report(summary); if (!preview) await refresh()
  const details: string[] = []
  for (const [key, cn, en] of [['records', '条记录', 'records'], ['files', '个文件', 'files'], ['parsed_files', '个已解析', 'parsed'], ['preserved_only_files', '个仅保留原件', 'preserved as originals only']]) {
    if (typeof result[key] === 'number') details.push(`${Number(result[key]).toLocaleString()} ${t(cn, en)}`)
  }
  if (typeof result.account_id === 'string') details.push(`${t('账号', 'Account')} ${result.account_id.slice(0, 8)}`)
  const outcome = result.complete === false ? t('Garmin ZIP 有未完成项，请查看操作明细。', 'Garmin ZIP has unfinished items. Review the operation details.') : preview ? t('Garmin ZIP 预览完成，未修改归档。', 'Garmin ZIP preview complete; archive unchanged.') : t('Garmin ZIP 已导入，当前同步账号未改变。', 'Garmin ZIP imported; the current sync account is unchanged.')
  message(`${outcome}${details.length ? ` ${details.join(' · ')}` : ''}`, result.complete === false)
}, { progress: true }) })
el('oura-file-account').addEventListener('change', () => { el('oura-profile-fields').hidden = select('oura-file-account').value !== '__offline__' })
el('oura-file-choose').addEventListener('click', () => { void operation(async () => {
  const result = await request('host.dialog.open', { title: labels['oura-file-label'], multiple: false, filters: [{ name: 'Oura', extensions: ['zip', 'csv', 'json'] }] }) as { paths: string[] | null }
  if (result.paths?.[0]) input('oura-file').value = result.paths[0]
  message(t('文件已就绪', 'File selection ready'))
}) })
for (const [id, preview] of [['oura-file-preview', true], ['oura-file-import', false]] as const) el(id).addEventListener('click', () => { void operation(async () => {
  const file = input('oura-file').value.trim(), account = select('oura-file-account').value
  if (!file) throw new Error(t('请先选择 Oura 导出文件。', 'Choose an Oura export file first.'))
  if (!account) throw new Error(t('请明确选择数据所属账号。', 'Explicitly choose the account this data belongs to.'))
  const identity: Json = account === '__offline__' ? { profile: input('oura-profile').value.trim() } : { account_id: account }
  if (account === '__offline__' && !identity.profile) throw new Error(t('请填写稳定的离线账号名称。', 'Enter a stable offline account name.'))
  const result = await request('plugin.oura-import', { ...vaultParams(), file, ...identity, dry_run: preview }) as Json
  const { file_reports: _files, ...summary } = result
  report(summary); if (!preview) await refresh()
  message(result.complete === false ? t('Oura 文件有未完成项，请查看操作明细。', 'Oura file has unfinished items. Review the operation details.') : preview ? t('Oura 文件预览完成，未修改资料库。', 'Oura file preview complete; library unchanged.') : t('Oura 文件已增量导入，当前同步账号未改变。', 'Oura file imported incrementally; the current sync account is unchanged.'), result.complete === false)
}, { progress: true }) })
for (const source of providers) for (const action of ['stop', 'history-stop']) el(`${source}-${action}`).addEventListener('click', () => { if (collectingSource === source) { stopRequested = true; setBusy(busy); message(t('本批完成后停止，进度将保留。', 'Stopping after this batch; progress will be retained.')) } })
for (const id of ['apple-dry-run', ...providers.map(source => `${source}-dry-run`)]) el(id).addEventListener('change', syncControls)
async function collect(jobs: CollectionJob[], preview: boolean) {
  if (!jobs.length) throw new Error(t('请先连接当前账号。', 'Connect a current account first.'))
  collecting = true; collectingSource = jobs[0].source; stopRequested = false; setBusy(true)
  const queue = jobs.map(job => ({ ...job })), cursors = new Map<string, string>(), reports: Json[] = []
  const params = { ...vaultParams(), max_days: 31, dry_run: preview }
  let batch = 0, hadWarnings = false
  while (queue.length) {
    const job = queue.shift()!
    message(`${t('正在采集批次', 'Collecting batch')} ${++batch} · ${sources[job.source]}…`)
    const result = await request('plugin.sync', { ...params, ...job }) as Json
    reports.push(result); report(jobs.length > 1 ? { results: reports } : result)
    if (!preview) await refresh()
    const errors = [result.fatal_errors, result.errors].some(value => Array.isArray(value) && value.length > 0)
    if (errors || result.retry_required) { message(t('本批未完成，已保留进度。请查看结果后重试。', 'This batch is incomplete; progress was retained. Review the result and retry.'), true); return }
    const items = Array.isArray(result.sources) ? result.sources : []
    if (items.some(item => item.source !== job.source || (item.account_id && item.account_id !== job.account_id))) throw new Error(t('返回的同步账号发生变化，已停止。', 'The returned sync account changed; collection stopped.'))
    hadWarnings ||= (Array.isArray(result.warnings) && result.warnings.length > 0) || (result.complete === false && (!result.pending || preview))
    if (!preview) {
      const pending = items.find(item => item.source === job.source && item.pending === true)
      if (pending) {
        const key = `${job.source}:${job.account_id}`, next = String(pending.next_day ?? '')
        if (!next || cursors.get(key) === next) throw new Error(t('采集游标未前进，已停止。请查看结果后重试。', 'Collection cursor did not advance. Review the result before retrying.'))
        cursors.set(key, next); queue.push({ ...job, restart: false })
      } else if (result.pending) throw new Error(t('未收到有效的续传进度，已停止。', 'No valid resume progress was returned; collection stopped.'))
    }
    if (stopRequested && queue.length) { message(t('已停止后续批次；再次采集将续传。', 'Further batches stopped. Collect again to resume.')); return }
  }
  if (preview) message(hadWarnings ? t('预览有未完成项，请查看操作明细。', 'Preview has unfinished items. Review the operation details.') : t('预览完成，未修改归档或进度。', 'Preview complete; archive and progress unchanged.'), hadWarnings)
  else message(hadWarnings ? t('采集已结束，仍有不可用或未完成项，请查看结果与覆盖明细。', 'Collection finished with unavailable or unfinished items. Review results and coverage.') : jobs[0].history ? t('所选账号的历史导入完成，当前同步账号未改变。', 'History import completed for the selected account; the current sync account is unchanged.') : t('当前账号同步完成。', 'Current account sync completed.'))
}
for (const source of providers) {
  el(`${source}-sync`).addEventListener('click', () => { void operation(async () => {
    const snapshot = await request('plugin.connections', vaultParams()) as Record<string, Connection>
    connectionStates(snapshot)
    const state = snapshot[source], id = state?.active_account_id
    if (!id || !state.accounts?.some(account => account.id === id && account.connected)) throw new Error(t('请先连接并设置当前账号。', 'Connect an account and set it as current first.'))
    await collect([{ source, account_id: id }], input(`${source}-dry-run`).checked)
  }, { progress: true }) })
  el(`${source}-history-import`).addEventListener('click', () => { void operation(async () => {
    const account_id = select(`${source}-history-account`).value
    const since = input(`${source}-history-since`).value, until = input(`${source}-history-until`).value
    if (!account_id) throw new Error(t('请选择已连接的历史账号。', 'Choose a connected account for history import.'))
    if (!since || !until || since > until) throw new Error(t('请选择有效的采集日期范围。', 'Choose a valid collection date range.'))
    await collect([{ source, account_id, history: true, since, until, restart: input(`${source}-restart`).checked }], input(`${source}-dry-run`).checked)
  }, { progress: true }) })
}
el('oura-cancel').addEventListener('click', () => { void (async () => {
  const target = cancellationTarget()
  if (!target || cancellingAuthorization) return
  const ownsBusy = !busy
  cancellingAuthorization = true
  if (ownsBusy) setBusy(true)
  cancellationControls()
  try {
    const result = await request('plugin.cancel_authorization', { vault: target.vault, source: target.source, authorization_id: target.id }) as Connection & { cancelled?: boolean }
    if (authorizationAttempt === target && result.cancelled) target.cancelled = true
    if (input('vault').value.trim() === target.vault) {
      connectionStates({ ...connections, [target.source]: result })
      if (ownsBusy) { await refresh(); message(result.cancelled ? t('授权已取消，已有账号保持不变。', 'Authorization cancelled; existing accounts are unchanged.') : t('授权状态已更新。', 'Authorization status updated.')) }
    }
  } catch {
    if (input('vault').value.trim() === target.vault) message(t('取消授权失败，请重试。', 'Could not cancel authorization. Retry.'), true)
  } finally {
    cancellingAuthorization = false
    if (ownsBusy) setBusy(false)
    else cancellationControls()
  }
})() })
for (const source of ['garmin', 'oura']) {
  el(`${source}-connect`).addEventListener('click', () => { void operation(async () => {
    const params: Json = { ...vaultParams(), source, ...(input(`${source}-label`).value.trim() ? { label: input(`${source}-label`).value.trim() } : {}) }
    if (source === 'garmin') { params.region = select('garmin-region').value; params.api_key = input('garmin-key').value; input('garmin-key').value = '' }
    else { params.client_id = input('oura-id').value.trim(); params.client_secret = input('oura-secret').value; params.redirect_uri = input('oura-redirect').value.trim(); input('oura-secret').value = '' }
    clearAuthorization()
    try {
      let result: Json
      try { result = await request('plugin.connect', params) as Json } finally { delete params.api_key; delete params.client_secret }
      if (typeof result.authorize_url === 'string') { el<HTMLTextAreaElement>('authorize-url').value = result.authorize_url; el('authorization').hidden = false }
      if (result.pending) {
        message(t('请在浏览器完成 Oura 授权。', 'Complete Oura authorization in your browser.'))
        const authorizationId = result.authorization_id
        if (typeof authorizationId !== 'string' || !authorizationId) throw new Error('Missing authorization ID')
        const attempt = { source, vault: String(params.vault), id: authorizationId, cancelled: false }
        authorizationAttempt = attempt; cancellationControls()
        const deadline = Date.now() + 300_000
        while (true) {
          const connections = await request('plugin.connections', { vault: attempt.vault }) as Record<string, Connection>
          if (attempt.cancelled) { await refresh(); message(t('授权已取消，已有账号保持不变。', 'Authorization cancelled; existing accounts are unchanged.')); return }
          connectionStates(connections)
          const state = connections[source] ?? {}
          if (state.authorization_id !== authorizationId) throw new Error('Authorization was replaced')
          if (state.error) throw new Error('Authorization failed')
          if (!state.pending && state.completed_account_id) break
          if (!state.pending && !state.error) { await refresh(); message(t('授权已取消，已有账号保持不变。', 'Authorization cancelled; existing accounts are unchanged.')); return }
          if (!state.pending || Date.now() >= deadline) throw new Error('Authorization did not complete')
          await new Promise(resolve => window.setTimeout(resolve, 1000))
        }
      }
      input(`${source}-label`).value = ''
      await refresh(); message(t('账号已保存。可设为当前或导入历史。', 'Account saved. Set it as current or import history.'))
    } catch (error) {
      const current = connections[source]?.accounts?.find(account => account.id === connections[source]?.active_account_id)
      el(`${source}-state`).textContent = `${t('连接未完成，请检查设置后重试。', 'Connection incomplete. Check settings and retry.')}${current ? ` ${t('当前：', 'Current: ')}${accountName(current)}` : ''}`
      throw error
    } finally { authorizationAttempt = null; clearAuthorization(); cancellationControls() }
  }, { sensitive: true }) })
  el(`${source}-account`).addEventListener('change', accountControls)
  el(`${source}-select`).addEventListener('click', () => { void operation(async () => { await request('plugin.select_account', { ...vaultParams(), source, account_id: select(`${source}-account`).value }); await refresh(); message(t('当前同步账号已切换。', 'Current sync account changed.')) }) })
  el(`${source}-disconnect`).addEventListener('click', () => { void operation(async () => { await request('plugin.disconnect', { ...vaultParams(), source, account_id: select(`${source}-account`).value }); await refresh(); message(t('已断开所选账号，归档数据保留。', 'Selected account disconnected; archived data retained.')) }, { sensitive: true }) })
}
void operation(async () => {
  const info = await request('host.vault.info') as { root?: string }
  associatedVault = info.root ?? ''; input('vault').value = associatedVault
  if (!associatedVault) throw new Error(t('请先在 note.md 打开 Vault。', 'Open a Vault in note.md first.'))
  await reloadLibrary()
}, { setup: true })
