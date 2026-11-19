// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import TabBar from './TabBar.svelte'
import { formFactor } from '../lib/platform.svelte'
import { i18n } from '../lib/i18n/store.svelte'

const mocked = vi.hoisted(() => {
  const tabs = [
    { id: 'a', filePath: '/vault/a.md', title: 'a.md', mode: 'rich', kind: 'markdown', currentContent: '# A', initialContent: '# A' },
    { id: 'b', filePath: '/vault/b.md', title: 'b.md', mode: 'rich', kind: 'markdown', currentContent: '# B', initialContent: '# B' },
    { id: 'c', filePath: '/vault/c.md', title: 'c.md', mode: 'rich', kind: 'markdown', currentContent: '# C', initialContent: '# C' },
  ]
  const activeId = { value: 'b' as string | null }
  return {
    tabs,
    activeId,
    pluginRuntime: { manifests: [] as any[] },
    dispatchPlugin: vi.fn(async () => {}),
    activateHome: vi.fn(async () => { activeId.value = null }),
    activate: vi.fn((id: string) => { activeId.value = id }),
    closeTab: vi.fn(async () => true),
    closeTabs: vi.fn(async () => true),
    confirmDirtyClose: vi.fn(async () => 'discard' as const),
  }
})

vi.mock('../lib/tabs.svelte', () => ({
  tabs: mocked.tabs,
  activeId: mocked.activeId,
  activeTab: () => mocked.tabs.find((tab) => tab.id === mocked.activeId.value) ?? null,
  isDirty: () => false,
  activate: mocked.activate,
  activateHome: mocked.activateHome,
  closeTab: mocked.closeTab,
  closeTabs: mocked.closeTabs,
  isManagedMemoryTab: () => false,
  setMode: vi.fn(),
}))
vi.mock('../lib/platform.svelte', () => ({
  formFactor: { value: 'desktop' },
  platform: async () => 'macos',
}))
vi.mock('../lib/dialogs', () => ({ confirmDirtyClose: mocked.confirmDirtyClose }))
vi.mock('../lib/plugins/runtime.svelte', () => ({ pluginRuntime: mocked.pluginRuntime, dispatchPluginCommand: mocked.dispatchPlugin }))
vi.mock('../lib/settings.svelte', () => ({ getPluginScopedAll: () => ({}), pluginScopedVersion: { value: 0 } }))
vi.mock('../lib/sotvault.svelte', () => ({ sotvaultStore: { tick: 0, vaultRoot: null }, isMirroredSource: () => false }))
vi.mock('../lib/window-title', () => ({
  SYNC_MARK: '↔',
  displayTitleForDocument: (tab: { title: string }) => tab.title,
}))

function openMenu(index: number) {
  const tab = document.querySelectorAll<HTMLButtonElement>('button.tab:not([data-home-tab])')[index]
  tab.dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    clientX: 40,
    clientY: 24,
  }))
}

