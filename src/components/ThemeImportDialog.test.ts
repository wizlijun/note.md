// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, unmount } from 'svelte'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

beforeEach(() => {
  // vi.resetModules() intentionally omitted: resetting modules causes Svelte's internal
  // DOM operations.js singleton (first_child_getter) to be re-evaluated before the
  // happy-dom context re-runs init_operations(), producing a "Cannot read properties of
  // undefined (reading 'call')" crash on mount. clearAllMocks() is sufficient here
  // because the module-level vi.mock() factory persists correctly across tests.
  vi.clearAllMocks()
  document.body.innerHTML = ''
})

const sampleReport = {
  themes: [
    { id: 'claude-like', name: 'Claude-Like', appearance: 'light', source_file: 'claude-like.css', conflict: false },
    { id: 'default',     name: 'Default',     appearance: 'light', source_file: 'default.css',     conflict: true  },
  ],
  asset_dirs: ['claude-like'],
  errors: [{ file: 'broken.css', message: 'parse error' }],
  staging_dir: '/tmp/staging',
}

describe('ThemeImportDialog', () => {
  it('renders theme names, conflict markers, asset dirs, and errors', async () => {
    const { default: ThemeImportDialog } = await import('./ThemeImportDialog.svelte')
    const app = mount(ThemeImportDialog as unknown as Parameters<typeof mount>[0], {
      target: document.body,
      props: { report: sampleReport, onClose: () => {} },
    })
    expect(document.body.textContent).toContain('Claude-Like')
    expect(document.body.textContent).toContain('Default')
    expect(document.body.textContent).toContain('will overwrite existing')
    expect(document.body.textContent).toContain('claude-like')   // asset dir
    expect(document.body.textContent).toContain('broken.css')    // error row
    expect(document.body.textContent).toContain('parse error')
    unmount(app)
  })

  it('requires overwrite checkbox when any theme is in conflict', async () => {
    const { default: ThemeImportDialog } = await import('./ThemeImportDialog.svelte')
    const app = mount(ThemeImportDialog as unknown as Parameters<typeof mount>[0], {
      target: document.body,
      props: { report: sampleReport, onClose: () => {} },
    })
    const btn = Array.from(document.body.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('Import')) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    const cb = document.body.querySelector('input[type="checkbox"]') as HTMLInputElement
    cb.checked = true
    cb.dispatchEvent(new Event('change', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 0))
    expect(btn.disabled).toBe(false)
    unmount(app)
  })

  it('invokes theme_install on confirm and calls onClose', async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValue(2)
    const onClose = vi.fn()
    const noConflictReport = { ...sampleReport, themes: sampleReport.themes.map(t => ({ ...t, conflict: false })) }
    const { default: ThemeImportDialog } = await import('./ThemeImportDialog.svelte')
    const app = mount(ThemeImportDialog as unknown as Parameters<typeof mount>[0], {
      target: document.body,
      props: { report: noConflictReport, onClose },
    })
    const btn = Array.from(document.body.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('Import')) as HTMLButtonElement
    btn.click()
    await new Promise((r) => setTimeout(r, 0))
    expect(invoke).toHaveBeenCalledWith('theme_install', expect.objectContaining({ report: expect.any(Object), overwrite: false }))
    expect(onClose).toHaveBeenCalled()
    unmount(app)
  })

  it('invokes theme_cancel_import on cancel', async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    const onClose = vi.fn()
    const { default: ThemeImportDialog } = await import('./ThemeImportDialog.svelte')
    const app = mount(ThemeImportDialog as unknown as Parameters<typeof mount>[0], {
      target: document.body,
      props: { report: sampleReport, onClose },
    })
    const btn = Array.from(document.body.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('Cancel')) as HTMLButtonElement
    btn.click()
    await new Promise((r) => setTimeout(r, 0))
    expect(invoke).toHaveBeenCalledWith('theme_cancel_import', { stagingDir: '/tmp/staging' })
    expect(onClose).toHaveBeenCalled()
    unmount(app)
  })
})
