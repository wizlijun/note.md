import './style.css'
import { pageLabel, preferencesFromForm, type SumiState, type SurfaceHandle, type Bounds } from './contract'

interface Bridge {
  locale?: string
  request(method: string, params?: unknown): Promise<unknown>
  onMessage?(handler: (event: unknown) => void): void
}
declare global { interface Window { notemd?: Bridge } }
const zh = (window.notemd?.locale ?? navigator.language).startsWith('zh')
const t = (cn: string, en: string) => zh ? cn : en
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T
let state: SumiState | undefined
let surface: SurfaceHandle | undefined
let surfacePageId: string | undefined
let pendingState: SumiState | undefined
type NavigationSeed = { kind: 'sumi-navigation'; pageId: string; action: 'new_page' | 'previous_page' | 'next_page' | 'menu' | 'open_page' }
let pendingNavigation: NavigationSeed | undefined
function navigationSeed(value: unknown): NavigationSeed | undefined {
  if (!value || typeof value !== 'object') return
  const seed = value as NavigationSeed
  if (seed.kind === 'sumi-navigation' && typeof seed.pageId === 'string' && seed.pageId.length <= 128
    && ['new_page', 'previous_page', 'next_page', 'menu', 'open_page'].includes(seed.action)) return seed
}
async function navigateFromTab(seed: NavigationSeed) {
  await page('open', seed.pageId)
  if (seed.action === 'open_page' || !surface) return
  if (seed.action === 'menu') await showPages()
  else await page(seed.action === 'new_page' ? 'create' : seed.action === 'previous_page' ? 'previous' : 'next')
}
let busy = false
let panelOpen = false
let mounted = true
let windowVisible = true
let pendingWindowResume = false
let pendingFocusPage: string | undefined
let generation = 0
let resizeTimer: ReturnType<typeof setTimeout> | undefined

// User content is always assigned through textContent, never interpolated into markup.
el('app').innerHTML = `<main id="surface" aria-label="Sumi"></main>
<p id="notice" role="status" aria-live="polite"></p>
<nav id="tools" aria-label="Sumi"><button id="previous">←</button><button id="next">→</button><button id="new">＋</button><button id="pages">☷</button><button id="appearance">Aa</button><button id="sync">⇄</button><button id="fullscreen">⛶</button></nav>
<section id="panel" hidden aria-modal="true" role="dialog"><header><h1 id="panel-title"></h1><button id="close">×</button></header><div id="panel-body"></div></section>`
for (const [id, label] of Object.entries({ previous: t('上一页', 'Previous page'), next: t('下一页', 'Next page'), new: t('新的一页', 'New page'), pages: t('纸页', 'Pages'), appearance: t('外观', 'Appearance'), sync: t('同步', 'Sync'), fullscreen: t('进入全屏（⌃⌘F）', 'Enter fullscreen (⌃⌘F)'), close: t('返回书写', 'Back to writing') })) {
  el(id).title = label; el(id).setAttribute('aria-label', label)
}