describe('TabBar close context menu', () => {
  let component: ReturnType<typeof mount> | undefined

  beforeEach(() => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
    mocked.pluginRuntime.manifests = []
    mocked.dispatchPlugin.mockClear()
    mocked.activeId.value = 'b'
    mocked.activate.mockClear()
    mocked.activateHome.mockClear()
    formFactor.value = 'desktop'
    mocked.closeTab.mockClear()
    mocked.closeTabs.mockClear()
    mocked.confirmDirtyClose.mockClear()
    i18n.locale = 'zh'
    component = mount(TabBar, { target: document.body })
  })

  afterEach(async () => {
    if (component) await unmount(component)
    component = undefined
    document.body.innerHTML = ''
    i18n.locale = 'en'
  })

  it('shows the three localized close actions before existing tab actions', async () => {
    openMenu(1)
    await tick()

    const menu = document.querySelector('.tab-ctx-menu')
    const actions = [...document.querySelectorAll<HTMLButtonElement>('[data-tab-close-action]')]
    expect(mocked.activate).toHaveBeenCalledWith('b')
    expect(actions.map((button) => button.textContent?.trim())).toEqual(['关闭', '关闭左侧', '关闭所有'])
    expect(actions.every((button) => button.matches('.menu-panel .menu-row'))).toBe(true)
    expect(menu?.querySelector('[role="separator"].menu-sep')).not.toBeNull()
    expect(menu?.textContent).toContain('分享')
  })

  it('disables close-left only for the first tab', async () => {
    openMenu(0)
    await tick()
    expect(document.querySelector<HTMLButtonElement>('[data-tab-close-action="close-left"]')?.disabled).toBe(true)

    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await tick()
    openMenu(1)
    await tick()
    expect(document.querySelector<HTMLButtonElement>('[data-tab-close-action="close-left"]')?.disabled).toBe(false)
  })

  it('binds close and close-left to the right-clicked tab snapshot', async () => {
    openMenu(1)
    await tick()
    document.querySelector<HTMLButtonElement>('[data-tab-close-action="close"]')?.click()
    expect(mocked.closeTabs).toHaveBeenCalledWith(['b'], mocked.confirmDirtyClose)

    mocked.closeTabs.mockClear()
    openMenu(2)
    await tick()
    document.querySelector<HTMLButtonElement>('[data-tab-close-action="close-left"]')?.click()
    expect(mocked.closeTabs).toHaveBeenCalledWith(['a', 'b'], mocked.confirmDirtyClose)
  })

  it('passes all open tab ids to close-all in visual order', async () => {
    openMenu(1)
    await tick()
    document.querySelector<HTMLButtonElement>('[data-tab-close-action="close-all"]')?.click()
    await tick()

    expect(mocked.closeTabs).toHaveBeenCalledWith(['a', 'b', 'c'], mocked.confirmDirtyClose)
    expect(document.querySelector('.tab-ctx-menu')).toBeNull()
  })
  it('dispatches tab-context source even when the same command has a disabled main-menu gate', async () => {
    await unmount(component!); component = undefined
    mocked.pluginRuntime.manifests = [{ id:'fixture',name:'Fixture',version:'1',binary:'',host_capabilities:[],
      menus:[{command:'open',label:'Main menu',location:'plugins',enabled_when:'false'}],
      context_menus:[{command:'open',label:'Context entry',location:'tab',enabled_when:'true'}],
    }]
    component = mount(TabBar, {target:document.body}); await tick()
    openMenu(1); await tick()
    const item = [...document.querySelectorAll<HTMLButtonElement>('.tab-ctx-item')].find(button => button.textContent?.includes('Context entry'))
    expect(item?.disabled).toBe(false)
    item?.click(); await tick()
    expect(mocked.dispatchPlugin).toHaveBeenCalledExactlyOnceWith('fixture','open','tab-context')
  })

  it('shows home beside one file, marks home selected and hides mode controls there', async () => {
    await unmount(component!); component = undefined
    const removed = mocked.tabs.splice(1)
    mocked.activeId.value = null
    component = mount(TabBar, { target: document.body }); await tick()
    const home = document.querySelector<HTMLButtonElement>('[data-home-tab]')
    expect(home?.textContent).toContain('首页')
    expect(home?.classList.contains('active')).toBe(true)
    expect(document.querySelectorAll('button.tab')).toHaveLength(2)
    expect(document.querySelector('.right')).toBeNull()
    home?.click()
    expect(mocked.activateHome).toHaveBeenCalledOnce()
    mocked.tabs.push(...removed)
  })

  it('keeps phone/tablet behavior and has no redundant strip when no files are open', async () => {
    await unmount(component!); component = undefined
    const original = mocked.tabs.splice(0)
    component = mount(TabBar, { target: document.body }); await tick()
    expect(document.querySelector('.bar')).toBeNull()
    await unmount(component); component = undefined
    mocked.tabs.push(original[0]); mocked.activeId.value = original[0].id
    for (const factor of ['phone', 'tablet'] as const) {
      formFactor.value = factor
      component = mount(TabBar, { target: document.body }); await tick()
      expect(document.querySelector('.bar')).toBeNull()
      await unmount(component); component = undefined
    }
    mocked.tabs.push(...original.slice(1))
    component = mount(TabBar, { target: document.body }); await tick()
    expect(document.querySelector('.bar')).not.toBeNull()
    expect(document.querySelector('[data-home-tab]')).toBeNull()
    expect(document.querySelector('.right')).not.toBeNull()
  })

})
