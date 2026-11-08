// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, unmount, tick } from 'svelte'
import { i18n } from '../lib/i18n/runtime.svelte'
import NativeFileView from './NativeFileView.svelte'
import { SumiExistingOwnerError } from '../lib/sumi/session'
import type { Tab } from '../lib/tabs.svelte'
const mocks = vi.hoisted(() => ({ open: vi.fn(), mount: vi.fn(), focus: vi.fn(), handlers: new Map<string, (event: {payload: unknown}) => void>(), close: vi.fn(), prepare: vi.fn(), mode: vi.fn(), invoke: vi.fn(), release: vi.fn(), error: vi.fn(), confirm: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async (name: string, handler: (event: {payload: unknown}) => void) => { mocks.handlers.set(name, handler); return () => mocks.handlers.delete(name) }) }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ innerSize: async () => ({width: 800,height:600}), scaleFactor: async () => 1 }) }))
vi.mock('../lib/tabs.svelte', () => ({ acceptSumiSnapshot: vi.fn(), acknowledgeSumiProjection: vi.fn(), prepareFileViewTransition: mocks.prepare, closeTab: mocks.close, setMode: mocks.mode }))
vi.mock('../lib/dialogs', () => ({ confirmDirtyClose: mocks.confirm, showError: mocks.error }))
vi.mock('../lib/sumi/geometry', () => ({ boundsForNative: () => ({x:0,y:0,width:800,height:600}), nativeSurfaceOccluded: () => false }))
vi.mock('../lib/sumi/session', () => ({ SumiExistingOwnerError: class extends Error { constructor(readonly pageId: string) { super('此页已在另一个编辑面中打开') } }, openSumiOwner: mocks.open, closeSumiOwner: mocks.release, focusExistingSumiPage: mocks.focus, mountSumiOwner: mocks.mount, detachSumiSurface: vi.fn(async()=>{}), updateSumiSurface: vi.fn(async()=>{}) }))
vi.mock('./SumiRecovery.svelte', () => ({default: () => ({})}))
let component: ReturnType<typeof mount> | undefined
let tab: Tab
async function settle() { for(let i=0;i<25;i++){await Promise.resolve();await tick()} }
function action(action: string, page_id='paper-a', tab_id='tab-a') { mocks.handlers.get('sumi-action')!({payload:{page_id,tab_id,action}}) }
beforeEach(async () => {
  i18n.locale = 'zh'
  vi.clearAllMocks();mocks.handlers.clear();
  mocks.open.mockReset().mockResolvedValue({pageId:'paper-a',tabId:'tab-a'})
  mocks.mount.mockReset().mockResolvedValue({surfaceId:'surface',generation:1})
  vi.stubGlobal('ResizeObserver',class {observe(){}disconnect(){}})
  vi.stubGlobal('requestAnimationFrame',()=>1);vi.stubGlobal('cancelAnimationFrame',()=>{})
  tab={id:'tab-a',filePath:'/vault/a.writing.md',mode:'rich',initialContent:''} as Tab
  mocks.prepare.mockResolvedValue(undefined);mocks.close.mockResolvedValue(true);mocks.release.mockResolvedValue(undefined)
  mocks.mode.mockImplementation(async (_id,mode) => {tab.mode=mode})
  component=mount(NativeFileView,{target:document.body,props:{tab,view:{pluginId:'notemd.sumi',viewId:'writing',entry:'ui/main.js',icon:'book',surface:'native-editor'}}})
  await settle();mocks.prepare.mockClear()
})
afterEach(async()=>{if(component)await unmount(component);component=undefined;document.body.innerHTML='';vi.unstubAllGlobals()})
describe('native focused action routing',()=>{
  it('closes exactly its own tab and never another page or owner',async()=>{
    action('close','other');action('close','paper-a','other-tab');await settle();expect(mocks.close).not.toHaveBeenCalled()
    action('close');await settle();expect(mocks.close).toHaveBeenCalledWith('tab-a',mocks.confirm)
    expect(mocks.invoke).not.toHaveBeenCalled()
  })
  it('preserves the original editor on a rejected transition',async()=>{
    mocks.prepare.mockRejectedValueOnce(new Error('composition active'))
    action('settings');await settle()
    expect(mocks.release).not.toHaveBeenCalled();expect(mocks.invoke).not.toHaveBeenCalled();expect(mocks.error).toHaveBeenCalledWith('请先完成输入法组合')
  })
  it('flushes and closes its owner before a settings/export seed can open the writing window',async()=>{
    action('export');await settle()
    expect(mocks.prepare).toHaveBeenCalledWith('tab-a');expect(mocks.mode).toHaveBeenCalledWith('tab-a','source')
    expect(mocks.release).toHaveBeenCalledWith('tab-a')
    expect(mocks.invoke).toHaveBeenCalledWith('plugin_v2_open_window',{pluginId:'notemd.sumi',windowId:'main',seed:{kind:'sumi-navigation',pageId:'paper-a',action:'export'}})
    expect(mocks.release.mock.invocationCallOrder[0]).toBeLessThan(mocks.invoke.mock.invocationCallOrder[0])
  })
  it('reports a failed close and leaves the current owner intact',async()=>{
    mocks.close.mockRejectedValueOnce(new Error('disk unavailable'));action('close');await settle()
    expect(mocks.error).toHaveBeenCalledWith('操作未完成。 详细信息：disk unavailable');expect(mocks.release).not.toHaveBeenCalled()
  })
})

