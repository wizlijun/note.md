import { describe, expect, it, vi } from 'vitest'
import type { Tab } from '../tabs.svelte'
import { setMemoryProjectionVaultRoot } from '../memory-projection'
import { dispatchFileViewCommand, type OpenFileViewDetail } from './file-view-commands'
import type { PluginManifest } from './types'

const timeline = `---\ntype: timeline\n---\n# Day\n\n- 09:00–10:00 — 开发：修复视图。`

function tab(content = timeline): Tab {
  return {
    id: 'day', filePath: '/vault/diary/day.timeline.md', title: 'day.timeline.md',
    currentContent: content, initialContent: content, kind: 'markdown', mode: 'rich',
    externalState: 'fresh', externalBannerDismissed: false, lastKnownMtime: 0, lastKnownHash: '',
  }
}

function manifest(): PluginManifest {
  return {
    id: 'notemd.timeline', name: 'Timeline', version: '1.0.1', binary: '', host_capabilities: [],
    file_views: [{
      id: 'timeline', entry: 'index.html', open_command: 'open-timeline',
      selectors: [{ file_extensions: ['md'], frontmatter: { type: ['timeline'] } }],
    }],
  }
}

function harness(current: Tab | null) {
  let active = current
  const opened: OpenFileViewDetail[] = []
  const deps = {
    activeTab: vi.fn(() => active),
    pickOpenFile: vi.fn(async () => '/vault/diary/picked.timeline.md' as string | null),
    openFile: vi.fn(async () => { active = tab() }),
    flush: vi.fn(),
    setRichMode: vi.fn(),
    openView: vi.fn((detail: OpenFileViewDetail) => opened.push(detail)),
    unsupported: vi.fn(),
  }
  return { deps, opened, setActive(value: Tab | null) { active = value } }
}

describe('dispatchFileViewCommand', () => {
  it('does not consume ordinary plugin commands', async () => {
    const h = harness(tab())
    expect(await dispatchFileViewCommand(manifest(), 'other', h.deps)).toBe(false)
    expect(h.deps.flush).not.toHaveBeenCalled()
  })

  it('does not consume an ambiguous or window-owned command from an untrusted projection', async () => {
    const h = harness(tab())
    const duplicate = manifest()
    duplicate.file_views!.push({ ...duplicate.file_views![0], id: 'duplicate' })
    expect(await dispatchFileViewCommand(duplicate, 'open-timeline', h.deps)).toBe(false)

    const windowOwned = manifest()
    windowOwned.open_windows = { 'open-timeline': 'settings' }
    expect(await dispatchFileViewCommand(windowOwned, 'open-timeline', h.deps)).toBe(false)
    expect(h.deps.flush).not.toHaveBeenCalled()
  })

  it('opens the requested view for the active matching file without a process call', async () => {
    const h = harness(tab())
    expect(await dispatchFileViewCommand(manifest(), 'open-timeline', h.deps)).toBe(true)
    expect(h.deps.flush).toHaveBeenCalledWith('day')
    expect(h.deps.setRichMode).toHaveBeenCalledWith('day')
    expect(h.opened).toEqual([{ tabId: 'day', pluginId: 'notemd.timeline', viewId: 'timeline', entry: 'index.html' }])
    expect(h.deps.pickOpenFile).not.toHaveBeenCalled()
  })

  it('asks for a file when no document is open and then evaluates the opened file', async () => {
    const h = harness(null)
    expect(await dispatchFileViewCommand(manifest(), 'open-timeline', h.deps)).toBe(true)
    expect(h.deps.pickOpenFile).toHaveBeenCalledOnce()
    expect(h.deps.openFile).toHaveBeenCalledWith('/vault/diary/picked.timeline.md')
    expect(h.opened).toHaveLength(1)
  })

  it('treats cancelling the file picker as handled with no side effects', async () => {
    const h = harness(null)
    h.deps.pickOpenFile.mockResolvedValue(null)
    expect(await dispatchFileViewCommand(manifest(), 'open-timeline', h.deps)).toBe(true)
    expect(h.deps.openFile).not.toHaveBeenCalled()
    expect(h.deps.openView).not.toHaveBeenCalled()
  })

  it('keeps a non-matching document untouched and reports the requested view', async () => {
    const h = harness(tab('# Ordinary note'))
    expect(await dispatchFileViewCommand(manifest(), 'open-timeline', h.deps)).toBe(true)
    expect(h.deps.unsupported).toHaveBeenCalledWith(expect.objectContaining({ id: 'timeline' }))
    expect(h.deps.setRichMode).not.toHaveBeenCalled()
    expect(h.deps.openView).not.toHaveBeenCalled()
  })

  it('does not replace a managed Memory document', async () => {
    setMemoryProjectionVaultRoot('/vault')
    const protectedTab = tab()
    protectedTab.filePath = '/vault/MEMORY.md'
    const h = harness(protectedTab)
    await dispatchFileViewCommand(manifest(), 'open-timeline', h.deps)
    expect(h.deps.unsupported).toHaveBeenCalledOnce()
    expect(h.deps.openView).not.toHaveBeenCalled()
    setMemoryProjectionVaultRoot(null)
  })

  it('matches the post-flush snapshot and explicitly selects this plugin over another view', async () => {
    const current = tab('# before flush')
    const h = harness(current)
    h.deps.flush.mockImplementation(() => { current.currentContent = timeline })
    const m = manifest()
    m.file_views!.unshift({
      id: 'other', entry: 'other.html', priority: 999,
      selectors: [{ file_extensions: ['md'] }],
    })
    await dispatchFileViewCommand(m, 'open-timeline', h.deps)
    expect(h.opened[0]).toMatchObject({ pluginId: 'notemd.timeline', viewId: 'timeline' })
  })
})
