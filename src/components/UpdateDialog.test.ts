// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'

const { state, capabilities, runCheck, downloadAndInstall, restartApp, dismissCurrent } = vi.hoisted(() => ({
  state: { state: 'idle', currentVersion: '6.1109.4', latestVersion: null as string | null, notes: null as string | null, downloaded: 0, contentLength: null as number | null, error: null as string | null },
  capabilities: { value: { distributionChannel: 'package-manager' } },
  runCheck: vi.fn(async () => {}), downloadAndInstall: vi.fn(async () => {}),
  restartApp: vi.fn(async () => {}), dismissCurrent: vi.fn(async () => {}),
}))
// Render the actual UI; mock only its updater service and desktop identity.
vi.mock('../lib/updater.svelte', () => ({ updater: state, runCheck, downloadAndInstall, restartApp, dismissCurrent }))
vi.mock('../lib/desktop-capabilities.svelte', () => ({ desktopCapabilities: capabilities }))
import UpdateDialog from './UpdateDialog.svelte'
import { i18n, t, type Locale } from '../lib/i18n/store.svelte'

let component: ReturnType<typeof mount> | undefined
beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(state, { state: 'idle', currentVersion: '6.1109.4', latestVersion: null, notes: null, downloaded: 0, contentLength: null, error: null })
  capabilities.value.distributionChannel = 'package-manager'
  i18n.locale = 'en'
})
afterEach(async () => {
  if (component) await unmount(component)
  component = undefined
  document.body.innerHTML = ''
})
function render() {
  component = mount(UpdateDialog, { target: document.body, props: { open: true } })
  flushSync()
}
function button(text: string) {
  const result = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === text)
  expect(result, `button ${text}`).toBeTruthy()
  return result!
}

describe('UpdateDialog checked state and package downloads', () => {
  it.each(['direct', 'package-manager'])('never labels idle as up to date on %s and offers an explicit fresh check', async channel => {
    capabilities.value.distributionChannel = channel
    render()
    expect(document.body.textContent).not.toContain(t('updateDialog.upToDate'))
    expect(document.body.textContent).toContain(t('updateDialog.notChecked'))
    button(t('settings.update.checkNow')).click()
    await Promise.resolve()
    expect(runCheck).toHaveBeenCalledWith({ forceFresh: true })
    expect(downloadAndInstall).not.toHaveBeenCalled()
  })
  it.each(['direct', 'package-manager'])('labels only a completed no-update result as up to date on %s', channel => {
    capabilities.value.distributionChannel = channel
    state.state = 'uptodate'
    render()
    expect(document.body.textContent).toContain(t('updateDialog.upToDate'))
    expect(document.body.textContent).not.toContain(t('updateDialog.notChecked'))
  })
  it.each<Locale>(['en', 'zh', 'ja', 'de'])('shows package-manager download guidance and download action in %s', async locale => {
    i18n.locale = locale
    Object.assign(state, { state: 'available', latestVersion: '6.1110.2', notes: 'Linux release notes' })
    render()
    const label = t('settings.update.viewDownloads', { version: '6.1110.2' })
    expect(label).not.toContain('settings.update.viewDownloads')
    expect(document.body.textContent).toContain(t('settings.update.packageManager'))
    expect(document.body.textContent).not.toContain('omarchy update')
    expect(document.body.textContent).not.toContain(t('updateDialog.updateNow'))
    button(label).click()
    await Promise.resolve()
    expect(downloadAndInstall).toHaveBeenCalledTimes(1)
    expect(restartApp).not.toHaveBeenCalled()
  })
  it('keeps the direct-channel update action', async () => {
    capabilities.value.distributionChannel = 'direct'
    Object.assign(state, { state: 'available', latestVersion: '6.1110.2' })
    render()
    expect(document.body.textContent).not.toContain(t('settings.update.packageManager'))
    button(t('updateDialog.updateNow')).click()
    await Promise.resolve()
    expect(downloadAndInstall).toHaveBeenCalledTimes(1)
  })
  it('shows network failure without claiming success or offering installation', () => {
    Object.assign(state, { state: 'error', error: 'Network unavailable' })
    render()
    expect(document.body.textContent).toContain('Network unavailable')
    expect(document.body.textContent).not.toContain(t('updateDialog.upToDate'))
    expect(downloadAndInstall).not.toHaveBeenCalled()
  })
})
