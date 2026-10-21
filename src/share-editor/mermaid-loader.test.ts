/** @vitest-environment happy-dom */
import { afterEach, expect, it, vi } from 'vitest'
import { mermaidAppearance, shareMermaidLoader } from './mermaid-loader'
import type { ShareEditorHost } from './contract'
afterEach(() => { document.body.replaceChildren(); delete document.documentElement.dataset.theme; vi.restoreAllMocks() })
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

function themedPreview(background: string, foreground = 'rgb(38, 37, 34)') {
  const host = document.createElement('section'), middle = document.createElement('div'), preview = document.createElement('div')
  host.dataset.theme = 'effie'
  host.style.backgroundColor = background
  host.style.color = foreground
  middle.style.backgroundColor = 'rgba(255, 0, 0, 0)'
  preview.style.backgroundColor = 'transparent'
  host.append(middle); middle.append(preview); document.body.append(host)
  return { host, middle, preview }
}

it('resolves each real preview backdrop independently even when theme IDs are identical', () => {
  document.documentElement.dataset.theme = 'light'
  const paper = themedPreview('rgb(244, 238, 226)'), other = themedPreview('rgb(232, 239, 246)')
  expect(mermaidAppearance(paper.preview, 'pele')).toMatchObject({ theme: 'default', themeVariables: { background: 'rgb(244, 238, 226)', primaryTextColor: 'rgb(38, 37, 34)', lineColor: 'rgb(38, 37, 34)' } })
  expect(mermaidAppearance(other.preview, 'pele').themeVariables.background).toBe('rgb(232, 239, 246)')
  paper.preview.style.backgroundColor = 'rgb(250, 248, 240)'
  expect(mermaidAppearance(paper.preview, 'pele').themeVariables.background).toBe('rgb(250, 248, 240)')
  expect(mermaidAppearance(paper.preview).themeVariables).not.toHaveProperty('background')
})

it('reads actual container color on every responsive render and forwards only width to the module', async () => {
  document.documentElement.dataset.theme = 'light'
  const root = document.createElement('div')
  root.style.backgroundColor = 'rgb(255, 255, 255)'; document.body.append(root)
  const { host, preview } = themedPreview('rgb(244, 238, 226)')
  const render = vi.fn(async () => '<svg/>')
  const api = await shareMermaidLoader({ loadMermaid: async () => ({ render, supportsResponsiveLayout: true }) } as unknown as ShareEditorHost, root)!()
  await api.renderMermaid('source', { maxWidth: 320, container: preview })
  expect(render).toHaveBeenLastCalledWith('source', expect.objectContaining({ theme: 'default', themeVariables: expect.objectContaining({ background: 'rgb(244, 238, 226)' }) }), { maxWidth: 320 })
  host.dataset.theme = 'custom-evening'
  host.style.backgroundColor = 'rgb(29, 31, 36)'; host.style.color = 'rgb(230, 232, 236)'
  api.updateMermaidTheme()
  await api.renderMermaid('source', { maxWidth: 320, container: preview })
  expect(render).toHaveBeenLastCalledWith('source', expect.objectContaining({ theme: 'dark', themeVariables: expect.objectContaining({ background: 'rgb(29, 31, 36)', primaryTextColor: 'rgb(230, 232, 236)', lineColor: 'rgb(230, 232, 236)' }) }), { maxWidth: 320 })
  host.dataset.theme = 'effie'; host.style.backgroundColor = 'rgb(244, 238, 226)'; host.style.color = 'rgb(38, 37, 34)'
  await api.renderMermaid('source', { container: preview })
  expect(render).toHaveBeenLastCalledWith('source', expect.objectContaining({ theme: 'default', themeVariables: expect.objectContaining({ background: 'rgb(244, 238, 226)' }) }), undefined)
  expect(document.documentElement.dataset.theme).toBe('light')
})

it('keeps all six explicit legacy color variables ahead of inferred body colors', () => {
  const { preview } = themedPreview('rgb(25, 25, 25)', 'rgb(230, 230, 230)')
  const variables = { '--accent-color': '#123456', '--text-primary': '#abcdef', '--border-color': '#112233', '--text-secondary': '#aabbcc', '--bg-secondary': '#445566', '--bg-hover': '#556677' }
  for (const [name, value] of Object.entries(variables)) preview.style.setProperty(name, value)
  expect(mermaidAppearance(preview, 'pele').themeVariables).toEqual({ primaryColor: '#123456', primaryTextColor: '#abcdef', primaryBorderColor: '#112233', lineColor: '#aabbcc', secondaryColor: '#445566', tertiaryColor: '#556677', background: 'rgb(25, 25, 25)' })
  expect(mermaidAppearance(preview).themeVariables).toEqual({ primaryColor: '#123456', primaryTextColor: '#abcdef', primaryBorderColor: '#112233', lineColor: '#aabbcc', secondaryColor: '#445566', tertiaryColor: '#556677' })
})

it('retains readable defaults when the computed body color has insufficient contrast', () => {
  const { preview } = themedPreview('rgb(20, 20, 20)', 'rgb(0, 0, 0)')
  expect(mermaidAppearance(preview, 'pele')).toMatchObject({ theme: 'dark', themeVariables: { primaryTextColor: '#eeeeee', lineColor: '#cccccc' } })
})

it('composites translucent RGB layers over a known opaque ancestor and leaves an unknown backdrop to defaults', () => {
  const { preview, middle } = themedPreview('rgb(20, 40, 60)')
  middle.style.backgroundColor = 'rgba(100, 120, 140, 0.5)'
  preview.style.backgroundColor = 'rgba(200, 180, 160, 0.25)'
  expect(mermaidAppearance(preview, 'pele').themeVariables.background).toBe('rgb(95, 105, 115)')
  const alone = document.createElement('div'); alone.style.backgroundColor = 'rgba(200, 180, 160, 0.25)'; document.body.append(alone)
  document.documentElement.dataset.theme = 'dark'
  expect(mermaidAppearance(alone, 'pele')).toMatchObject({ theme: 'dark', themeVariables: { primaryTextColor: '#eeeeee' } })
  expect(mermaidAppearance(alone, 'pele').themeVariables).not.toHaveProperty('background')
})
