import './style.css'
import { createI18n } from '../../../src/lib/sumi/i18n'
import { fontPresets, pageLabel, preferencesFromForm, type SumiState, type SurfaceHandle, type Bounds, type FontState, type SoundState } from './contract'

interface Bridge {
  locale?: string
  request(method: string, params?: unknown): Promise<unknown>
  onMessage?(handler: (event: unknown) => void): void
}
declare global { interface Window { notemd?: Bridge } }
const { locale, t, appName, hostMessage, fontName } = createI18n(window.notemd?.locale ?? navigator.language)
document.documentElement.lang = locale
document.title = appName
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T
let state: SumiState | undefined
let surface: SurfaceHandle | undefined
let surfacePageId: string | undefined
let pendingState: SumiState | undefined
type NavigationSeed = { kind: 'sumi-navigation'; pageId: string; action: 'new_page' | 'previous_page' | 'next_page' | 'menu' | 'open_page' | 'settings' | 'export' }
let pendingNavigation: NavigationSeed | undefined
function navigationSeed(value: unknown): NavigationSeed | undefined {
  if (!value || typeof value !== 'object') return
  const seed = value as NavigationSeed
  if (seed.kind === 'sumi-navigation' && typeof seed.pageId === 'string' && seed.pageId.length <= 128
    && ['new_page', 'previous_page', 'next_page', 'menu', 'open_page', 'settings', 'export'].includes(seed.action)) return seed
}
async function navigateFromTab(seed: NavigationSeed) {
  await page('open', seed.pageId)
  if (seed.action === 'open_page' || !surface) return
  if (seed.action === 'menu') await showPages()
  else if (seed.action === 'settings') await showAppearance()
  else if (seed.action === 'export') await exportSnapshot()
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
let fontPanel: { render(): void; poll(): Promise<void>; pause(): void; dispose(): void } | undefined
let soundPanel: { render(): void; read(): Promise<void>; pause(): void; dispose(): void } | undefined
function stopSoundPanel() { soundPanel?.dispose(); soundPanel = undefined }
function stopFontPanel() { fontPanel?.dispose(); fontPanel = undefined }

// User content is always assigned through textContent, never interpolated into markup.
el('app').innerHTML = `<main id="surface" aria-label="${appName}"></main>
<div id="notice-slot"><p id="notice" role="status" aria-live="polite" tabindex="-1" hidden></p><button id="retry-save" hidden></button></div>
<nav id="tools" aria-label="${appName}"><button id="previous">←</button><button id="next">→</button><button id="new">＋</button><button id="pages">☷</button><button id="appearance">Aa</button><button id="sync">⇄</button><button id="fullscreen">⛶</button></nav>
<section id="panel" hidden aria-modal="true" role="dialog" aria-labelledby="panel-title"><header><h1 id="panel-title"></h1><button id="close">×</button></header><div id="panel-body"></div></section>`
for (const [id, label] of Object.entries({ previous: t('上一页', 'Previous page', '前のページ'), next: t('下一页', 'Next page', '次のページ'), new: t('新的一页', 'New page', '新しいページ'), pages: t('纸页', 'Pages', 'ページ'), appearance: t('外观', 'Appearance', '外観'), sync: t('同步', 'Sync', '同期'), fullscreen: t('进入全屏（Cmd/Win/Super+Enter）', 'Enter fullscreen (Cmd/Win/Super+Enter)', 'フルスクリーンにする（Cmd/Win/Super+Enter）'), close: t('返回书写', 'Back to writing', '執筆に戻る') })) {
  el(id).title = label; el(id).setAttribute('aria-label', label)
}

async function request<T>(method: string, params?: unknown): Promise<T> {
  if (!window.notemd) throw new Error(t('请在 note.md 中打开玄霜打字机。', 'Open Sumi Typewriter inside note.md.', 'note.md からすみを開いてください。'))
  return await window.notemd.request(`host.sumi.${method}`, params) as T
}
function saveFailure() {
  return t('保存失败，文字已保留，可复制或重试保存。', 'Saving failed. Your draft is retained; copy it or retry saving.', '保存できませんでした。文章は保持されています。コピーするか保存を再試行してください。')
}
function notice(message = '', critical = false) {
  // Routine sync/export updates must not conceal a draft that is not safely saved.
  if (state?.saveState === 'error') { message = saveFailure(); critical = true }
  const output = el('notice')
  output.dataset.critical = String(critical)
  output.setAttribute('role', critical ? 'alert' : 'status')
  output.setAttribute('aria-live', critical ? 'assertive' : 'polite')
  output.textContent = message; output.hidden = !message; output.tabIndex = message ? 0 : -1
  el('retry-save').hidden = state?.saveState !== 'error'
  if (!message && document.activeElement === output) output.blur()
}
function bounds(): Bounds {
  const r = el('surface').getBoundingClientRect()
  return { x: r.x, y: r.y, width: r.width, height: r.height }
}
function syncStatusLabel(connected: boolean) {
  return connected ? t('已连接', 'Connected', '接続済み') : t('离线也可以继续书写。连接后自动合并。', 'Keep writing offline. Changes merge when reconnected.', 'オフラインでも執筆できます。再接続すると変更が自動的に統合されます。')
}
function applyState(next: SumiState) {
  if ((next.navigationVersion ?? 0) < (state?.navigationVersion ?? 0)) return
  state = next
  fontPanel?.render()
  document.documentElement.dataset.theme = next.preferences.theme
  el('sync').dataset.pending = String(next.sync.pending > 0)
  const syncStatus = document.getElementById('sync-status')
  if (syncStatus) syncStatus.textContent = syncStatusLabel(next.sync.connected)
  const invite = document.getElementById('sync-invite')
  if (invite) invite.hidden = !next.sync.connected
  notice(!next.available ? (next.reason ? hostMessage(next.reason) : t('此系统暂不支持原生写作。', 'Native writing is unavailable on this system.', 'このシステムではネイティブ編集を利用できません。'))
    : next.saveState === 'error' ? saveFailure()
      : next.saveState === 'projection-pending' ? t('文字已保存在本机，文件仍待写入。', 'Saved locally; file export is pending.', '文章はこの端末に保存されています。ファイルへの書き出しを待っています。')
        : hostMessage(next.sync.message ?? '', 'status'), !next.available || next.saveState === 'error')
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
  notice(t('正在打开纸页并准备同步…', 'Opening the page and preparing sync…', 'ページを開いて同期を準備中…'))
  const handle = await request<SurfaceHandle | { kind: 'existing_owner'; page_id: string }>('mount', { pageId, bounds: bounds() })
  // A successful native close has already flushed and detached every surface.
  if (!windowVisible) return
  if ('kind' in handle) {
    if (mounted && attempt === generation) {
      if (focusExisting) await request('focus_existing', { pageId: handle.page_id })
      notice(t('此页已在另一个编辑面中打开。', 'This page is open in another editor.', 'このページは別のエディタで開かれています。'))
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
  try { await action() } catch (error) { notice(hostMessage(error), true) }
  finally {
    busy = false
    for (const button of document.querySelectorAll<HTMLButtonElement>('button')) button.disabled = false
    fontPanel?.render(); soundPanel?.render()
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
  notice(t('正在打开纸页并准备同步…', 'Opening the page and preparing sync…', 'ページを開いて同期を準備中…'))
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
  if (surface) await request('visible', { surface, visible: false, preparePanel: true })
  stopFontPanel(); stopSoundPanel()
  panelOpen = true
  el('panel-title').textContent = title
  el('panel-body').replaceChildren()
  el('panel').insertBefore(el('notice'), el('panel-body'))
  el('panel').hidden = false
  el('close').focus()
}
async function closePanel(focus = true) {
  stopFontPanel(); stopSoundPanel()
  panelOpen = false; el('panel').hidden = true
  el('notice-slot').append(el('notice'))
  if (surface && focus) { await request('visible', { surface, visible: true }); await request('focus', { surface }) }
}
async function exportSnapshot() {
  if (!state?.activePageId) return
  const result = await request<{ saved: boolean }>('export', { pageId: state.activePageId, format: 'archive' })
  if (result.saved) notice(t('已导出。', 'Exported.', '書き出しました。'))
}
async function writingAction(action?: string) {
  if (!windowVisible) return
  if (action === 'new_page') await page('create')
  else if (action === 'previous_page') await page('previous')
  else if (action === 'next_page') await page('next')
  else if (action === 'menu') await showPages()
  else if (action === 'settings') await showAppearance()
  else if (action === 'export') await exportSnapshot()
  else if (action === 'fullscreen') await toggleFullscreen()
  else if (action && ['save', 'close', 'zoom_in', 'zoom_out', 'zoom_reset'].includes(action)) await request('command', { action })
}
async function showPages() {
  await refresh(); await openPanel(t('纸页', 'Pages', 'ページ'))
  if (state!.activePageId) {
    for (const [format, title] of [['archive', t('导出正文与逐行时间…', 'Export writing with line times…', '本文と行ごとの日時を書き出す…')], ['markdown', t('仅导出 Markdown 正文…', 'Export Markdown text only…', 'Markdown 本文のみを書き出す…')]]) {
      const button = document.createElement('button'); button.textContent = title
      button.onclick = () => void run(async () => {
        const result = await request<{ saved: boolean }>('export', { pageId: state!.activePageId, format })
        if (result.saved) notice(t('已导出。', 'Exported.', '書き出しました。'))
      })
      el('panel-body').append(button)
    }
    if (state!.saveState === 'projection-pending' || state!.saveState === 'error') {
      const repair = document.createElement('button'); repair.textContent = t('保留外部文件并重新写出此页', 'Preserve external files and restore this page', '外部ファイルを保持してこのページを書き出し直す')
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
    const heading = document.createElement('h2'); heading.textContent = deleted ? t('废纸篓', 'Trash', 'ゴミ箱') : t('继续书写', 'Continue writing', '執筆を続ける'); el('panel-body').append(heading)
    for (const item of pages) {
      const row = document.createElement('div'); row.className = 'page-row'
      const open = document.createElement('button'); open.textContent = pageLabel(item, t('空白的一页', 'A blank page', '白紙のページ')); open.className = 'page-open'
      open.onclick = () => void run(() => page(deleted ? 'restore' : 'open', item.id)); row.append(open)
      if (!deleted) {
        const trash = document.createElement('button'); trash.textContent = '×'; trash.title = t('移到废纸篓', 'Move to trash', 'ゴミ箱に移動'); trash.setAttribute('aria-label', trash.title)
        trash.onclick = () => void run(async () => { await page('delete', item.id); await showPages() }); row.append(trash)
      }
      el('panel-body').append(row)
    }
  }
}
function showFonts(form: HTMLFormElement) {
  const section = document.createElement('section'); section.className = 'font-list'; section.setAttribute('aria-label', t('字体', 'Fonts', 'フォント'))
  const heading = document.createElement('h2'); heading.textContent = t('字体', 'Fonts', 'フォント'); section.append(heading)
  const summary = document.createElement('p'); summary.id = 'font-list-status'; summary.setAttribute('role', 'status'); section.append(summary)
  const rows = fontPresets.map(([family, name]) => {
    const displayName = fontName(family, name)
    const button = document.createElement('button'); button.type = 'button'; button.className = 'font-option'; button.dataset.font = family
    const title = document.createElement('span'); title.className = 'font-name'; title.textContent = displayName
    const detail = document.createElement('span'); detail.className = 'font-detail'
    const progress = document.createElement('progress'); progress.hidden = true; progress.setAttribute('aria-label', displayName + t('下载进度', ' download progress', 'のダウンロード状況'))
    button.append(title, detail, progress); section.append(button)
    button.onclick = () => void select(family)
    return { family, button, detail, progress }
  })
  form.append(section)
  let snapshot: FontState | undefined
  let statusError = ''
  let active = true
  let timer: ReturnType<typeof setTimeout> | undefined
  let revision = 0
  let selection = 0
  const selecting = new Set<string>()
  const errors = new Map<string, string>()
  const valid = () => active && mounted && windowVisible && panelOpen && section.isConnected
  function pause() { clearTimeout(timer); revision++ }
  function schedule() {
    clearTimeout(timer)
    if (valid() && (statusError || selecting.size || snapshot?.pendingFont || snapshot?.fonts.some(font => font.status === 'downloading'))) {
      timer = setTimeout(() => void poll(), 750)
    }
  }
  function render() {
    if (!valid()) return
    const selected = state?.preferences.fontFamily
    const current = snapshot?.fonts.find(font => font.family === selected)
    summary.textContent = statusError || (!snapshot ? t('正在检查本机字体…', 'Checking downloaded fonts…', 'ダウンロード済みのフォントを確認中…')
      : current?.status !== 'ready' ? t('当前使用系统字体。点击所需字体后下载，可返回继续书写。', 'Using system fonts for now. Choose a font to download; you can keep writing.', '現在はシステムフォントを使用しています。フォントを選ぶとダウンロードが始まります。執筆に戻って続けられます。')
        : t('字体下载后保存在本机，可离线使用。', 'Downloaded fonts are saved on this device for offline use.', 'ダウンロードしたフォントはこの端末に保存され、オフラインでも使用できます。'))
    for (const { family, button, detail, progress } of rows) {
      const font = snapshot?.fonts.find(item => item.family === family)
      const pending = selecting.has(family)
      const queued = snapshot?.pendingFont === family
      const downloading = font?.status === 'downloading'
      const selectedHere = family === selected
      const message = errors.get(family) || (font?.error ? hostMessage(font.error) : '')
      const size = font?.totalBytes ? `${(font.totalBytes / 1_000_000).toFixed(1)} MB` : ''
      const percent = font?.totalBytes ? Math.min(100, Math.floor(font.downloadedBytes / font.totalBytes * 100)) : 0
      const label = pending ? t('正在开始…', 'Starting…', '開始中…')
        : downloading ? `${t('下载中', 'Downloading', 'ダウンロード中')} ${percent}%${snapshot?.pendingFont === family ? t(' · 完成后使用', ' · Use when ready', ' · 完了後に使用') : ''}`
          : message ? `${t('下载失败，点击重试', 'Download failed; click to retry', 'ダウンロード失敗。クリックして再試行')} · ${message}`
            : queued ? font?.status === 'ready' ? t('正在应用…', 'Applying…', '適用中…') : t('准备下载…', 'Preparing download…', 'ダウンロードを準備中…')
              : font?.status === 'ready' ? selectedHere ? t('使用中', 'In use', '使用中') : t('已下载，点击使用', 'Downloaded; click to use', 'ダウンロード済み。クリックして使用')
              : t('未下载，点击下载', 'Not downloaded; click to download', '未ダウンロード。クリックしてダウンロード')
      detail.textContent = [size, label].filter(Boolean).join(' · ')
      button.setAttribute('aria-pressed', String(selectedHere))
      button.setAttribute('aria-busy', String(pending || downloading || queued))
      button.disabled = busy || pending || queued
      progress.hidden = !downloading
      progress.max = font?.totalBytes || 1; progress.value = Math.min(font?.downloadedBytes || 0, progress.max)
    }
  }
  function accept(next: FontState) {
    snapshot = next; statusError = ''
    for (const font of next.fonts) if (font.status === 'downloading' || font.status === 'ready') errors.delete(font.family)
    render()
  }
  async function poll() {
    if (!valid()) return
    if (selecting.size) { schedule(); return }
    const attempt = ++revision
    try {
      const next = await request<FontState>('fonts')
      if (valid() && revision === attempt) accept(next)
    } catch {
      if (valid() && revision === attempt) { statusError = t('无法读取字体状态，将自动重试。', 'Unable to read font status. Retrying.', 'フォントの状態を取得できません。自動的に再試行します。'); render() }
    } finally { if (valid() && revision === attempt) schedule() }
  }
  async function select(family: string) {
    if (!valid() || busy || selecting.has(family)) return
    if (snapshot?.pendingFont === family) return
    pause(); const attempt = ++selection
    selecting.add(family); errors.delete(family); render()
    try {
      const next = await request<FontState>('font_select', { fontFamily: family })
      if (valid() && selection === attempt) accept(next)
    } catch (error) {
      if (valid() && selection === attempt) errors.set(family, hostMessage(error))
    } finally {
      selecting.delete(family)
      if (valid()) { render(); schedule() }
    }
  }
  fontPanel = { render, poll, pause, dispose() { active = false; pause() } }
}
function showSounds(form: HTMLFormElement) {
  const section = document.createElement('section'); section.className = 'sound-settings'; section.setAttribute('aria-label', t('键盘音效', 'Typing sounds', '打鍵音'))
  const heading = document.createElement('h2'); heading.textContent = section.getAttribute('aria-label'); section.append(heading)
  const toggleLabel = document.createElement('label'); toggleLabel.className = 'sound-toggle'
  const toggle = document.createElement('input'); toggle.type = 'checkbox'; toggle.id = 'sound-enabled'
  toggleLabel.append(toggle, t('启用键盘音效', 'Enable typing sounds', '打鍵音を有効にする')); section.append(toggleLabel)
  const presetLabel = document.createElement('label'); presetLabel.append(t('音色', 'Sound', '音色'))
  const preset = document.createElement('select'); preset.id = 'sound-preset'
  for (const [value, label] of [['typewriter', t('打字机', 'Typewriter', 'タイプライター')], ['thock', t('低沉机械键', 'Thock', '低音メカニカル')]]) {
    const option = document.createElement('option'); option.value = value; option.textContent = label; preset.append(option)
  }
  presetLabel.append(preset); section.append(presetLabel)
  const hint = document.createElement('p'); hint.textContent = t('仅在此应用的正文编辑器获得焦点时播放，支持中文等输入法。', 'Plays only while this app’s writing editor has focus, including when using an input method.', 'このアプリの本文エディタにフォーカスがある時だけ再生します。日本語や中国語の入力にも対応します。'); section.append(hint)
  const status = document.createElement('p'); status.id = 'sound-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); section.append(status)
  const permission = document.createElement('button'); permission.type = 'button'; permission.id = 'sound-permission'; permission.textContent = t('允许输入监控', 'Allow Input Monitoring', '入力監視を許可'); section.append(permission)
  const retry = document.createElement('button'); retry.type = 'button'; retry.id = 'sound-retry'; retry.textContent = t('重试', 'Retry', '再試行'); section.append(retry)
  form.append(section)
  let snapshot: SoundState | undefined
  let active = true, pending = false, revision = 0, failure = ''
  let retryAction: (() => Promise<void>) | undefined
  const valid = () => active && mounted && windowVisible && panelOpen && section.isConnected
  function render() {
    if (!valid()) return
    section.setAttribute('aria-busy', String(pending))
    toggle.disabled = preset.disabled = busy || pending || !snapshot
    permission.disabled = retry.disabled = busy || pending
    toggle.checked = snapshot?.enabled ?? false; preset.value = snapshot?.preset ?? 'typewriter'
    permission.hidden = snapshot?.permission !== 'required'
    retry.hidden = !failure && !snapshot?.error
    status.textContent = failure || (pending ? t('正在更新音效设置…', 'Updating sound settings…', '打鍵音の設定を更新中…')
      : !snapshot ? t('正在读取音效设置…', 'Loading sound settings…', '打鍵音の設定を読み込み中…')
      : snapshot.error ? hostMessage(snapshot.error)
      : snapshot.status === 'off' ? t('音效已关闭。', 'Typing sounds are off.', '打鍵音はオフです。')
      : snapshot.status === 'permission_required' ? t('需要输入监控权限才能播放音效。', 'Input Monitoring permission is required to play typing sounds.', '打鍵音を再生するには入力監視の許可が必要です。')
      : snapshot.status === 'unavailable' ? t('此系统暂时无法播放键盘音效。', 'Typing sounds are unavailable on this system.', 'このシステムでは打鍵音を利用できません。')
      : t('音效已就绪。', 'Typing sounds are ready.', '打鍵音を再生できます。'))
  }
  async function perform(method: string, params: object, again: () => Promise<void>) {
    if (!valid() || pending) return
    pending = true; failure = ''; const attempt = ++revision; render()
    try {
      const next = await request<SoundState>(method, params)
      if (valid() && revision === attempt) { snapshot = next; retryAction = undefined }
    } catch (error) {
      if (valid() && revision === attempt) {
        failure = t('音效设置操作失败，请重试。', 'Unable to update sound settings. Try again.', '打鍵音の設定を更新できません。再試行してください。') + ' ' + hostMessage(error)
        retryAction = again
      }
    } finally { if (valid() && revision === attempt) { pending = false; render() } }
  }
  async function read() { await perform('sound_state', {}, read) }
  async function save(enabled: boolean, selected: SoundState['preset']) { await perform('sound_set', { enabled, preset: selected }, () => save(enabled, selected)) }
  async function grant() { await perform('sound_request_permission', {}, grant) }
  toggle.onchange = () => { if (snapshot && !busy && !pending) void save(toggle.checked, snapshot.preset) }
  preset.onchange = () => { if (snapshot && !busy && !pending) void save(snapshot.enabled, preset.value as SoundState['preset']) }
  permission.onclick = () => { if (!busy) void grant() }
  retry.onclick = () => { if (!busy) void (retryAction ?? read)() }
  function pause() { revision++; pending = false }
  soundPanel = { render, read, pause, dispose() { active = false; pause() } }
}
async function showAppearance() {
  await openPanel(t('外观', 'Appearance', '外観'))
  const form = document.createElement('form')
  const labels = { theme: t('配色', 'Colors', '配色'), caretMotion: t('光标效果', 'Caret', 'カーソル'), fontSize: t('字号', 'Font size', '文字サイズ'), lineHeight: t('行距', 'Line height', '行の高さ'), maxColumns: t('正文宽度（半角列）', 'Width (half-width columns)', '本文の幅（半角文字数）'), bottomInset: t('额外底部留白', 'Extra bottom space', '下部の追加余白') }
  for (const [key, label] of Object.entries(labels)) {
    const wrap = document.createElement('label'); const text = document.createElement('span'); text.textContent = label; wrap.append(text)
    const field = key === 'theme' || key === 'caretMotion' ? document.createElement('select') : document.createElement('input')
    field.name = key
    if (field instanceof HTMLSelectElement) {
      const choices: readonly (readonly [string, string])[] = key === 'caretMotion' ? [['breathing', t('平缓呼吸', 'Gentle breathing', 'ゆっくり明滅')], ['steady', t('不闪烁（常亮）', 'Steady (no blinking)', '点滅なし（常時表示）')]]
        : [['ink', t('黑底白字', 'White on black', '黒地に白文字')], ['dim', t('黑底灰字', 'Gray on black', '黒地にグレー文字')], ['paper', t('白底黑字', 'Black on white', '白地に黒文字')], ['sepia', t('米色深灰', 'Warm paper', '生成り色に濃いグレー')], ['crt', t('复古绿磷 CRT', 'Retro Green Phosphor CRT', 'レトログリーン蛍光 CRT')], ['crt-blue', t('复古蓝磷 CRT', 'Retro Blue Phosphor CRT', 'レトロブルー蛍光 CRT')]]
      for (const [value, name] of choices) {
        const option = document.createElement('option'); option.value = value; option.textContent = name; field.append(option)
      }
    }
    else { field.type = 'number'; field.step = key === 'lineHeight' ? '0.1' : '1'; field.required = true }
    field.value = String(state!.preferences[key as keyof typeof labels]); wrap.append(field); form.append(wrap)
    if (key === 'theme') showFonts(form)
  }
  const focusLabel = document.createElement('label'); focusLabel.className = 'focus-toggle'
  const focusText = document.createElement('span'); focusText.textContent = t('聚焦打字', 'Focused typing', '集中タイピング')
  const focus = document.createElement('input'); focus.type = 'checkbox'; focus.name = 'focusTyping'; focus.checked = state!.preferences.focusTyping ?? true
  focus.setAttribute('aria-describedby', 'focus-typing-hint')
  focusLabel.append(focusText, focus); form.append(focusLabel)
  const focusHint = document.createElement('p'); focusHint.id = 'focus-typing-hint'
  focusHint.textContent = t('空白页从中线开始；聚焦时上下移动光标，当前行仍居中。停笔10秒后上下文逐渐显现，重新打字快速恢复渐隐。字号与行距不变。', 'Blank pages start at the center. Up/Down keeps the active line centered while focused. After 10 seconds without typing, context gradually reappears; typing restores the fade. Font size and line spacing stay unchanged.', '空白のページは中央から書き始めます。集中表示中は上下キーで移動しても現在の行を中央に保ちます。10秒入力しないと前後の文章がゆっくり現れ、入力を再開すると素早く薄くなります。文字サイズと行間は変わりません。')
  form.append(focusHint)
  showSounds(form)
  const submit = document.createElement('button'); submit.type = 'submit'; submit.textContent = t('应用', 'Apply', '適用'); form.append(submit)
  form.onsubmit = event => { event.preventDefault(); void run(async () => { applyState(await request<SumiState>('preferences', { preferences: preferencesFromForm(form, state!.preferences.fontFamily), preserveFont: true })); await closePanel() }) }
  el('panel-body').append(form)
  fontPanel?.render(); void fontPanel?.poll(); soundPanel?.render(); void soundPanel?.read()
}
async function showSync() {
  await refresh(); await openPanel(t('同步', 'Sync', '同期'))
  const status = document.createElement('p'); status.id = 'sync-status'; status.setAttribute('role', 'status'); status.textContent = syncStatusLabel(state!.sync.connected); el('panel-body').append(status)
  const form = document.createElement('form')
  for (const [name, title, type] of [['serviceUrl', t('同步服务地址', 'Sync service URL', '同期サービスの URL'), 'url'], ['invitation', t('设备配对码', 'Device pairing code', '端末のペアリングコード'), 'password']]) {
    const label = document.createElement('label'); label.textContent = title
    const input = document.createElement('input'); input.name = name; input.type = type; input.required = true; input.autocomplete = 'off'; label.append(input); form.append(label)
  }
  const submit = document.createElement('button'); submit.textContent = t('连接', 'Connect', '接続'); submit.type = 'submit'; form.append(submit)
  form.onsubmit = event => { event.preventDefault(); void run(async () => { const data = new FormData(form); applyState(await request<SumiState>('pair', { serviceUrl: data.get('serviceUrl'), invitation: data.get('invitation') })); form.reset(); await closePanel() }) }
  el('panel-body').append(form)
  {
    const invite = document.createElement('button'); invite.id = 'sync-invite'; invite.hidden = !state!.sync.connected; invite.textContent = t('配对另一台设备', 'Pair another device', '別の端末をペアリング')
    invite.onclick = () => void run(async () => { const result = await request<{ invitation: string }>('invite'); const output = document.createElement('textarea'); output.readOnly = true; output.value = result.invitation; output.setAttribute('aria-label', t('一次性配对码', 'One-time pairing code', 'ワンタイムペアリングコード')); el('panel-body').append(output); output.select() })
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
  button.title = active ? t('退出全屏（Cmd/Win/Super+Enter）', 'Exit fullscreen (Cmd/Win/Super+Enter)', 'フルスクリーンを解除（Cmd/Win/Super+Enter）') : t('进入全屏（Cmd/Win/Super+Enter）', 'Enter fullscreen (Cmd/Win/Super+Enter)', 'フルスクリーンにする（Cmd/Win/Super+Enter）')
  button.setAttribute('aria-label', button.title)
  button.setAttribute('aria-pressed', String(active))
}
async function toggleFullscreen() {
  const result = await request<{ fullscreen: boolean }>('fullscreen')
  fullscreenLabel(result.fullscreen); scheduleBounds()
}
el('fullscreen').onclick = () => void run(toggleFullscreen)
el('close').onclick = () => void run(() => closePanel())
el('retry-save').textContent = t('重试保存', 'Retry saving', '保存を再試行')
el('retry-save').onclick = () => void run(async () => { await request('command', { action: 'save' }); await refresh() })
document.addEventListener('keydown', event => {
  if (!mounted || event.isComposing) return
  const fullscreen = event.metaKey && !event.altKey && !event.shiftKey && (
    (!event.ctrlKey && event.key === 'Enter') ||
    (event.ctrlKey && event.key.toLowerCase() === 'f')
  )
  if (fullscreen) {
    event.preventDefault()
    if (!event.repeat) void run(toggleFullscreen)
  } else if (event.key === 'Escape' && panelOpen) void run(() => closePanel())
})
function scheduleBounds() {
  clearTimeout(resizeTimer)
  resizeTimer = setTimeout(() => { if (surface) void request('bounds', { surface, bounds: bounds() }).catch(error => notice(hostMessage(error), true)) }, 30)
}
new ResizeObserver(() => {
  scheduleBounds()
  // System menus can also enter/leave fullscreen; read native window state.
  if (mounted) void request<{ fullscreen: boolean }>('fullscreen', { queryOnly: true })
    .then(result => { if (mounted) fullscreenLabel(result.fullscreen) }).catch(error => notice(hostMessage(error), true))
}).observe(el('surface'))
window.addEventListener('pagehide', () => { mounted = false; generation++; clearTimeout(resizeTimer); stopFontPanel(); stopSoundPanel() })
window.notemd?.onMessage?.(event => {
  if (!event || typeof event !== 'object') return
  const message = event as { type?: string; state?: SumiState; action?: string; message?: string; payload?: unknown; visible?: boolean; detached?: boolean; pageId?: string }
  if (message.type === 'sumi-window-state' && typeof message.visible === 'boolean') {
    windowVisible = message.visible
    if (!windowVisible) {
      fontPanel?.pause(); soundPanel?.pause()
      generation++; pendingWindowResume = false; pendingFocusPage = undefined
      if (message.detached) { surface = undefined; surfacePageId = undefined }
    } else {
      void fontPanel?.poll(); void soundPanel?.read()
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
  if (message.type === 'sumi-error' && message.message) notice(hostMessage(message.message), true)
  if (message.type === 'sumi-state' && message.state) {
    if (busy) {
      if (!pendingState || (message.state.navigationVersion ?? 0) >= (pendingState.navigationVersion ?? 0)) pendingState = message.state
    }
    else void run(() => acceptState(message.state!))
  }
  if (message.type === 'sumi-action') void run(() => writingAction(message.action))
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
