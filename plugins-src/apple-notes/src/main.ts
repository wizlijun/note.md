import './style.css'

interface Report {
  created: number
  updated: number
  moved: number
  deleted: number
  unchanged: number
  locked: number
  warnings: string[]
  complete: boolean
}
interface Status {
  ready: boolean
  auto_sync: boolean
  running: boolean
  last_finished: number | null
  report: Report | null
  error: string | null
  vault: string | null
}
interface Bridge {
  locale: string
  request(method: string, params?: unknown): Promise<unknown>
}
declare global { interface Window { notemd?: Bridge } }

const bridge = window.notemd
const zh = bridge?.locale?.startsWith('zh') ?? navigator.language.startsWith('zh')
document.documentElement.lang = zh ? 'zh-CN' : 'en'
const t = (en: string, cn: string) => zh ? cn : en
const app = document.querySelector<HTMLElement>('#app')!
// Only fixed application copy goes through innerHTML. Note titles, Vault paths,
// permission errors and every source-provided string use textContent below.
app.innerHTML = `
  <header><span class="eyebrow">macOS · APPLE NOTES</span>
    <h1>${t('Apple Notes Sync', 'Apple Notes 同步')}</h1>
    <p>${t('Keep a read-only copy of your notes in your Vault.', '在 Vault 中保存 Apple Notes 的只读副本。')}</p>
  </header>
  <section class="destination"><span>${t('Destination', '同步位置')}</span><code id="destination">Vault/applenotes/</code>
    <p>${t('Account → folders → YYYY-MM-DD-title.md · IDs and sync state: id-sync.json', '账户 → 文件夹 → YYYY-MM-DD-标题.md · ID 与同步状态：id-sync.json')}</p></section>
  <section class="controls">
    <label><input id="auto" type="checkbox" disabled />${t('Sync automatically every 5 minutes', '每 5 分钟自动同步')}</label>
    <p>${t('Runs while note.md is open. New notes, edits, moves and deletions follow Apple Notes.', '在 note.md 运行时生效，跟随 Apple Notes 的新增、修改、移动和删除。')}</p>
    <button id="sync" disabled>${t('Sync now', '立即同步')}</button>
  </section>
  <section aria-live="polite" aria-atomic="true">
    <h2 id="status">${t('Loading…', '正在读取状态…')}</h2>
    <p id="finished" class="muted"></p>
    <dl id="counts"></dl>
    <p id="error" class="error" hidden></p>
    <ul id="warnings" hidden></ul>
  </section>
  <footer>${t('The first sync asks for permission to access Notes. Locked notes are skipped. Exportable attachments stay with each note.', '首次同步需要允许访问“备忘录”。锁定笔记会跳过，可导出的附件保存在笔记旁。')}</footer>
`
const button = document.querySelector<HTMLButtonElement>('#sync')!
const auto = document.querySelector<HTMLInputElement>('#auto')!
const errorEl = document.querySelector<HTMLElement>('#error')!
let busy = false
let ready = false
let current: Status | null = null
let stopped = false

function showError(error: unknown) {
  errorEl.textContent = error instanceof Error ? error.message : String(error)
  errorEl.hidden = false
  if (!ready) document.querySelector('#status')!.textContent = t('Unable to load sync status', '无法读取同步状态')
}
function render(state: Status) {
  current = state
  ready = state.ready
  auto.checked = state.auto_sync
  auto.disabled = busy || !state.ready
  button.disabled = busy || !state.ready || state.running
  button.textContent = state.running ? t('Syncing…', '正在同步…') : t('Sync now', '立即同步')
  document.querySelector('#destination')!.textContent = state.vault ? `${state.vault.replace(/\/$/, '')}/applenotes/` : 'Vault/applenotes/'
  document.querySelector('#status')!.textContent = !state.ready ? t('Loading…', '正在读取状态…')
    : state.running ? t('Reading Apple Notes…', '正在读取 Apple Notes…')
    : state.error ? t('Sync failed', '同步失败')
    : state.report ? state.report.complete ? t('Sync complete', '同步完成') : t('Sync incomplete', '同步未完整完成')
    : t('Ready to sync', '尚未同步')
  document.querySelector('#finished')!.textContent = state.last_finished
    ? `${t('Last run: ', '上次同步：')}${new Date(state.last_finished * 1000).toLocaleString()}` : ''
  errorEl.textContent = state.error ?? ''
  errorEl.hidden = !state.error
  const counts = document.querySelector('#counts')!
  counts.replaceChildren()
  if (state.report) {
    const labels: [keyof Pick<Report, 'created' | 'updated' | 'moved' | 'deleted' | 'unchanged' | 'locked'>, string][] = [
      ['created', t('New', '新增')], ['updated', t('Updated', '更新')], ['moved', t('Moved', '移动')],
      ['deleted', t('Removed', '删除')], ['unchanged', t('Unchanged', '无变更')], ['locked', t('Locked', '已锁定')],
    ]
    for (const [key, label] of labels) {
      const item = document.createElement('div')
      const term = document.createElement('dt')
      const value = document.createElement('dd')
      term.textContent = label
      value.textContent = String(state.report[key])
      item.append(term, value)
      counts.append(item)
    }
  }
  const warnings = document.querySelector<HTMLUListElement>('#warnings')!
  warnings.replaceChildren()
  for (const warning of state.report?.warnings ?? []) {
    const item = document.createElement('li')
    item.textContent = warning
    warnings.append(item)
  }
  warnings.hidden = !warnings.childElementCount
}
async function request(method: string, params?: unknown): Promise<Status> {
  if (!bridge) throw new Error(t('Open this plugin inside note.md.', '请在 note.md 中打开本插件。'))
  return await bridge.request(`plugin.${method}`, params) as Status
}
async function action(method: string, params?: unknown) {
  busy = true
  button.disabled = true
  auto.disabled = true
  try { render(await request(method, params)) }
  catch (error) { if (current) auto.checked = current.auto_sync; showError(error) }
  finally {
    busy = false
    auto.disabled = !ready || !current?.ready
    button.disabled = !ready || !current?.ready || !!current?.running
  }
}
button.addEventListener('click', () => void action('sync'))
auto.addEventListener('change', () => void action('settings', { auto_sync: auto.checked }))
async function poll() {
  if (stopped) return
  if (!busy) {
    try { render(await request('status')) }
    catch (error) { showError(error) }
  }
  if (!stopped) window.setTimeout(() => void poll(), current?.running ? 1000 : 5000)
}
window.addEventListener('beforeunload', () => { stopped = true })
void poll()
