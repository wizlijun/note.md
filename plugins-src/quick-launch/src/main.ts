import './style.css'

interface Bridge { locale?: string; request(method: string, params?: unknown): Promise<unknown> }
declare global { interface Window { notemd?: Bridge } }
type Entry = { id: string; name: string; kind: 'app' | 'cli'; target: string; enabled: boolean }
type Config = { entries: Entry[] }
type RunResult = { ok: boolean; exitCode: number; stdout: string; stderr: string }
const zh = (window.notemd?.locale ?? navigator.language).startsWith('zh')
const t = (cn: string, en: string) => zh ? cn : en
const title = t('快捷启动', 'Quick Launch')
let entries: Entry[] = []
let saved = ''
let loaded = false
let busy = false
let running: string | null = null
let sequence = 0

document.documentElement.lang = zh ? 'zh-CN' : 'en'
document.title = title
// Only static markup enters innerHTML; user names, targets and process output use textContent/value.
document.querySelector('#app')!.innerHTML = `
<header><h1></h1><p class="help" id="intro"></p></header>
<p id="error" role="alert" hidden></p><button id="retry" hidden></button>
<div id="entries"></div><p id="empty" class="help" hidden></p>
<div class="footer"><button id="add" disabled></button><button id="save" disabled></button></div>
<p id="save-state" role="status" aria-live="polite"></p><p id="scope" class="help"></p>
<section id="result" hidden><p id="run-state" role="status" aria-live="polite"></p><pre id="output" hidden></pre></section>`
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T
const button = (id: string) => el<HTMLButtonElement>(id)
document.querySelector('h1')!.textContent = title
el('intro').textContent = t('把常用应用和命令放进托盘的「启动」菜单。保存后立即生效。', 'Keep apps and commands in the tray Launch menu. Changes apply when saved.')
el('scope').textContent = t('仅保存在这台 Mac。命令在后台运行，最长 60 秒；完成表示命令已退出，不代表外部设备已响应。', 'Saved on this Mac only. Commands run in the background for up to 60 seconds; completion reports command exit, not a response from an external device.')
el('empty').textContent = t('还没有启动项。添加一个应用或命令。', 'No launch items yet. Add an app or command.')
button('add').textContent = t('添加启动项', 'Add item')
button('save').textContent = t('保存', 'Save')
button('retry').textContent = t('重新读取', 'Retry loading')