async function request<T>(method: string, params?: unknown): Promise<T> {
  if (!window.notemd) throw new Error(t('请在 note.md 中打开 Sumi。', 'Open Sumi inside note.md.'))
  return await window.notemd.request(`host.sumi.${method}`, params) as T
}
function notice(message = '') { el('notice').textContent = message; el('notice').hidden = !message }
function bounds(): Bounds {
  const r = el('surface').getBoundingClientRect()
  return { x: r.x, y: r.y, width: r.width, height: r.height }
}
function syncStatusLabel(connected: boolean) {
  return connected ? t('已连接', 'Connected') : t('离线也可以继续书写。连接后自动合并。', 'Keep writing offline. Changes merge when reconnected.')
}
function applyState(next: SumiState) {
  if ((next.navigationVersion ?? 0) < (state?.navigationVersion ?? 0)) return
  state = next
  document.documentElement.dataset.theme = next.preferences.theme
  el('sync').dataset.pending = String(next.sync.pending > 0)
  const syncStatus = document.getElementById('sync-status')
  if (syncStatus) syncStatus.textContent = syncStatusLabel(next.sync.connected)
  const invite = document.getElementById('sync-invite')
  if (invite) invite.hidden = !next.sync.connected
  notice(!next.available ? next.reason ?? t('此系统暂不支持原生写作。', 'Native writing is unavailable on this system.')
    : next.saveState === 'error' ? t('保存失败，文字已保留，请重试。', 'Saving failed. Your draft is retained; retry saving.')
      : next.saveState === 'projection-pending' ? t('文字已保存在本机，文件仍待写入。', 'Saved locally; file export is pending.')
        : next.sync.message ?? '')
}
async function releaseSurface() {
  if (!surface) return
  const old = surface
  await request('detach', { surface: old })
  // A rejected detach still owns its native view and must remain retryable.
  if (surface === old) { surface = undefined; surfacePageId = undefined }
}
async function acceptState(next: SumiState) {
  if ((next.navigationVersion ?? 0) < (state?.navigationVersion ?? 0)) return
  if (!windowVisible) { applyState(next); return }
  const changed = !!state && next.activePageId !== state.activePageId
  if (changed) await releaseSurface()
  if (changed && pendingOperation?.action === 'next' && next.activePageId !== pendingOperation.requestId) {
    // A pushed existing successor completes navigation without creating the
    // operation's UUID. A later Next click starts from that visible successor.
    pendingOperation = undefined
    try { sessionStorage.removeItem(operationKey) } catch { /* optional storage */ }
  }
  applyState(next)
  if (changed) await mountPage()
}
async function refresh() { const next = await request<SumiState>('state'); if (mounted) await acceptState(next) }
async function mountPage(focusExisting = false) {
  if (!windowVisible) return
  const attempt = ++generation
  if (surface && surfacePageId === state?.activePageId) return
  await releaseSurface()
  if (!state?.available || !state.activePageId) return
  const pageId = state.activePageId
  notice(t('正在打开纸页并准备同步…', 'Opening the page and preparing sync…'))
  const handle = await request<SurfaceHandle | { kind: 'existing_owner'; page_id: string }>('mount', { pageId, bounds: bounds() })
  // A successful native close has already flushed and detached every surface.
  if (!windowVisible) return
  if ('kind' in handle) {
    if (mounted && attempt === generation) {
      if (focusExisting) await request('focus_existing', { pageId: handle.page_id })
      notice(t('此页已在另一个编辑面中打开。', 'This page is open in another editor.'))
    }
    return
  }
  if (!mounted || attempt !== generation) { await request('detach', { surface: handle }); return }
  surface = handle; surfacePageId = pageId
  await request('visible', { surface, visible: !panelOpen })
  if (!panelOpen) await request('focus', { surface })
  if (state) applyState(state)
}
async function run(action: () => Promise<void>) {
  if (busy || !mounted) return
  busy = true
  for (const button of document.querySelectorAll<HTMLButtonElement>('button')) button.disabled = true
  try { await action() } catch (error) { notice(error instanceof Error ? error.message : String(error)) }
  finally {
    busy = false
    for (const button of document.querySelectorAll<HTMLButtonElement>('button')) button.disabled = false
    const navigation = pendingNavigation
    if (navigation && mounted && windowVisible) {
      pendingNavigation = undefined
      void run(() => navigateFromTab(navigation))
    } else if (pendingFocusPage && mounted && windowVisible) {
      const page = pendingFocusPage; pendingFocusPage = undefined
      void run(() => focusOwnedPage(page))
    } else if (pendingWindowResume && mounted && windowVisible) {
      pendingWindowResume = false
      void run(async () => { await refresh(); await mountPage(true) })
    } else {
      const next = pendingState; pendingState = undefined
      if (next && mounted) void run(() => acceptState(next))
    }
  }
}
type PageOperation = { action: string; pageId?: string; fromPageId: string | null; requestId: string }
const operationKey = 'notemd.sumi.pending-page-operation'
let pendingOperation: PageOperation | undefined
try {
  const raw = sessionStorage.getItem(operationKey)
  if (raw && raw.length < 4096) {
    const value = JSON.parse(raw) as PageOperation
    if (['create', 'next', 'delete'].includes(value.action) && typeof value.requestId === 'string' && /^[0-9a-f-]{36}$/i.test(value.requestId)
      && (value.fromPageId === null || typeof value.fromPageId === 'string')) pendingOperation = value
  }
} catch { /* Storage may be disabled; the live operation remains retryable. */ }
function operation(action: string, pageId?: string): PageOperation | undefined {
  if (!['create', 'next', 'delete'].includes(action)) {
    pendingOperation = undefined
    try { sessionStorage.removeItem(operationKey) } catch { /* optional storage */ }
    return
  }
  if (!pendingOperation || pendingOperation.action !== action || pendingOperation.pageId !== pageId) {
    pendingOperation = { action, pageId, fromPageId: state?.activePageId ?? null, requestId: crypto.randomUUID() }
    try { sessionStorage.setItem(operationKey, JSON.stringify(pendingOperation)) } catch { /* Live retry still uses the same id. */ }
  }
  return pendingOperation
}
async function page(action: string, pageId?: string) {
  await releaseSurface()
  const pending = operation(action, pageId)
  notice(t('正在打开纸页并准备同步…', 'Opening the page and preparing sync…'))
  try {
    applyState(await request<SumiState>('page', pending ?? { action, pageId, fromPageId: state?.activePageId }))
    if (pending) { pendingOperation = undefined; try { sessionStorage.removeItem(operationKey) } catch { /* optional storage */ } }
  } catch (error) { await mountPage(); throw error }
  await closePanel(false)
  await mountPage(true)
}
async function focusOwnedPage(pageId: string) {
  if (!windowVisible || !surface || surfacePageId !== pageId) return
  await closePanel(false)
  await request('visible', { surface, visible: true })
  await request('focus', { surface })
}
async function openPanel(title: string) {
  if (surface) await request('visible', { surface, visible: false })
  panelOpen = true
  el('panel-title').textContent = title
  el('panel-body').replaceChildren()
  el('panel').hidden = false
  el('close').focus()
}
async function closePanel(focus = true) {
  panelOpen = false; el('panel').hidden = true
  if (surface && focus) { await request('visible', { surface, visible: true }); await request('focus', { surface }) }
}
async function showPages() {
  await refresh(); await openPanel(t('纸页', 'Pages'))
  if (state!.activePageId) {
    for (const [format, title] of [['archive', t('导出正文与逐行时间…', 'Export writing with line times…')], ['markdown', t('仅导出 Markdown 正文…', 'Export Markdown text only…')]]) {
      const button = document.createElement('button'); button.textContent = title
      button.onclick = () => void run(async () => {
        const result = await request<{ saved: boolean }>('export', { pageId: state!.activePageId, format })
        if (result.saved) notice(t('已导出。', 'Exported.'))
      })
      el('panel-body').append(button)
    }
    if (state!.saveState === 'projection-pending' || state!.saveState === 'error') {
      const repair = document.createElement('button'); repair.textContent = t('保留外部文件并重新写出此页', 'Preserve external files and restore this page')
      repair.onclick = () => void run(async () => {
        await releaseSurface()
        await request('restore_projection', { pageId: state!.activePageId })
        await refresh(); await mountPage(true); await showPages()
      })
      el('panel-body').append(repair)
    }
  }
  for (const deleted of [false, true]) {
    const pages = state!.pages.filter(page => page.deleted === deleted)
    if (!pages.length) continue
    const heading = document.createElement('h2'); heading.textContent = deleted ? t('废纸篓', 'Trash') : t('继续书写', 'Continue writing'); el('panel-body').append(heading)
    for (const item of pages) {
      const row = document.createElement('div'); row.className = 'page-row'
      const open = document.createElement('button'); open.textContent = pageLabel(item, t('空白的一页', 'A blank page')); open.className = 'page-open'
      open.onclick = () => void run(() => page(deleted ? 'restore' : 'open', item.id)); row.append(open)
      if (!deleted) {
        const trash = document.createElement('button'); trash.textContent = '×'; trash.title = t('移到废纸篓', 'Move to trash'); trash.setAttribute('aria-label', trash.title)
        trash.onclick = () => void run(async () => { await page('delete', item.id); await showPages() }); row.append(trash)
      }
      el('panel-body').append(row)
    }
  }
}
async function showAppearance() {
  await openPanel(t('外观', 'Appearance'))
  const form = document.createElement('form')
  const labels = { theme: t('配色', 'Colors'), fontFamily: t('字体', 'Font'), fontSize: t('字号', 'Font size'), lineHeight: t('行距', 'Line height'), maxColumns: t('正文宽度（半角列）', 'Width (half-width columns)'), bottomInset: t('底部留白', 'Bottom space') }
  for (const [key, label] of Object.entries(labels)) {
    const wrap = document.createElement('label'); const text = document.createElement('span'); text.textContent = label; wrap.append(text)
    const field = key === 'theme' ? document.createElement('select') : document.createElement('input')
    field.name = key
    if (field instanceof HTMLSelectElement) for (const [value, name] of [['ink', t('黑底白字', 'White on black')], ['dim', t('黑底灰字', 'Gray on black')], ['paper', t('白底黑字', 'Black on white')], ['sepia', t('米色深灰', 'Warm paper')]]) {
      const option = document.createElement('option'); option.value = value; option.textContent = name; field.append(option)
    }
    else { field.type = key === 'fontFamily' ? 'text' : 'number'; field.step = key === 'lineHeight' ? '0.1' : '1'; field.required = true }
    field.value = String(state!.preferences[key as keyof typeof labels]); wrap.append(field); form.append(wrap)
  }
  const submit = document.createElement('button'); submit.type = 'submit'; submit.textContent = t('应用', 'Apply'); form.append(submit)
  form.onsubmit = event => { event.preventDefault(); void run(async () => { applyState(await request<SumiState>('preferences', { preferences: preferencesFromForm(form) })); await closePanel() }) }
  el('panel-body').append(form)
}
async function showSync() {
  await refresh(); await openPanel(t('同步', 'Sync'))
  const status = document.createElement('p'); status.id = 'sync-status'; status.setAttribute('role', 'status'); status.textContent = syncStatusLabel(state!.sync.connected); el('panel-body').append(status)
  const form = document.createElement('form')
  for (const [name, title, type] of [['serviceUrl', t('同步服务地址', 'Sync service URL'), 'url'], ['invitation', t('设备配对码', 'Device pairing code'), 'password']]) {
    const label = document.createElement('label'); label.textContent = title
    const input = document.createElement('input'); input.name = name; input.type = type; input.required = true; input.autocomplete = 'off'; label.append(input); form.append(label)
  }
  const submit = document.createElement('button'); submit.textContent = t('连接', 'Connect'); submit.type = 'submit'; form.append(submit)
  form.onsubmit = event => { event.preventDefault(); void run(async () => { const data = new FormData(form); applyState(await request<SumiState>('pair', { serviceUrl: data.get('serviceUrl'), invitation: data.get('invitation') })); form.reset(); await closePanel() }) }
  el('panel-body').append(form)
  {
    const invite = document.createElement('button'); invite.id = 'sync-invite'; invite.hidden = !state!.sync.connected; invite.textContent = t('配对另一台设备', 'Pair another device')
    invite.onclick = () => void run(async () => { const result = await request<{ invitation: string }>('invite'); const output = document.createElement('textarea'); output.readOnly = true; output.value = result.invitation; output.setAttribute('aria-label', t('一次性配对码', 'One-time pairing code')); el('panel-body').append(output); output.select() })
    el('panel-body').append(invite)
  }
}
el('previous').onclick = () => void run(() => page('previous'))
el('next').onclick = () => void run(() => page('next'))
el('new').onclick = () => void run(() => page('create'))
el('pages').onclick = () => void run(showPages)
el('appearance').onclick = () => void run(showAppearance)
el('sync').onclick = () => void run(showSync)
function fullscreenLabel(active: boolean) {
  const button = el('fullscreen')
  button.title = active ? t('退出全屏（⌃⌘F）', 'Exit fullscreen (⌃⌘F)') : t('进入全屏（⌃⌘F）', 'Enter fullscreen (⌃⌘F)')
  button.setAttribute('aria-label', button.title)
  button.setAttribute('aria-pressed', String(active))
}
async function toggleFullscreen() {
  const result = await request<{ fullscreen: boolean }>('fullscreen')
  fullscreenLabel(result.fullscreen); scheduleBounds()
}
el('fullscreen').onclick = () => void run(toggleFullscreen)
el('close').onclick = () => void run(() => closePanel())
document.addEventListener('keydown', event => {
  if (!mounted) return
  if (event.metaKey && event.ctrlKey && event.key.toLowerCase() === 'f') {
    event.preventDefault(); void run(toggleFullscreen)
  } else if (event.key === 'Escape' && panelOpen) void run(() => closePanel())
})
function scheduleBounds() {
  clearTimeout(resizeTimer)
  resizeTimer = setTimeout(() => { if (surface) void request('bounds', { surface, bounds: bounds() }).catch(error => notice(String(error))) }, 30)
}
new ResizeObserver(() => {
  scheduleBounds()
  // System menus can also enter/leave fullscreen; read native window state.
  if (mounted) void request<{ fullscreen: boolean }>('fullscreen', { queryOnly: true })
    .then(result => { if (mounted) fullscreenLabel(result.fullscreen) }).catch(error => notice(String(error)))
}).observe(el('surface'))
window.addEventListener('pagehide', () => { mounted = false; generation++; clearTimeout(resizeTimer) })
window.notemd?.onMessage?.(event => {
  if (!event || typeof event !== 'object') return
  const message = event as { type?: string; state?: SumiState; action?: string; message?: string; payload?: unknown; visible?: boolean; detached?: boolean; pageId?: string }
  if (message.type === 'sumi-window-state' && typeof message.visible === 'boolean') {
    windowVisible = message.visible
    if (!windowVisible) {
      generation++; pendingWindowResume = false; pendingFocusPage = undefined
      if (message.detached) { surface = undefined; surfacePageId = undefined }
    } else {
      if (busy) pendingWindowResume = true
      else void run(async () => { await refresh(); await mountPage(true) })
    }
    return
  }
  if (message.type === 'sumi-focus-owner' && typeof message.pageId === 'string' && windowVisible) {
    if (busy) pendingFocusPage = message.pageId
    else void run(() => focusOwnedPage(message.pageId!))
    return
  }
  if (message.type === 'seed') {
    const navigation = navigationSeed(message.payload)
    if (navigation) {
      if (busy || !windowVisible) pendingNavigation = navigation
      else void run(() => navigateFromTab(navigation))
    }
  }
  if (message.type === 'sumi-error' && message.message) notice(message.message)
  if (message.type === 'sumi-state' && message.state) {
    if (busy) {
      if (!pendingState || (message.state.navigationVersion ?? 0) >= (pendingState.navigationVersion ?? 0)) pendingState = message.state
    }
    else void run(() => acceptState(message.state!))
  }
  if (message.type === 'sumi-action') {
    if (message.action === 'new_page') void run(() => page('create'))
    else if (message.action === 'previous_page') void run(() => page('previous'))
    else if (message.action === 'next_page') void run(() => page('next'))
    else if (message.action === 'menu') void run(showPages)
    else if (message.action === 'fullscreen') void run(toggleFullscreen)
  }
})
void run(async () => {
  await refresh()
  let seed: NavigationSeed | undefined
  try { seed = navigationSeed(JSON.parse(new URL(location.href).searchParams.get('seed') ?? 'null')) } catch { /* Ordinary launches have no seed. */ }
  if (seed && state?.available) await navigateFromTab(seed)
  else {
    if (state?.available && !state.activePageId) await page('create')
    else await mountPage(true)
  }
})
