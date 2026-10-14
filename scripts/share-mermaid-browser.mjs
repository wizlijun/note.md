import { createHash } from 'node:crypto'
// Browser-only global detection fallback. Preserve every diagram module and
// reject upstream drift instead of rewriting arbitrary dynamic code.
const approved = [
  { suffix: '/@mermaid-js/parser/dist/chunks/mermaid-parser.core/chunk-FOHPRMQF.mjs', sha256: '5c83305b04a62463567bdf6d82d9ba9dfc3795e516d8cc848e6981504af48068', count: 2 },
  { suffix: '/cytoscape/dist/cytoscape.esm.mjs', sha256: '485cbbede29dac6028e96c89a895b2e3cbe26abaf3457049a5913e0f8ad53451', count: 1 },
  { suffix: '/lodash-es/_root.js', sha256: 'df58ff96c454ca91ace20d20e6af49b354c70dfba7e737adc00cd23e8ff77168', count: 1 },
]
export function shareMermaidBrowser(records) {
  return { name: 'share-mermaid-browser-global', enforce: 'pre', transform(source, id) {
    const entry = approved.find(row => id.endsWith(row.suffix))
    if (!entry) return null
    const hash = createHash('sha256').update(source).digest('hex'), pattern = /Function\((['"])return this\1\)\(\)/g
    const count = [...source.matchAll(pattern)].length
    if (hash !== entry.sha256 || count !== entry.count) throw Error('Mermaid browser global source changed: ' + id)
    records.push({ id, sha256: hash, count })
    return { code: source.replace(pattern, 'globalThis'), map: null }
  }, buildEnd(error) {
    if (!error && (records.length !== approved.length || records.reduce((sum, row) => sum + row.count, 0) !== 4)) throw Error('Missing approved Mermaid browser globals')
  } }
}
