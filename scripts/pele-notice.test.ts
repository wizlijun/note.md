import { describe, expect, it } from 'vitest'
import { build } from 'vite'
// @ts-expect-error Build scripts are plain Node modules.
import { assertPeleNotice, peleNotice, peleNoticeBanner, peleNoticeGuard } from './pele-notice.mjs'

describe('Pele resource notice', () => {
  it('selects actual package modules without changing Mermaid chunks', () => {
    expect(peleNoticeBanner({ modules: { '/node_modules/mermaid/dist/index.js': {} } })).toBe('')
    expect(peleNoticeBanner({ modules: { '/src/share-editor/pele.ts': {} } })).toBe('')
    expect(peleNoticeBanner({ modules: { '/node_modules/.pnpm/pele@1.6.0/node_modules/pele/dist/index.js': {} } })).toContain(peleNotice)
  })
  it('retains the complete notice in real minified Pele output and rejects its removal', async () => {
    const result = await build({ configFile: false, envFile: false, plugins: [peleNoticeGuard()], logLevel: 'silent', build: {
      write: false, target: 'safari15', minify: 'esbuild', rollupOptions: {
        input: 'src/share-editor/pele.ts', output: { format: 'iife', inlineDynamicImports: true, banner: peleNoticeBanner },
      },
    } })
    const output = (Array.isArray(result) ? result[0] : result) as { output: { type: string; code: string; modules: Record<string, unknown> }[] }
    const chunk = output.output.find(item => item.type === 'chunk')!
    expect(chunk.code).toContain(peleNotice)
    expect(() => assertPeleNotice(chunk.code.replace(peleNotice, ''))).toThrow('Missing complete Pele')
    expect(() => peleNoticeGuard().generateBundle({}, { chunk: { ...chunk, code: chunk.code.replace(peleNotice, '') } })).toThrow('Missing complete Pele')
  })
})
