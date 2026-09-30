import assert from 'node:assert/strict'
import test from 'node:test'
import { get } from 'node:http'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadSnapshot, startPreview } from './preview.mjs'

const rows = [{ kind: 'meta', schema: 'vault-knowledge-structure/1', snapshotId: 'test', algorithm: {}, coverage: {} }, { kind: 'node', id: 'n', nodeType: 'concept', label: '本地材料', status: 'candidate', evidence: [] }]
test('local preview serves only whitelisted assets and read-only state on its own origin', async () => {
  const root = await mkdtemp(join(tmpdir(), 'habitat-preview-'))
  let server
  try {
    const snapshotPath = join(root, 'snapshot.jsonl'), distDir = join(root, 'dist')
    const bytes = rows.map(row => JSON.stringify(row)).join('\n') + '\n'
    await writeFile(snapshotPath, bytes); await mkdir(distDir); await writeFile(join(distDir, 'index.html'), '<html><head></head><body>preview</body></html>')
    await writeFile(join(root, 'private.txt'), 'must not be served'); await symlink(join(root, 'private.txt'), join(distDir, 'leak.js'))
    const result = await startPreview({ snapshotPath, distDir, port: 0 }); server = result.server
    assert.equal(server.address().address, '127.0.0.1')
    const html = await fetch(result.url); assert.match(await html.text(), /__habitat_preview_bridge\.js/)
    assert.equal(html.headers.get('access-control-allow-origin'), null)
    for (const path of ['/snapshot.jsonl', '/leak.js', '/private.txt', '/%2e%2e/private.txt']) assert.equal((await fetch(result.url + path)).status, 404)
    const rpc = (method, headers = {}) => fetch(result.url + '/__habitat_preview_rpc', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ method, params: {} }) })
    const state = await (await rpc('plugin.state')).json()
    assert.equal(state.snapshot, null); assert.equal(state.readOnlyPreview, true); assert.equal(state.historyAvailable, false); assert.equal(state.preview.nodes.length, 1)
    for (const method of ['plugin.generate', 'plugin.history', 'plugin.retry_save', 'host.vault.write']) { const response = await rpc(method); assert.equal(response.status, 400); assert.match((await response.json()).error, /本地只读预览/) }
    const open = await (await rpc('plugin.open_source')).json(); assert.match(open.error, /仅显示来源路径和定位/)
    assert.equal((await rpc('plugin.state', { Origin: 'https://example.com' })).status, 403)
    assert.equal((await rpc('plugin.state', { Origin: result.url.replace('127.0.0.1', 'localhost') })).status, 403)
    const invalidHostStatus = await new Promise((resolve, reject) => get(result.url, { headers: { Host: 'example.com' } }, response => { response.resume(); resolve(response.statusCode) }).on('error', reject))
    assert.equal(invalidHostStatus, 403)
    assert.equal(await readFile(snapshotPath, 'utf8'), bytes)
  } finally { if (server) await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }) }
})
test('malformed JSONL fails with a line number and does not start a server', async () => {
  const root = await mkdtemp(join(tmpdir(), 'habitat-preview-invalid-'))
  try {
    const path = join(root, 'invalid.jsonl'); await writeFile(path, JSON.stringify(rows[0]) + '\nnot-json\n')
    await assert.rejects(loadSnapshot(path), /第 2 行不是有效 JSON/)
    await writeFile(path, ''); await assert.rejects(loadSnapshot(path), /非空普通 JSONL/)
    await writeFile(path, JSON.stringify({ kind: 'unexpected' })); await assert.rejects(loadSnapshot(path), /不支持的记录类型/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
