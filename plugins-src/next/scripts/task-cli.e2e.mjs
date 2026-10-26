import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Exercise the exact standalone bytes shipped to Vault skills, without importing
// TypeScript or reaching a real Vault, owner resolver, or provider.
const distribution = fileURLToPath(new URL('../dist-cli/', import.meta.url))
test('distributed CLI: create without due, add due, complete, retry safely', async () => {
  const manifest = JSON.parse(await readFile(path.join(distribution, 'build-manifest.json'), 'utf8'))
  const bundle = path.join(distribution, manifest.artifact.file)
  assert.equal(createHash('sha256').update(await readFile(bundle)).digest('hex'), manifest.artifact.sha256)
  const root = await mkdtemp(path.join(tmpdir(), 'next-distributed-cli-'))
  const call = request => {
    const result = spawnSync(process.execPath, [bundle, '--vault', root], { input: JSON.stringify(request), encoding: 'utf8' })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    const value = JSON.parse(result.stdout)
    assert.equal(value.ok, true)
    return value
  }
  try {
    const created = call({ action: 'create', mode: 'background', evidence: 'synthetic test obligation', authority: { owner_id: 'test-owner', evidence: 'synthetic test authority' }, input: { title: '提交合同', description: '临时Vault测试', dedupe_key: 'obligation:test-contract', producer: 'task-cli-test/1', tags: ['test'], sources: [{ id: 'test', resource: 'synthetic:test' }] } })
    assert.equal(created.task.due, undefined)
    const auth = { mode: 'explicit_user', evidence: 'synthetic user request', producer: 'task-cli-test/1' }
    const updated = call({ ...auth, action: 'update', task_id: created.task_id, expected_revision: created.revision, patch: { due: '2026-10-30' } })
    assert.equal(updated.task_id, created.task_id)
    assert.equal(updated.task.due, '2026-10-30')
    assert.match(await readFile(path.join(root, created.path), 'utf8'), /due: "2026-10-30"/)
    const complete = { ...auth, action: 'transition', task_id: created.task_id, expected_revision: updated.revision, operation_id: 'synthetic-done', transition: 'done' }
    assert.equal(call(complete).outcome, 'done')
    assert.equal(call(complete).replayed, true)
    assert.equal(call({ action: 'list' }).tasks[0].state, 'closed')
  } finally { await rm(root, { recursive: true, force: true }) }
})
