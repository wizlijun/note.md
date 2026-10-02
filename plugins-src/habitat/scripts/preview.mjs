#!/usr/bin/env node
// Local, read-only developer preview. Never writes the snapshot or serves its file.
import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const dist = resolve(dirname(fileURLToPath(import.meta.url)), '../dist')
const maxBytes = 256 * 1024 * 1024
const collection = new Map([['source', 'sources'], ['node', 'nodes'], ['evidence', 'evidence'], ['edge', 'edges'], ['membership', 'memberships'], ['lineage', 'lineage'], ['layout', 'layout']])
const unavailable = '本地只读预览不连接 note.md 宿主，不能重新解析、保存或读取 Git 历史。请在包含 HABITAT 新接口的源码版 note.md 中操作。'
const bridge = `window.notemd={request:async(method,params={})=>{const response=await fetch('/__habitat_preview_rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method,params})});const result=await response.json();if(result.error)throw new Error(result.error);return result}};`
const assetMime = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.glb': 'model/gltf-binary' }

export async function loadSnapshot(path) {
  const info = await stat(path)
  if (!info.isFile() || info.size === 0 || info.size > maxBytes) throw new Error('快照必须是不超过 256 MiB 的非空普通 JSONL 文件。')
  const snapshot = { meta: null, sources: [], nodes: [], evidence: [], edges: [], memberships: [], lineage: [], layout: [] }
  const input = createReadStream(path, { encoding: 'utf8' })
  const lines = createInterface({ input, crlfDelay: Infinity })
  let number = 0
  try {
    for await (const line of lines) {
      number++
      if (!line.trim()) continue
      let record
      try { record = JSON.parse(line) } catch { throw new Error(`快照第 ${number} 行不是有效 JSON；请使用解压后的标准 JSONL。`) }
      if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error(`快照第 ${number} 行应为记录对象。`)
      const { kind, ...data } = record
      if (kind === 'meta') { if (snapshot.meta) throw new Error('快照包含重复 meta 记录。'); snapshot.meta = data }
      else if (collection.has(kind)) { if (typeof data.id !== 'string') throw new Error(`快照第 ${number} 行缺少记录 id。`); snapshot[collection.get(kind)].push(data) }
      else throw new Error(`快照第 ${number} 行含不支持的记录类型。`)
    }
  } finally { lines.close(); input.destroy() }
  if (snapshot.meta?.schema !== 'vault-knowledge-structure/1' || !snapshot.meta.coverage || !snapshot.meta.algorithm || typeof snapshot.meta.snapshotId !== 'string') throw new Error('快照缺少有效的 vault-knowledge-structure/1 元数据。')
  return snapshot
}

async function assetsIn(directory) {
  const assets = new Map()
  async function visit(path, prefix) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const key = `${prefix}/${entry.name}`, full = join(path, entry.name)
      if (entry.isDirectory()) await visit(full, key)
      else if (entry.isFile() && assetMime[extname(entry.name)]) assets.set(key, await readFile(full))
    }
  }
  await visit(directory, '')
  const html = assets.get('/index.html')
  if (!html) throw new Error('缺少 dist/index.html，请先构建 HABITAT 前端。')
  assets.set('/index.html', Buffer.from(html.toString().replace('<head>', '<head><script src="/__habitat_preview_bridge.js"></script>')))
  return assets
}

export async function startPreview({ snapshotPath, port = 8787, distDir = dist }) {
  const snapshot = await loadSnapshot(snapshotPath), assets = await assetsIn(distDir)
  const state = JSON.stringify({ vaultKey: 'local-readonly-preview', snapshot: null, preview: snapshot, job: null, pending: false, historyAvailable: false, readOnlyPreview: true })
  let boundPort = port
  const server = createServer(async (request, response) => {
    const send = (status, body, type = 'application/json; charset=utf-8') => { response.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) }); response.end(request.method === 'HEAD' ? undefined : body) }
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'")
    const hosts = [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`]
    if (!hosts.includes(request.headers.host ?? '')) return send(403, JSON.stringify({ error: '预览只接受本机 Host。' }))
    if (request.headers.origin && request.headers.origin !== `http://${request.headers.host}`) return send(403, JSON.stringify({ error: '预览拒绝跨域访问。' }))
    try {
      const path = new URL(request.url ?? '/', `http://127.0.0.1:${boundPort}`).pathname
      if (path === '/__habitat_preview_rpc' && request.method === 'POST') {
        let size = 0, body = ''
        for await (const part of request) { size += part.length; if (size > 8192) return send(413, JSON.stringify({ error: '请求过大。' })); body += part }
        let payload
        try { payload = JSON.parse(body) } catch { return send(400, JSON.stringify({ error: '请求不是有效 JSON。' })) }
        if (payload.method === 'plugin.state') return send(200, state)
        const message = payload.method === 'plugin.open_source' || payload.method === 'host.editor.open' ? '本地预览仅显示来源路径和定位信息；请在 note.md 中核对来源版本后打开原文。' : unavailable
        return send(400, JSON.stringify({ error: message }))
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') return send(405, JSON.stringify({ error: '只读预览不支持此请求。' }))
      if (path === '/__habitat_preview_bridge.js') return send(200, bridge, 'application/javascript; charset=utf-8')
      const key = path === '/' ? '/index.html' : path, content = assets.get(key)
      if (!content) return send(404, JSON.stringify({ error: '资源不存在。' }))
      const mime = assetMime[extname(key)]
      send(200, content, mime)
    } catch { if (!response.headersSent) send(500, JSON.stringify({ error: '本地预览请求失败。' })); else response.end() }
  })
  await new Promise((resolveReady, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolveReady) })
  boundPort = server.address().port
  return { server, url: `http://127.0.0.1:${boundPort}`, nodes: snapshot.nodes.length }
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--help')) { console.log('用法: pnpm --filter habitat-plugin preview --snapshot /绝对路径/snapshot.jsonl [--port 8787]\n只监听 127.0.0.1；只读预览，不保存到 Vault，不提供 Git 历史。'); return }
  let snapshotPath, port = 8787
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--snapshot' && args[i + 1]) snapshotPath = resolve(args[++i])
    else if (args[i] === '--port' && args[i + 1]) port = Number(args[++i])
    else throw new Error(`无法识别参数 ${args[i]}；使用 --help 查看用法。`)
  }
  if (!snapshotPath) throw new Error('请用 --snapshot 指定标准 JSONL 快照；不会注入示例数据。')
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--port 必须在 1–65535 之间。')
  const { server, url, nodes } = await startPreview({ snapshotPath, port })
  console.log(`HABITAT 只读预览 · 未存入 Vault\n${url}\n${nodes.toLocaleString()} 个对象；Ctrl+C 停止。`)
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => process.exit(0)))
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(`HABITAT 预览失败: ${error.message}`); process.exitCode = 1 })
