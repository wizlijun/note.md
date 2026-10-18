/** @vitest-environment happy-dom */
import { expect, it, vi } from 'vitest'
import { mermaidAppearance, shareMermaidLoader } from './mermaid-loader'
import type { ShareEditorHost } from './contract'
it('uses actual root six colors and explicit html/OS appearance, never the frozen theme ID', async () => {
  const root = document.createElement('div'); root.dataset.theme = 'arbitrary-dark-looking-name'; document.body.append(root)
  root.style.setProperty('--accent-color', '#123456'); root.style.setProperty('--text-primary', '#abcdef')
  document.documentElement.dataset.theme = 'light'
  expect(mermaidAppearance(root)).toMatchObject({ theme: 'default', themeVariables: { primaryColor: '#123456', primaryTextColor: '#abcdef' } })
  const render = vi.fn(async () => '<svg/>'), loadMermaid = vi.fn(async () => ({ render }))
  const loader = shareMermaidLoader({ loadMermaid } as unknown as ShareEditorHost, root)!
  expect(loadMermaid).not.toHaveBeenCalled()
  const api = await loader(); await api.renderMermaid('graph TD; A-->B')
  root.style.setProperty('--accent-color', '#999999'); document.documentElement.dataset.theme = 'dark'; api.updateMermaidTheme()
  await api.renderMermaid('graph TD; A-->B')
  expect(render).toHaveBeenLastCalledWith('graph TD; A-->B', expect.objectContaining({ theme: 'dark', themeVariables: expect.objectContaining({ primaryColor: '#999999' }) }))
  render.mockRejectedValueOnce(Error('load failed')); expect(await api.renderMermaid('source')).toHaveProperty('error')
  root.remove(); delete document.documentElement.dataset.theme
})
it('forwards responsive width only to an opted-in renderer', async () => {
  const root = document.createElement('div')
  const render = vi.fn(async () => '<svg/>')
  const api = await shareMermaidLoader({ loadMermaid: async () => ({ render, supportsResponsiveLayout: true }) } as unknown as ShareEditorHost, root)!()
  expect(api.supportsResponsiveLayout).toBe(true)
  await api.renderMermaid('graph TD; A-->B', { maxWidth: 321 })
  expect(render).toHaveBeenCalledWith('graph TD; A-->B', expect.any(Object), { maxWidth: 321 })
})
it('keeps legacy render at exactly two arguments even when CORE supplies width', async () => {
  const root = document.createElement('div'), render = vi.fn(async () => '<svg/>')
  const api = await shareMermaidLoader({ loadMermaid: async () => ({ render }) } as unknown as ShareEditorHost, root)!()
  await api.renderMermaid('source', { maxWidth: 300 })
  expect(render.mock.calls[0]).toHaveLength(2)
})

it.each(['light', 'dark'])('uses readable Pele defaults without legacy CSS variables in %s mode', async mode => {
  const root = document.createElement('div')
  document.documentElement.dataset.theme = mode
  const render = vi.fn(async () => '<svg/>')
  try {
    const api = await shareMermaidLoader({ loadMermaid: async () => ({ render, supportsResponsiveLayout: true }) } as unknown as ShareEditorHost, root)!()
    await api.renderMermaid('graph TD; A-->B')
    expect(render).toHaveBeenCalledWith('graph TD; A-->B', expect.objectContaining({ themeVariables: expect.objectContaining(mode === 'dark'
      ? { primaryColor: '#93c5fd', primaryTextColor: '#eeeeee', secondaryColor: '#303030', tertiaryColor: '#404040', lineColor: '#cccccc' }
      : { primaryColor: '#2563eb', primaryTextColor: '#1f1f1f', secondaryColor: '#f3f3f3', tertiaryColor: '#e6e6e6' }) }), undefined)
    // Rebuilding with the original renderer retains its historical defaults.
    expect(mermaidAppearance(root).themeVariables.primaryTextColor).toBe('#333')
  } finally { delete document.documentElement.dataset.theme }
})
