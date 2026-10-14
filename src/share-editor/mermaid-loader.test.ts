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
