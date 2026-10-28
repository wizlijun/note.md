// Called by the opt-in Rust test with its production config and temporary Vault.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
const [config, vault, notemd, dshInstall, dsh] = process.argv.slice(2)
const requireDsh = createRequire(join(dshInstall, 'package.json'))
const rows = JSON.parse(readFileSync(config, 'utf8'))[0].insert
const dumped = spawnSync(dsh, ['--profile', 'notemd-strict', '--patch', config, '--dump-config'], { encoding: 'utf8', timeout: 30_000 })
assert.equal(dumped.status, 0, dumped.stderr)
for (const forbidden of ['dsh-mcp', 'dsh-settings-file', 'dsh-skill', 'dsh-agent-instructions', 'dsh-hooks']) assert(!dumped.stdout.includes(forbidden))
const { Context } = await import(pathToFileURL(requireDsh.resolve('@deepseek-ai/cordis')).href)
const ctx = new Context()
try {
  // ACP is transport only. Mount the exact production graph underneath it to
  // exercise native tool registration and execution without a model request.
  for (const row of rows.filter(row => row.id !== 'acp')) {
    const mod = await import(pathToFileURL(requireDsh.resolve(row.name)).href)
    await ctx.plugin(mod.default ?? mod, row.config ?? {})
  }
  await new Promise(resolve => setImmediate(resolve))
  const names = ctx.tools.schemas().map(tool => tool.name).sort()
  for (const name of ['bash', 'read', 'web_search']) assert(names.includes(name), `${name} did not mount: ${names}`)
  assert.deepEqual(names, ['bash', 'edit', 'read', 'web_search', 'write'])
  const invoke = (name, args) => ctx.tools.execute({ callId: `probe-${name}`, name, arguments: args, signal: AbortSignal.timeout(30_000) })
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`
  const search = await invoke('bash', { command: `${quote(notemd)} search KickoffNeedleAlpha --vault ${quote(vault)} --json`, description: 'Verify read only temporary Vault search', workdir: vault })
  assert(!search.isError, JSON.stringify(search))
  assert.match(JSON.stringify(search), /KickoffNeedleAlpha/)
  const fetch = await invoke('bash', {
    command: "curl -q -fsSL --proto '=https' --proto-redir '=https' --max-time 20 --max-filesize 1000000 https://developers.openai.com/codex/security/",
    description: 'Read official public security documentation without files', workdir: vault,
  })
  assert(!fetch.isError, JSON.stringify(fetch))
  assert.match(JSON.stringify(fetch), /[Ss]ecurity|[Ss]andbox/)
  const read = await invoke('read', { file_path: join(vault, 'sample.md') })
  assert(!read.isError, JSON.stringify(read))
  assert.match(JSON.stringify(read), /KickoffNeedleAlpha/)
  const denied = await invoke('write', { file_path: join(vault, 'forbidden.md'), content: 'forbidden' })
  assert(denied.isError, 'native write must be denied')
  assert(!existsSync(join(vault, 'forbidden.md')))
  const escalated = await invoke('bash', { command: `touch ${quote(join(vault, 'forbidden.md'))}`, description: 'Probe denied synthetic sandbox escalation', workdir: vault, sandbox_permissions: 'workspace-write', justification: 'Synthetic denial verification' })
  assert(escalated.isError, 'sandbox escalation must be denied')
  assert(!existsSync(join(vault, 'forbidden.md')))
  assert.equal(readFileSync(join(vault, 'sample.md'), 'utf8'), 'KickoffNeedleAlpha related context.\n')
  console.log(JSON.stringify({ tools: names, cli_search: 'passed', native_read: 'passed', public_page_readback: 'passed via sandboxed bash curl', web_fetch: 'not mounted', native_write: 'denied', escalation: 'denied', inherited_extensions: 'absent' }))
} finally {
  await ctx.fiber.dispose()
}
