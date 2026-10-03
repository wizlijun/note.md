import assert from 'node:assert/strict'
import test from 'node:test'
import { get } from 'node:http'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, cp } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
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

test('bundled city models and every texture resolve locally with correct MIME and verified bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'habitat-city-assets-'))
  let server
  try {
    const models = fileURLToPath(new URL('../public/models/', import.meta.url))
    const manifest = JSON.parse(await readFile(join(models, 'manifest.json'), 'utf8'))
    const distDir = join(root, 'dist'), snapshotPath = join(root, 'snapshot.jsonl')
    await mkdir(distDir); await cp(models, join(distDir, 'models'), { recursive: true })
    await writeFile(join(distDir, 'index.html'), '<html><head></head><body>city</body></html>')
    await writeFile(snapshotPath, rows.map(row => JSON.stringify(row)).join('\n'))
    const result = await startPreview({ snapshotPath, distDir, port: 0 }); server = result.server
    for (const file of manifest.files) {
      const url = `${result.url}/models/${file.path}`, response = await fetch(url)
      assert.equal(response.status, 200, file.path)
      const bytes = Buffer.from(await response.arrayBuffer())
      assert.equal(bytes.length, file.bytes, file.path)
      assert.equal(Number(response.headers.get('content-length')), file.bytes, file.path)
      const head = await fetch(url, { method: 'HEAD' })
      assert.equal(Number(head.headers.get('content-length')), file.bytes)
      assert.equal((await head.arrayBuffer()).byteLength, 0)
      assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256, file.path)
      if (file.path.endsWith('.glb')) {
        assert.equal(response.headers.get('content-type'), 'model/gltf-binary')
        assert.equal(bytes.readUInt32LE(0), 0x46546c67)
        const gltf = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString())
        for (const resource of [...(gltf.images ?? []), ...(gltf.buffers ?? [])]) {
          if (!resource.uri || resource.uri.startsWith('data:')) continue
          const dependency = new URL(resource.uri, url)
          assert.equal(dependency.origin, result.url, 'models must not require remote assets')
          const texture = await fetch(dependency)
          assert.equal(texture.status, 200, dependency.href)
          if (resource.uri.endsWith('.png')) assert.equal(texture.headers.get('content-type'), 'image/png')
        }
      }
    }
    for (const path of ['/models/missing.glb', '/models/nature/Textures/missing.png', '/models/manifest.json']) assert.equal((await fetch(result.url + path)).status, 404)
  } finally { if (server) await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }) }
})

for (const version of [3, 5, 6]) test(`reads focus/${version} attention and dated observations using their actual record identities`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'habitat-preview-focus-'))
  try {
    const path = join(root, 'focus.jsonl')
    const records = [
      { ...rows[0], schema: 'vault-knowledge-structure/2', algorithm: { version: `habitat-focus/${version}` }, focus: { asOf: '2026-10-02', windowDays: 30, utcOffsetMinutes: 480 } },
      rows[1],
      { kind: 'attention', node: 'n', score: .7, category: 'concept', activeDays: 3, events: 4, evidence: ['e'], lastObservedAt: '2026-10-01' },
      { kind: 'attention_observation', evidence: 'e', date: '2026-10-01', eventId: 'event', signal: 'agent_user', dateBasis: 'same_day_session', confidence: .9 }
    ]
    await writeFile(path, records.map(record => JSON.stringify(record)).join('\n'))
    const snapshot = await loadSnapshot(path)
    assert.equal(snapshot.attention[0].node, 'n')
    assert.equal(snapshot.attention[0].category, 'concept')
    assert.equal(snapshot.attentionObservations[0].evidence, 'e')
    assert.equal(snapshot.meta.focus.windowDays, 30)
    assert.equal(snapshot.meta.algorithm.version, `habitat-focus/${version}`)
  } finally { await rm(root, { recursive: true, force: true }) }
})
