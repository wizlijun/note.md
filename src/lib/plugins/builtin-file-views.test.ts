import { describe, expect, it, vi } from 'vitest'
import type { Tab } from '../tabs.svelte'

vi.mock('../outline/gate.svelte', () => ({
  isOutlineNoteTab: (tab: { kind: string; filePath: string }) => (
    tab.kind === 'markdown' && /\.notes?\.md$/i.test(tab.filePath)
  ),
}))

const { builtinFileViewFor, builtinFileViewManifests } = await import('./builtin-file-views')

function tab(filePath: string, kind = 'markdown'): Tab {
  return {
    id: filePath,
    filePath,
    title: filePath.split('/').at(-1)!,
    initialContent: '# Note',
    currentContent: '# Note',
    mode: 'rich',
    kind: kind as Tab['kind'],
    externalState: 'fresh',
    externalBannerDismissed: false,
    lastKnownMtime: 0,
    lastKnownHash: '',
  }
}

describe('built-in file-view registrations', () => {
  it.each(['/vault/topic.note.md', '/vault/topic.notes.md', '/vault/TOPIC.NoTe.Md'])(
    'registers canonical outline notes with the declarative matcher: %s',
    (filePath) => {
      const current = tab(filePath)
      expect(builtinFileViewFor(current)).toMatchObject({
        pluginId: 'notemd.core',
        viewId: 'outline-note',
      })
    },
  )

  it.each(['/vault/topic.md', '/vault/topic.note.mdx'])(
    'does not register the outline view for non-note files: %s',
    (filePath) => expect(builtinFileViewManifests(tab(filePath))).toEqual([]),
  )

  it('does not register the desktop outline surface for a non-Markdown kind', () => {
    expect(builtinFileViewManifests(tab('/vault/topic.note.md', 'code'))).toEqual([])
  })
})