describe('native writing view localization', () => {
  async function remount() {
    if (component) await unmount(component)
    component = mount(NativeFileView, { target: document.body, props: { tab, view: { pluginId: 'notemd.sumi', viewId: 'writing', entry: 'ui/main.js', icon: 'book', surface: 'native-editor' } } })
    await settle()
  }
  it('updates the loading name without opening or mounting the native editor again', async () => {
    mocks.open.mockImplementationOnce(() => new Promise(() => {}))
    await remount()
    expect(document.body.textContent).toContain('正在打开玄霜打字机')
    const opens = mocks.open.mock.calls.length, mounts = mocks.mount.mock.calls.length
    i18n.locale = 'ja'; await settle()
    expect(document.body.textContent).toContain('すみを開いています')
    i18n.locale = 'en'; await settle()
    expect(document.body.textContent).toContain('Opening Sumi Typewriter')
    expect(mocks.open).toHaveBeenCalledTimes(opens)
    expect(mocks.mount).toHaveBeenCalledTimes(mounts)
    expect(mocks.invoke).not.toHaveBeenCalled()
  })
  it('translates errors and source controls while retaining diagnostic details without new IPC', async () => {
    const detail = 'EIO /vault/原稿/すみ.writing.md #93'
    mocks.open.mockRejectedValueOnce(new Error(detail))
    await remount()
    expect(document.body.textContent).toContain('玄霜打字机 暂时无法打开')
    expect(document.body.textContent).toContain('查看 Markdown 源码')
    const opens = mocks.open.mock.calls.length
    i18n.locale = 'ja'; await settle()
    expect(document.body.textContent).toContain('すみを現在開けません')
    expect(document.body.textContent).toContain('Markdown ソースを表示')
    expect(document.body.textContent).toContain(detail)
    i18n.locale = 'de'; await settle()
    expect(document.body.textContent).toContain('Sumi Typewriter cannot open right now')
    expect(document.body.textContent).toContain('View Markdown source')
    expect(document.body.textContent).toContain(detail)
    expect(mocks.open).toHaveBeenCalledTimes(opens)
    expect(mocks.invoke).not.toHaveBeenCalled()
  })
  it('translates the existing-owner state without refocusing on language changes', async () => {
    mocks.open.mockRejectedValueOnce(new SumiExistingOwnerError('paper-a'))
    await remount()
    expect(document.body.textContent).toContain('聚焦已有编辑面')
    expect(mocks.focus).toHaveBeenCalledWith('paper-a', 'notemd.sumi')
    i18n.locale = 'en'; await settle()
    expect(document.body.textContent).toContain('This page is open in another editor.')
    expect(document.body.textContent).toContain('Focus the existing editor')
    i18n.locale = 'ja'; await settle()
    expect(document.body.textContent).toContain('開いている編集画面へ移動')
    expect(document.body.textContent).not.toContain('此页已在另一个编辑面中打开')
    expect(mocks.focus).toHaveBeenCalledTimes(1)
    expect(mocks.invoke).not.toHaveBeenCalled()
  })
  it('keeps a failed save visible across locale switches without changing the draft', async () => {
    tab.initialContent = '原稿：English 日本語 — 保持原文'
    mocks.handlers.get('sumi-state')!({ payload: { page_id: 'paper-a', error: 'EIO /vault/原稿.md', durable: false } })
    await settle()
    expect(document.body.textContent).toContain('当前草稿已保留')
    i18n.locale = 'en'; await settle()
    expect(document.body.textContent).toContain('your current draft is preserved')
    i18n.locale = 'ja'; await settle()
    expect(document.body.textContent).toContain('現在の下書きは保持されています')
    expect(document.body.textContent).toContain('EIO /vault/原稿.md')
    expect(mocks.open).toHaveBeenCalledTimes(1)
    expect(mocks.invoke).not.toHaveBeenCalled()
    expect(tab.mode).toBe('rich')
    expect(tab.initialContent).toBe('原稿：English 日本語 — 保持原文')
  })
})
