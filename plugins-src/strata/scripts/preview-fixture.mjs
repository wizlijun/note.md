/** Offline browser QA harness. Serves the production build with synthetic Host RPC.
 * Never shipped in the plugin package; never reads a user Vault or invokes an Agent.
 * Usage: node scripts/preview-fixture.mjs [port]
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, resolve, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../dist')
const groups = ['产品判断', '团队协作', '研究方法', '写作系统', '技术架构']
const names = ['从证据形成判断', '决定之前写下条件', '每次复盘留下限制', '用原文验证观点', '把问题拆成可验证假设', '记录不同意见', '区分事实与推断', '用小实验减少未知']
const files = [], nodes = [], relations = []
for (let i = 0; i < 40; i++) {
  const hash = `fixture-${i}`, id = `node-${i}`, date = `2026-09-${String(1 + i % 30).padStart(2, '0')}`
  const state = i % 7 === 0 ? 'candidate' : 'verified', quote = `这是合成验收材料：${names[i % 8]}，并保留适用范围。`
  files.push({ fileKey: `source-${i}`, path: `fixture/${groups[Math.floor(i / 8)]}/${i}.md`, contentHash: hash, title: names[i % 8], conceptType: null, tags: [groups[Math.floor(i / 8)]], docDate: date, dateInferred: i % 9 === 0, indexOrigin: i % 4 ? 'human' : 'source', humanVerified: false, attentionMinutes: 1, filePriority: 1 + i % 4 * .35, confidentiality: i % 6 ? 'unknown' : 'explicitly_public', links: [] })
  nodes.push({ id, title: `${names[i % 8]} · ${groups[Math.floor(i / 8)]}`, kind: 'insight', state, features: [groups[Math.floor(i / 8)], `主题${Math.floor(i / 4)}`, names[i % 8]], links: [], ownerSpecificity: i % 3 ? 'owner_specific' : 'general', confidentiality: files[i].confidentiality, classificationReason: '合成数据：用于验收个人独有与保密性分别展示。', epistemic: '合成陈述；不是用户真实知识。', speaker: '验收样例', conditions: ['用于交互验收'], limits: ['不代表用户事实'], sourceGroups: [{ groupId: `source:${hash}`, groupVersion: '1', priority: files[i].filePriority, dates: [date], canonicalIds: [id] }], evidence: state === 'verified' ? [{ id: `e-${i}`, sourceId: files[i].fileKey, path: files[i].path, contentHash: hash, blockKey: `b-${i}`, lineStart: 4, lineEnd: 4, quote }] : [] })
  if (i % 8 && state === 'verified' && nodes[i - 1].state === 'verified') relations.push({ id: `r-${i}`, source: id, target: nodes[i - 1].id, type: 'supports', title: '合成关系', evidence: nodes[i].evidence })
}
let atlas = null
const csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname
    if (path === '/favicon.ico') { res.writeHead(204); res.end(); return }
    res.setHeader('Content-Security-Policy', csp)
    if (path === '/fixture-bridge.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(`window.notemd={request:async(method,params={})=>{const r=await fetch('/rpc',{method:'POST',body:JSON.stringify({method,params})});const v=await r.json();if(v.error)throw Error(v.error);return v}};window.addEventListener('error',e=>fetch('/events',{method:'POST',body:String(e.message)}));window.addEventListener('unhandledrejection',e=>fetch('/events',{method:'POST',body:String(e.reason)}));document.title='STRATA · 合成数据验收';`); return }
    if (path === '/rpc' || path === '/events') {
      let body = ''; for await (const b of req) body += b
      res.setHeader('Content-Type', 'application/json')
      if (path === '/events') { console.error('BROWSER ERROR', body); res.end('{}'); return }
      const { method, params } = JSON.parse(body); let output = {}
      if (method === 'host.settings.get') output = { settings: { browser: { from: '2026-09-01', to: '2026-09-30', view: '3d' } } }
      if (method === 'host.agent.providers') output = { providers: [], default: '' }
      if (method === 'plugin.atlas.load') output = { atlas }
      if (method === 'plugin.atlas.save') atlas = params.atlas
      if (method === 'host.index.status') output = { valid: true, freshness: 'current' }
      if (method === 'plugin.open_source') output = { path: files[Number(params.nodeId.split('-')[1])].path }
      if (method === 'host.editor.open') console.log('VALIDATED FIXTURE SOURCE', params.path)
      if (method === 'plugin.snapshot') { const selected = files.filter(f => f.docDate >= params.from && f.docDate <= params.to); output = { schema: 'notemd.strata/snapshot/v1', vaultKey: 'fixture-only', snapshotId: 'fixture-snapshot', configHash: 'fixture-config', asOf: '2026-09-30', range: params, files, nodes, relations, job: null, coverage: { indexed: 40, selected: selected.length, processed: selected.filter(f => nodes[files.indexOf(f)].state === 'verified').length, candidate: selected.filter(f => nodes[files.indexOf(f)].state === 'candidate').length, excluded: 0, stale: 0, proofDeferred: 0, dateInferred: selected.filter(f => f.dateInferred).length, confidential: 0, unknownConfidentiality: selected.filter(f => f.confidentiality === 'unknown').length } } }
      if (method === 'plugin.extract') output = { error: 'Fixture harness never invokes AI.' }
      res.end(JSON.stringify(output)); return
    }
    const requested = resolve(root, '.' + (path === '/' ? '/index.html' : path))
    if (!requested.startsWith(root + '/')) { res.writeHead(403); res.end(); return }
    let body = await readFile(requested)
    if (extname(requested) === '.html') body = Buffer.from(body.toString().replace('<head>', '<head><script src="/fixture-bridge.js"></script>'))
    res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' })[extname(requested)] || 'application/octet-stream')
    res.end(body)
  } catch (e) { console.error(e.message); res.writeHead(500); res.end('Fixture error') }
})
server.listen(Number(process.argv[2] || 8767), '127.0.0.1', () => console.log('Synthetic production UI QA: http://127.0.0.1:' + server.address().port))
