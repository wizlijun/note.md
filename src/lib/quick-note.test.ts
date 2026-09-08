import { describe, it, expect, vi, beforeEach } from 'vitest'

const invoke = vi.fn()
const mkdir = vi.fn()
const exists = vi.fn()
const openFile = vi.fn()
const writeMd = vi.fn()
const files = new Map<string, string>()
const requestEditorFocus = vi.fn()
const pushToast = vi.fn()

vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }))
vi.mock('@tauri-apps/plugin-fs', () => ({
  mkdir: (...a: unknown[]) => mkdir(...a),
  exists: (...a: unknown[]) => exists(...a),
}))
vi.mock('./tabs.svelte', () => ({
  openFile: (...a: unknown[]) => openFile(...a),
}))
vi.mock('./fs', () => ({ writeMd: (...a: unknown[]) => writeMd(...a) }))
vi.mock('./editor-focus.svelte', () => ({
  requestEditorFocus: (...a: unknown[]) => requestEditorFocus(...a),
}))
vi.mock('./toast.svelte', () => ({
  pushToast: (...a: unknown[]) => pushToast(...a),
}))
vi.mock('./i18n/store.svelte', () => ({
  t: (k: string) => k,
}))

// Default: identity cache is cold — createQuickNote() must sign nothing until
// a test opts into a warm cache.
const humanActorNow = vi.fn((): string | null => null)
vi.mock('./okf/identity', () => ({
  humanActorNow: () => humanActorNow(),
}))

beforeEach(() => {
  vi.clearAllMocks()
  invoke.mockResolvedValue('/vault/inbox')
  mkdir.mockResolvedValue(undefined)
  files.clear()
  exists.mockImplementation(async (path: string) => files.has(path))
  openFile.mockResolvedValue(undefined)
  writeMd.mockImplementation(async (path: string, content: string) => { files.set(path, content) })
  humanActorNow.mockReturnValue(null)
})

describe('createQuickNote', () => {
  it('creates an OKF note on disk before opening and focusing its editor', async () => {
    const { createQuickNote } = await import('./quick-note.svelte')
    await createQuickNote(new Date(2026, 6, 25, 9, 8))

    const path = '/vault/inbox/untitled.md'
    expect(invoke).toHaveBeenCalledWith('notemd_quick_note_dir')
    expect(mkdir).toHaveBeenCalledWith('/vault/inbox', { recursive: true })
    expect(writeMd).toHaveBeenCalledWith(path, '---\ntype: Note\n---\n')
    expect(requestEditorFocus).toHaveBeenCalledWith(path)
    expect(openFile).toHaveBeenCalledWith(path)
    expect(writeMd.mock.invocationCallOrder[0]).toBeLessThan(requestEditorFocus.mock.invocationCallOrder[0])
    expect(requestEditorFocus.mock.invocationCallOrder[0]).toBeLessThan(openFile.mock.invocationCallOrder[0])
  })

  it('signs the persisted note when the identity cache is warm', async () => {
    humanActorNow.mockReturnValue('human:testuser')
    const { createQuickNote } = await import('./quick-note.svelte')
    await createQuickNote(new Date(2026, 6, 25, 9, 8))

    expect(writeMd).toHaveBeenCalledWith(
      '/vault/inbox/untitled.md',
      expect.stringContaining('generated:\n  by: human:testuser\n  at:'),
    )
  })

  it('preserves existing notes and chooses the next free untitled filename', async () => {
    files.set('/vault/inbox/untitled.md', 'keep first')
    files.set('/vault/inbox/untitled-2.md', 'keep second')
    const { createQuickNote } = await import('./quick-note.svelte')
    await createQuickNote(new Date(2026, 6, 25, 9, 8))

    expect(openFile).toHaveBeenCalledWith('/vault/inbox/untitled-3.md')
    expect(files.get('/vault/inbox/untitled.md')).toBe('keep first')
    expect(files.get('/vault/inbox/untitled-2.md')).toBe('keep second')
    expect(writeMd).toHaveBeenCalledTimes(1)
  })

  it('creates distinct files when triggered twice concurrently in the same second', async () => {
    const { createQuickNote } = await import('./quick-note.svelte')
    const now = new Date(2026, 6, 25, 9, 8)
    await Promise.all([createQuickNote(now), createQuickNote(now)])

    expect(openFile.mock.calls.map(([path]) => path)).toEqual([
      '/vault/inbox/untitled.md', '/vault/inbox/untitled-2.md',
    ])
    expect(files.size).toBe(2)
  })

  it('does not open an unwritten note when persistence fails', async () => {
    writeMd.mockRejectedValueOnce(new Error('disk full'))
    const { createQuickNote } = await import('./quick-note.svelte')
    await createQuickNote()

    expect(openFile).not.toHaveBeenCalled()
    expect(requestEditorFocus).not.toHaveBeenCalled()
    expect(pushToast).toHaveBeenCalledWith({
      level: 'error', message: 'quickNote.createFailed', detail: 'Error: disk full',
    })
    await createQuickNote()
    expect(openFile).toHaveBeenCalledWith('/vault/inbox/untitled.md')
  })

  it('does not overwrite a candidate when checking its existence fails', async () => {
    exists.mockRejectedValueOnce(new Error('permission denied'))
    const { createQuickNote } = await import('./quick-note.svelte')
    await createQuickNote()

    expect(writeMd).not.toHaveBeenCalled()
    expect(openFile).not.toHaveBeenCalled()
    expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ level: 'error' }))
  })

  it('shows the no-vault toast when the backend has no quick-note dir', async () => {
    invoke.mockRejectedValue(new Error('Vault not configured'))
    const { createQuickNote } = await import('./quick-note.svelte')
    await createQuickNote(new Date(2026, 6, 25, 9, 8))

    expect(pushToast).toHaveBeenCalledWith({
      level: 'warn',
      message: 'quickNote.noVault',
    })
    expect(mkdir).not.toHaveBeenCalled()
  })
})
