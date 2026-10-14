import { createRequire } from 'node:module'
import { resolve } from 'node:path'
const require = createRequire(import.meta.url)
const { build } = createRequire(require.resolve('vite/package.json'))('esbuild')

/** Compile the inline reader from the same modules used by the enhanced editor. */
export function projectShareBrowserSource() {
  const id = 'virtual:project-share-browser', resolved = '\0' + id
  let root, inputs = new Set()
  return {
    name: 'project-share-browser-source',
    configResolved(config) { root = config.root },
    resolveId(source) { if (source === id) return resolved },
    async load(source) {
      if (source !== resolved) return
      const result = await build({ absWorkingDir: root, entryPoints: ['src/lib/project-share/browser-entry.ts'],
        bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'NotemdProjectBrowser',
        tsconfigRaw: { compilerOptions: { alwaysStrict: true, useDefineForClassFields: true } },
        target: 'safari15', minify: true, metafile: true, legalComments: 'none',
      })
      const allowed = new Set(['src/lib/project-share/browser-entry.ts', 'src/lib/project-share/browser.ts',
        'src/editor-kit-v2/source-projection.ts', 'src/share-editor/owner-policy.ts', 'src/share-editor/media-policy.ts',
        'src/lib/share-merge/critic.ts', 'src/lib/share-merge/anchor.ts', 'src/lib/share-merge/hash.ts', 'src/lib/share-merge/diff.ts'])
      for (const path of Object.keys(result.metafile.inputs)) {
        if (!allowed.has(path)) throw Error('Unexpected inline reader dependency: ' + path)
      }
      if (result.outputFiles.length !== 1 || Object.values(result.metafile.outputs).some(output => output.imports.length)) throw Error('Inline reader must have no external runtime imports')
      inputs = new Set(Object.keys(result.metafile.inputs).map(path => resolve(root, path)))
      for (const path of inputs) this.addWatchFile(path)
      // No source cache: rebuild on invalidation so development cannot reuse stale policy.
      return 'export default ' + JSON.stringify(result.outputFiles[0].text)
    },
    handleHotUpdate({ file, server, modules }) {
      if (!inputs.has(file)) return
      const module = server.moduleGraph.getModuleById(resolved)
      if (module) { server.moduleGraph.invalidateModule(module); return [...modules, module] }
    },
  }
}
