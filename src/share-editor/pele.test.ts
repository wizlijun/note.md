/** @vitest-environment jsdom */
import { expect, it, vi } from 'vitest'
import { shareMermaid } from './pele'
import { mermaidAppearance } from './mermaid-loader'
it('registers the same independent API with responsive standalone SVG and no links', async () => {
  expect((window as unknown as { NotemdShareMermaid: unknown }).NotemdShareMermaid).toBe(shareMermaid)
  expect(shareMermaid.supportsResponsiveLayout).toBe(true)
  document.documentElement.dataset.theme = 'light'
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  const svg = await shareMermaid.render('graph TD; A[中文]-->B', mermaidAppearance(document.documentElement), { maxWidth: 320 })
  expect(svg).toContain('viewBox=')
  expect(svg).toContain('--pele-bg:')
  expect(svg).toContain('中文')
  expect(svg).not.toMatch(/<(?:a|image|script|foreignObject)\b/)
})
