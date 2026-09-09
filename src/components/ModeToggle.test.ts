// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import ModeToggle from './ModeToggle.svelte'
import { tabs, type Tab } from '../lib/tabs.svelte'
import { pluginRuntime } from '../lib/plugins/runtime.svelte'
import { resetFileViewPresentation } from '../lib/plugins/file-view-presentation.svelte'

vi.mock('../lib/platform.svelte', () => ({ platform: () => Promise.resolve('macos') }))

function timelineTab(): Tab {
  const content = '---\ntype: timeline\n---\n# Timeline'
  return {
    id: 'mode-toggle-tab',
    filePath: '/vault/diary/2026-09-09.timeline.md',
    title: '2026-09-09.timeline.md',
    initialContent: content,
    currentContent: content,
    mode: 'rich',
    kind: 'markdown',
    externalState: 'fresh',
    externalBannerDismissed: false,
    lastKnownMtime: 0,
    lastKnownHash: '',
  }
}

describe('ModeToggle file-view slot', () => {
  let component: ReturnType<typeof mount> | undefined

  afterEach(async () => {
    if (component) await unmount(component)
    component = undefined
    tabs.splice(0)
    pluginRuntime.manifests = []
    resetFileViewPresentation('mode-toggle-tab')
    document.body.innerHTML = ''
  })

  it('shows one mutually exclusive plugin slot only for a matching file', async () => {
    tabs.push(timelineTab())
    pluginRuntime.manifests = [{
      id: 'notemd.timeline',
      name: 'Timeline',
      version: '1.0.0',
      binary: '',
      host_capabilities: [],
      file_views: [{
        id: 'timeline',
        entry: 'index.html',
        icon: 'clock',
        selectors: [{ file_extensions: ['md'], frontmatter: { type: ['timeline'] } }],
      }],
    }]
    component = mount(ModeToggle, { target: document.body, props: { tab: tabs[0] } })
    await tick()

    const buttons = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    expect(buttons).toHaveLength(3)
    expect(buttons.map((button) => button.getAttribute('aria-selected'))).toEqual(['false', 'false', 'true'])
    expect(buttons[2].dataset.fileViewIcon).toBe('clock')
    expect(buttons[2].querySelector('circle[cx="12"][cy="12"][r="9"]')).not.toBeNull()

    buttons[0].click()
    await tick()
    expect(buttons.map((button) => button.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false'])

    buttons[2].click()
    await tick()
    expect(buttons.map((button) => button.getAttribute('aria-selected'))).toEqual(['false', 'false', 'true'])

    buttons[2].focus()
    buttons[2].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    await tick()
    expect(document.activeElement).toBe(buttons[1])
    expect(buttons.map((button) => button.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false'])

    buttons[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    await tick()
    expect(document.activeElement).toBe(buttons[0])
    expect(buttons.map((button) => button.tabIndex)).toEqual([0, -1, -1])

    buttons[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    await tick()
    expect(document.activeElement).toBe(buttons[2])
    expect(buttons.map((button) => button.tabIndex)).toEqual([-1, -1, 0])
  })

  it('uses the same current color as adjacent modes for a note sparkle', async () => {
    const tab = timelineTab()
    tab.filePath = '/vault/ideas.note.md'
    tab.title = 'ideas.note.md'
    tab.currentContent = '# Note'
    tabs.push(tab)
    pluginRuntime.manifests = [{
      id: 'notemd.note',
      name: 'Note',
      version: '1.0.0',
      binary: '',
      host_capabilities: [],
      file_views: [{
        id: 'note',
        entry: 'index.html',
        icon: 'sparkle',
        selectors: [{ file_name_patterns: ['*.note.md'] }],
      }],
    }]
    component = mount(ModeToggle, { target: document.body, props: { tab: tabs[0] } })
    await tick()

    const button = document.querySelector<HTMLButtonElement>('[data-file-view-icon="sparkle"]')
    expect(button).not.toBeNull()
    expect(button?.querySelector('path[fill="currentColor"]')).not.toBeNull()
    expect(button?.querySelector('path[fill="#f59e0b"]')).toBeNull()
  })

  it('keeps the original two compact modes when no plugin view matches', async () => {
    const tab = timelineTab()
    tab.currentContent = '# Ordinary note'
    tabs.push(tab)
    component = mount(ModeToggle, { target: document.body, props: { tab: tabs[0] } })
    await tick()
    expect(document.querySelectorAll('[role="tab"]')).toHaveLength(2)
    expect(document.querySelector('[role="tab"][aria-selected="true"]')?.getAttribute('aria-label')).toBeTruthy()
  })
})
