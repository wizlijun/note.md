/** @vitest-environment happy-dom */
import { afterEach, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const oldRender = vi.hoisted(() => vi.fn(async () => ({ svg: '<svg id="old"/>' })))
const oldExportRender = vi.hoisted(() => vi.fn(async () => ({ svg: '<svg id="old-export"/>' })))
vi.mock('mermaid-mini', () => ({ default: { initialize() {}, render: oldExportRender } }))
const peleRender = vi.hoisted(() => vi.fn(() => '<svg id="pele"/>'))
vi.mock('@moraya/core/plugins/mermaid-renderer', () => ({ renderMermaid: oldRender, updateMermaidTheme() {} }))
vi.mock('../diagrams/pele-renderer', () => ({ renderPeleSvg: peleRender }))
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); vi.clearAllMocks() })
it.each([undefined, 'mermaid'])('keeps original API identity with selector %s', async value => {
  vi.stubEnv('VITE_DIAGRAM_RENDERER', value)
  const { loadDesktopMermaid } = await import('./mermaid-loader')
  expect((await loadDesktopMermaid()).renderMermaid).toBe(oldRender)
  const { loadMermaidRenderer } = await import('./renderer-registry')
  const plugin = await loadMermaidRenderer(), container = document.createElement('div')
  await plugin.render('graph TD; A-->B', container)
  expect(container.querySelector('#old-export')).not.toBeNull()
  expect(peleRender).not.toHaveBeenCalled()
})
it('selects Pele for desktop and export with actual width and fresh appearance', async () => {
  vi.stubEnv('VITE_DIAGRAM_RENDERER', 'pele')
  const { loadDesktopMermaid } = await import('./mermaid-loader')
  const api = await loadDesktopMermaid()
  document.documentElement.style.setProperty('--accent-color', '#123456')
  expect(api.supportsResponsiveLayout).toBe(true)
  await api.renderMermaid('graph TD; A-->B', { maxWidth: 234 })
  expect(peleRender).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ maxWidth: 234, appearance: expect.objectContaining({ themeVariables: expect.objectContaining({ primaryColor: '#123456' }) }) }))
  document.documentElement.style.setProperty('--accent-color', '#654321')
  await api.renderMermaid('graph TD; A-->B', { maxWidth: 345 })
  expect(peleRender).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ appearance: expect.objectContaining({ themeVariables: expect.objectContaining({ primaryColor: '#654321' }) }) }))
  const { loadMermaidRenderer } = await import('./renderer-registry')
  const plugin = await loadMermaidRenderer(), container = document.createElement('div')
  vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({ width: 420 } as DOMRect)
  await plugin.render('graph TD; A-->B', container)
  expect(peleRender).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ maxWidth: 420 }))
  expect(container.querySelector('#pele')).not.toBeNull()
  expect(oldRender).not.toHaveBeenCalled()
})
it('preserves legacy share source and registry renderer verbatim', () => {
  // Frozen from b285c074; independent of local Git history availability.
  const hash = (text: string) => createHash('sha256').update(text).digest('hex')
  const sharePath = 'src/share-editor/mermaid.ts', registryPath = 'src/lib/adapters/renderer-registry.ts'
  expect(hash(readFileSync(sharePath, 'utf8'))).toBe('5315bbce62db1d46272c05fe3547854fed00fa43335e3950fae2c5dd8faeb237')
  const body = (text: string) => text.slice(text.indexOf('const mermaidPlugin:'), text.indexOf('/** Top-level loader for the dot/graphviz'))
  expect(hash(body(readFileSync(registryPath, 'utf8')))).toBe('12887e312acaecd0f7bf9af7e89620b5cabab70a6653599119f1e325ee2eb8db')
})

it('uses dark Pele defaults in desktop and detached exports without theme variables', async () => {
  const root = document.documentElement, previousStyle = root.getAttribute('style'), previousTheme = root.dataset.theme
  vi.stubEnv('VITE_DIAGRAM_RENDERER', 'pele')
  root.removeAttribute('style'); root.dataset.theme = 'dark'
  try {
    const api = await (await import('./mermaid-loader')).loadDesktopMermaid()
    await api.renderMermaid('graph TD; A-->B')
    expect(peleRender).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ appearance: expect.objectContaining({ themeVariables: expect.objectContaining({ primaryTextColor: '#eeeeee', secondaryColor: '#303030' }) }) }))
    const plugin = await (await import('./renderer-registry')).loadMermaidRenderer()
    await plugin.render('graph TD; A-->B', document.createElement('div'))
    expect(peleRender).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ appearance: expect.objectContaining({ themeVariables: expect.objectContaining({ primaryTextColor: '#eeeeee', secondaryColor: '#303030' }) }) }))
  } finally {
    if (previousStyle === null) root.removeAttribute('style'); else root.setAttribute('style', previousStyle)
    if (previousTheme === undefined) delete root.dataset.theme; else root.dataset.theme = previousTheme
  }
})