async function request<T>(method: string, params?: unknown): Promise<T> {
  if (!window.notemd) throw new Error(t('请在 note.md 内打开此插件。', 'Open this plugin inside note.md.'))
  return await window.notemd.request(method, params) as T
}
const dirty = () => JSON.stringify(entries) !== saved
function showError(error: unknown = null) {
  el('error').hidden = error == null
  el('error').textContent = error == null ? '' : String(error instanceof Error ? error.message : error)
}
function updateControls() {
  const locked = !loaded || busy || running !== null
  for (const control of el('entries').querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input, select, button')) {
    control.disabled = locked
  }
  entries.forEach((entry, index) => {
    const row = document.querySelector<HTMLElement>(`[data-entry='${entry.id}']`)!
    row.querySelector<HTMLButtonElement>('[data-action="up"]')!.disabled = locked || index === 0
    row.querySelector<HTMLButtonElement>('[data-action="down"]')!.disabled = locked || index === entries.length - 1
    row.querySelector<HTMLButtonElement>('[data-action="run"]')!.disabled = locked || dirty() || !entry.enabled || !entry.name.trim() || !entry.target.trim()
  })
  button('add').disabled = locked || entries.length >= 20
  button('save').disabled = locked || !dirty()
  button('retry').disabled = busy
  el('empty').hidden = !loaded || entries.length > 0
  el('save-state').textContent = !loaded ? t('正在读取配置…', 'Loading configuration…')
    : busy ? t('正在处理…', 'Working…')
      : dirty() ? t('有未保存的修改；保存后可运行。', 'Unsaved changes. Save before running.')
        : t('已保存 · 与托盘菜单一致', 'Saved · Matches the tray menu')
}
function render() {
  el('entries').replaceChildren()
  entries.forEach((entry, index) => {
    const row = document.createElement('section')
    row.className = 'entry'
    row.dataset.entry = entry.id
    row.innerHTML = `<div class="entry-head"><label><input type="checkbox" data-field="enabled"><span></span></label><div class="actions"><button data-action="up">↑</button><button data-action="down">↓</button><button data-action="remove" class="danger"></button></div></div>
<div class="fields"><label class="field"><span class="name-label"></span><input data-field="name" maxlength="80" autocomplete="off"></label><label class="field"><span class="kind-label"></span><select data-field="kind"><option value="app"></option><option value="cli"></option></select></label></div>
<label class="field"><span class="target-label"></span><div class="target-row"><input data-field="target" maxlength="8192" autocomplete="off" spellcheck="false"><button data-action="browse" type="button"></button></div></label>
<div class="actions"><button data-action="run"></button><small class="help"></small></div>`
    row.querySelector('.entry-head span')!.textContent = t(`启动项 ${index + 1} · 启用`, `Item ${index + 1} · Enabled`)
    row.querySelector('.name-label')!.textContent = t('菜单名称', 'Menu name')
    row.querySelector('.kind-label')!.textContent = t('类型', 'Type')
    row.querySelector('.target-label')!.textContent = entry.kind === 'app' ? t('应用名称或绝对路径', 'App name or absolute path') : t('Shell 命令', 'Shell command')
    row.querySelector('option[value="app"]')!.textContent = t('应用', 'App')
    row.querySelector('option[value="cli"]')!.textContent = t('命令行', 'Command')
    row.querySelector('small')!.textContent = entry.kind === 'cli' ? t('使用本机的登录 Shell。', 'Uses your login shell.') : t('例如 Safari 或 /Applications/Safari.app', 'For example Safari or /Applications/Safari.app')
    for (const [field, value] of Object.entries(entry)) {
      const control = row.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-field="${field}"]`)
      if (!control) continue
      if (field === 'enabled') (control as HTMLInputElement).checked = value as boolean
      else control.value = String(value)
      control.addEventListener(field === 'name' || field === 'target' ? 'input' : 'change', () => {
        if (field === 'enabled') entry.enabled = (control as HTMLInputElement).checked
        else if (field === 'kind') entry.kind = control.value as Entry['kind']
        else if (field === 'name') entry.name = control.value
        else if (field === 'target') entry.target = control.value
        showError()
        if (field === 'kind') {
          render()
          document.querySelector<HTMLSelectElement>(`[data-entry='${entry.id}'] [data-field='kind']`)?.focus()
        }
        else updateControls()
      })
    }
    const action = (name: string, label: string, handler: () => void) => {
      const control = row.querySelector<HTMLButtonElement>(`[data-action="${name}"]`)!
      if (name !== 'up' && name !== 'down') control.textContent = label
      control.setAttribute('aria-label', label)
      control.title = label
      control.onclick = handler
      return control
    }
    action('up', t('上移', 'Move up'), () => move(index, -1))
    action('down', t('下移', 'Move down'), () => move(index, 1))
    action('remove', t('删除', 'Delete'), () => { entries.splice(index, 1); render() })
    action('browse', t('选择…', 'Choose…'), () => { void browse(entry) }).hidden = entry.kind !== 'app'
    action('run', t('运行', 'Run'), () => { void run(entry) })
    el('entries').append(row)
  })
  updateControls()
}
function move(index: number, direction: number) {
  const next = index + direction
  if (next < 0 || next >= entries.length) return
  ;[entries[index], entries[next]] = [entries[next], entries[index]]
  render()
}
async function browse(entry: Entry) {
  busy = true
  showError()
  updateControls()
  try {
    const result = await request<{ paths: string[] | null }>('host.dialog.open', {
      title: t('选择应用', 'Choose an app'), multiple: false,
      filters: [{ name: t('应用', 'Applications'), extensions: ['app'] }],
    })
    if (result.paths?.[0]) entry.target = result.paths[0]
  } catch (error) { showError(error) }
  finally { busy = false; render() }
}
async function load() {
  busy = true
  showError()
  button('retry').hidden = true
  updateControls()
  try {
    const config = await request<Config>('host.quickLaunch.get', {})
    entries = config.entries
    saved = JSON.stringify(entries)
    loaded = true
  } catch (error) {
    showError(error)
    button('retry').hidden = false
  } finally {
    busy = false
    render()
    if (!loaded) el('save-state').textContent = t('无法读取配置。请重试。', 'Unable to load configuration. Please retry.')
  }
}
async function save() {
  if (!loaded || busy || running || !dirty()) return
  busy = true
  showError()
  updateControls()
  try {
    const config = await request<Config>('host.quickLaunch.save', { entries })
    entries = config.entries
    saved = JSON.stringify(entries)
  } catch (error) { showError(error) }
  finally { busy = false; render() }
}
async function run(entry: Entry) {
  if (!loaded || busy || running || dirty() || !entry.enabled) return
  running = entry.id
  showError()
  el('result').hidden = false
  el('output').hidden = true
  el('output').textContent = ''
  el('run-state').textContent = t(`正在运行「${entry.name}」…`, `Running “${entry.name}”…`)
  updateControls()
  try {
    const result = await request<RunResult>('host.quickLaunch.run', { id: entry.id })
    if (!result.ok || result.exitCode !== 0) throw new Error(t(`执行失败（退出码 ${result.exitCode}）`, `Command failed (exit code ${result.exitCode})`) + (result.stderr ? `\n${result.stderr}` : ''))
    el('run-state').textContent = entry.kind === 'app' ? t(`已请求打开「${entry.name}」。`, `Requested opening “${entry.name}”.`) : t(`「${entry.name}」命令已完成。`, `“${entry.name}” command completed.`)
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n')
    el('output').textContent = output
    el('output').hidden = !output
  } catch (error) {
    el('run-state').textContent = t(`「${entry.name}」执行失败。`, `“${entry.name}” failed.`)
    showError(error)
  } finally { running = null; updateControls() }
}
button('add').onclick = () => {
  entries.push({ id: `launch-${Date.now()}-${++sequence}`, name: '', kind: 'app', target: '', enabled: false })
  render()
  el('entries').lastElementChild?.querySelector<HTMLInputElement>('[data-field="name"]')?.focus()
}
button('save').onclick = () => { void save() }
button('retry').onclick = () => { void load() }
void load()
