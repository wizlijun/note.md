// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createRawSnippet, mount, tick, unmount } from 'svelte'
import type { Tab } from '../lib/tabs.svelte'
import CustomEditorIframe from './CustomEditorIframe.svelte'
import FilePluginView from './FilePluginView.svelte'

let component: ReturnType<typeof mount> | undefined

afterEach(async () => {
  if (component) await unmount(component)
  component = undefined
  document.body.innerHTML = ''
})

function tab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: 'tab-1',
    filePath: '/vault/example.timeline.md',
    title: 'example.timeline.md',
    initialContent: '# Example',
    currentContent: '# Example',
    mode: 'rich',
    kind: 'custom',
    externalState: 'fresh',
    externalBannerDismissed: false,
    lastKnownMtime: 0,
    lastKnownHash: '',
    ...overrides,
  }
}

describe('open plugin iframe reload', () => {
  it('reloads an open file view only when its plugin is replaced', async () => {
    component = mount(FilePluginView, {
      target: document.body,
      props: {
        tab: tab({ kind: 'markdown' }),
        view: { pluginId: 'notemd.timeline', viewId: 'timeline', entry: 'index.html', icon: 'clock' },
        fallback: createRawSnippet(() => ({ render: () => '<div>fallback</div>' })),
      },
    })
    await tick()
    expect(document.querySelector('iframe')?.src).toContain('notemdReload=0')

    window.dispatchEvent(new CustomEvent('notemd:plugin-reloaded', {
      detail: { pluginId: 'notemd.other' },
    }))
    await tick()
    expect(document.querySelector('iframe')?.src).toContain('notemdReload=0')

    window.dispatchEvent(new CustomEvent('notemd:plugin-reloaded', {
      detail: { pluginId: 'notemd.timeline' },
    }))
    await tick()
    expect(document.querySelector('iframe')?.src).toContain('notemdReload=1')
    expect(document.querySelector('iframe')?.dataset.pluginViewId).toBe('notemd.timeline')
  })

  it('recreates an open custom editor with the new plugin generation', async () => {
    component = mount(CustomEditorIframe, {
      target: document.body,
      props: {
        tab: tab({
          editorPluginId: 'notemd.custom',
          editorId: 'custom',
          editorEntry: 'editor.html',
        }),
      },
    })
    await tick()
    const original = document.querySelector('iframe')
    expect(original?.src).toContain('notemdReload=0')

    window.dispatchEvent(new CustomEvent('notemd:plugin-reloaded', {
      detail: { pluginId: 'notemd.custom' },
    }))
    await tick()
    const reloaded = document.querySelector('iframe')
    expect(reloaded).not.toBe(original)
    expect(reloaded?.src).toContain('notemdReload=1')
    expect(reloaded?.dataset.pluginViewId).toBe('notemd.custom')
  })
})
