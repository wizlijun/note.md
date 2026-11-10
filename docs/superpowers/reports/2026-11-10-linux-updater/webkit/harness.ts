import { mockIPC, mockWindows } from '@tauri-apps/api/mocks'
import { mount, unmount, tick } from 'svelte'
const w = window as any
w.__TAURI_OS_PLUGIN_INTERNALS__ = { platform: 'linux', os_type: 'linux', arch: 'x86_64', family: 'unix', version: 'fixture', eol: '\n' }
const calls: any[] = [], stores = new Map<number, Map<string, any>>(), storePaths = new Map<string, number>()
let nextRid = 10, bodyRead = false, networkFault = false
const release = [{ draft: false, prerelease: false, tag_name: 'v6.1110.2', published_at: '2026-11-10T06:00:00Z', body: 'Verified Linux package-manager release fixture.', assets: [{ name: 'notemd-6.1110.2-1-x86_64.pkg.tar.zst', size: 15228959, state: 'uploaded', browser_download_url: 'https://github.com/wizlijun/note.md/releases/download/v6.1110.2/notemd-6.1110.2-1-x86_64.pkg.tar.zst' }] }]
mockIPC(async (cmd, args: any = {}) => {
  calls.push({ cmd, args: structuredClone(args) })
  if (cmd === 'desktop_capabilities') return { distributionChannel: 'package-manager', cliInstall: false, themeFontInstall: false, setDefaultApp: false, location: false, globalShortcuts: true, windowDecorations: true }
  if (cmd === 'plugin_market_host_triple') return 'x86_64-unknown-linux-gnu'
  if (cmd === 'plugin:app|version') return '6.1109.4'
  if (cmd === 'sotvault_vault_root') return '/isolated-updater-fixture/vault'
  if (cmd === 'plugin:store|load') {
    if (!storePaths.has(args.path)) {
      const rid = nextRid++; storePaths.set(args.path, rid)
      stores.set(rid, new Map(args.path.startsWith('linux-updater-') ? [['state', { check_on_startup: false, last_checked_at: null, latest_version_seen: null, dismissed_version: null }]] : []))
    }
    return storePaths.get(args.path)
  }
  if (cmd === 'plugin:store|get') { const value = stores.get(args.rid)?.get(args.key); return [value ?? null, value !== undefined] }
  if (cmd === 'plugin:store|set') { stores.get(args.rid)?.set(args.key, structuredClone(args.value)); return }
  if (cmd === 'plugin:store|save') return
  if (cmd === 'plugin:http|fetch') { bodyRead = false; return 900 }
  if (cmd === 'plugin:http|fetch_send') { await new Promise(r => setTimeout(r, 250)); return { status: networkFault ? 503 : 200, statusText: networkFault ? 'Unavailable' : 'OK', url: args.url ?? 'https://api.github.com/repos/wizlijun/note.md/releases', headers: [['content-type', 'application/json']], rid: 901 } }
  if (cmd === 'plugin:http|fetch_read_body') { if (bodyRead) return [1]; bodyRead = true; return [...new TextEncoder().encode(JSON.stringify(release)), 0] }
  if (cmd.startsWith('plugin:http|fetch_cancel')) return
  if (cmd === 'plugin:opener|open_url') return
  throw new Error(`No native host in isolated WebKit fixture: ${cmd}`)
}, { shouldMockEvents: true })
mockWindows('main')
function assert(value: unknown, message: string) { if (!value) throw Error(message) }
function post(value: unknown) { w.webkit.messageHandlers.evidence.postMessage(JSON.stringify(value)) }
function wait(ms: number) { return new Promise(r => setTimeout(r, ms)) }
async function until(predicate: () => boolean) { for (let i = 0; i < 200; i++) { if (predicate()) return; await wait(25) } throw Error('UI state timeout') }
function click(label: string) { const button = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === label); assert(button, `Missing button: ${label}`); button!.click() }
async function checkpoint(id: string, extra = {}) { await tick(); await wait(150); post({ id, text: document.body.innerText, ...extra }); await wait(300) }
try {
  await import('/src/styles/app.css')
  const { i18n } = await import('/src/lib/i18n/store.svelte.ts'); i18n.locale = 'en'
  const api = await import('/src/lib/updater.svelte.ts')
  const { default: UpdateDialog } = await import('/src/components/UpdateDialog.svelte')
  await api.initUpdater()
  let component = mount(UpdateDialog, { target: document.body, props: { open: true } })
  await tick(); await wait(100)
  assert(api.updater.state === 'idle', 'Startup preference should leave state idle')
  assert(document.body.innerText.includes('Updates have not been checked yet'), 'Idle must explain not checked')
  assert(!document.body.innerText.includes('note.md is up to date'), 'Idle must not claim up to date')
  await checkpoint('dialog-idle')
  click('Check for updates now')
  await until(() => api.updater.state === 'available')
  assert(document.body.innerText.includes('View downloads for v6.1110.2'), 'Package release action must say view downloads')
  assert(document.body.innerText.includes('Verified Linux package-manager release fixture.'), 'Release notes missing')
  await checkpoint('dialog-available')
  click('View downloads for v6.1110.2')
  await until(() => calls.some(c => c.cmd === 'plugin:opener|open_url'))
  assert(!calls.some(c => c.cmd.startsWith('plugin:updater|') || c.cmd === 'plugin:process|restart'), 'Package action must not invoke self-updater or restart')
  await unmount(component)
  const { default: SettingsDialog } = await import('/src/components/SettingsDialog.svelte')
  const { openSettings } = await import('/src/lib/ui-state.svelte.ts')
  component = mount(SettingsDialog, { target: document.body, props: { open: true } })
  openSettings('updates'); await tick(); await wait(500)
  assert(document.body.innerText.includes('Automatically check for updates on launch'), 'Package auto check control missing')
  assert(document.body.innerText.includes('View downloads for v6.1110.2'), 'Settings package action missing')
  assert(!document.body.innerText.includes('omarchy update'), 'Unbacked system upgrade claim remains')
  assert(!document.body.innerText.includes('Download and install v6.1110.2'), 'Package settings must not claim self-install')
  await checkpoint('settings-available')
  const checkbox = document.querySelector<HTMLInputElement>('input[type=checkbox]'); assert(checkbox, 'Missing automatic check checkbox'); checkbox!.click()
  await until(() => api.updater.checkOnStartup)
  networkFault = true; click('Check for updates now'); await until(() => api.updater.state === 'error')
  assert(document.body.innerText.includes('HTTP 503'), 'Network failure must be visible')
  assert(!document.body.innerText.includes('Up to date.'), 'Network failure must not claim latest')
  await checkpoint('settings-network-error')
  post({ id: 'complete', status: 'passed', state: { ...api.updater }, calls, storePaths: [...storePaths.keys()], scope: 'Production Svelte components and updater/Linux checker in real WebKitGTK; mocked Tauri IPC identity/store/native HTTP and opener. DOM click handlers, private compositor. No installation or physical desktop interaction.' })
} catch (error) { post({ id: 'failed', error: String(error), stack: (error as Error).stack, text: document.body.innerText, calls }) }
