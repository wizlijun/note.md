// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, unmount, tick } from 'svelte'
import NativeFileView from './NativeFileView.svelte'
import type { Tab } from '../lib/tabs.svelte'
const mocks = vi.hoisted(() => ({ handlers: new Map<string, (event: {payload: unknown}) => void>(), close: vi.fn(), prepare: vi.fn(), mode: vi.fn(), invoke: vi.fn(), release: vi.fn(), error: vi.fn(), confirm: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async (name: string, handler: (event: {payload: unknown}) => void) => { mocks.handlers.set(name, handler); return () => mocks.handlers.delete(name) }) }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ innerSize: async () => ({width: 800,height:600}), scaleFactor: async () => 1 }) }))
vi.mock('../lib/tabs.svelte', () => ({ acceptSumiSnapshot: vi.fn(), acknowledgeSumiProjection: vi.fn(), prepareFileViewTransition: mocks.prepare, closeTab: mocks.close, setMode: mocks.mode }))
vi.mock('../lib/dialogs', () => ({ confirmDirtyClose: mocks.confirm, showError: mocks.error }))
vi.mock('../lib/sumi/geometry', () => ({ boundsForNative: () => ({x:0,y:0,width:800,height:600}), nativeSurfaceOccluded: () => false }))
vi.mock('../lib/sumi/session', () => ({ SumiExistingOwnerError: class extends Error {}, openSumiOwner: async () => ({pageId:'paper-a',tabId:'tab-a'}), closeSumiOwner: mocks.release, focusExistingSumiPage: vi.fn(), mountSumiOwner: async () => ({surfaceId:'surface',generation:1}), detachSumiSurface: vi.fn(async()=>{}), updateSumiSurface: vi.fn(async()=>{}) }))
vi.mock('./SumiRecovery.svelte', () => ({default: () => ({})}))
let component: ReturnType<typeof mount> | undefined
let tab: Tab
async function settle() { for(let i=0;i<25;i++){await Promise.resolve();await tick()} }
function action(action: string, page_id='paper-a', tab_id='tab-a') { mocks.handlers.get('sumi-action')!({payload:{page_id,tab_id,action}}) }
beforeEach(async () => {
  vi.clearAllMocks();mocks.handlers.clear();
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
    expect(mocks.release).not.toHaveBeenCalled();expect(mocks.invoke).not.toHaveBeenCalled();expect(mocks.error).toHaveBeenCalledWith('Error: composition active')
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
    expect(mocks.error).toHaveBeenCalledWith('Error: disk unavailable');expect(mocks.release).not.toHaveBeenCalled()
  })
})
