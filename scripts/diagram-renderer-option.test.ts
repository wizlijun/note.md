import { expect, it } from 'vitest'
import { diagramRendererOption } from './diagram-renderer-option.mjs'
it('selects only the reversible supported build engines', () => {
  expect(diagramRendererOption()).toBe('mermaid')
  expect(diagramRendererOption('')).toBe('mermaid')
  expect(diagramRendererOption('mermaid')).toBe('mermaid')
  expect(diagramRendererOption('pele')).toBe('pele')
  expect(() => diagramRendererOption('PELE')).toThrow('VITE_DIAGRAM_RENDERER')
})
it('rejects an unknown selector before the standalone build writes anything', async () => {
  const { execFileSync } = await import('node:child_process')
  expect(() => execFileSync(process.execPath, ['scripts/build-share-editor.mjs'], {
    env: { ...process.env, VITE_DIAGRAM_RENDERER: 'typo' }, stdio: 'pipe',
  })).toThrow()
})
it('rejects an unknown selector while loading Vite configuration', async () => {
  const { loadConfigFromFile } = await import('vite')
  const previous = process.env.VITE_DIAGRAM_RENDERER
  process.env.VITE_DIAGRAM_RENDERER = 'typo'
  try {
    await expect(loadConfigFromFile({ command: 'build', mode: 'production' }, 'vite.config.ts')).rejects.toThrow('VITE_DIAGRAM_RENDERER')
  } finally {
    if (previous === undefined) delete process.env.VITE_DIAGRAM_RENDERER
    else process.env.VITE_DIAGRAM_RENDERER = previous
  }
})
