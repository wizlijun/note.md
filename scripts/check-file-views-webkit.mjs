#!/usr/bin/env node
// Native macOS WKWebView check. Uses fixture data and ephemeral browser storage;
// never starts the actual note.md app or accesses its settings or Vault.
import { build } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'

if (process.platform !== 'darwin') throw new Error('Native WebKit QA requires macOS')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixture = path.join(repo, 'scripts/fixtures/file-views-webkit')
const plugin = path.join(repo, 'plugins-src/timeline/dist')
const output = await mkdtemp(path.join(os.tmpdir(), 'notemd-file-views-webkit.'))
console.log(`Native WebKit artifacts: ${output}`)

const pluginBuild = spawnSync('pnpm', ['--filter', 'timeline', 'build'], { cwd: repo, stdio: 'inherit' })
if (pluginBuild.status !== 0) process.exit(pluginBuild.status ?? 1)

await build({
  configFile: false, root: fixture, base: './', plugins: [svelte()],
  build: { target: 'safari15', outDir: path.join(output, 'host'), emptyOutDir: true },
})
// Read the production CSP literally, so changing it cannot silently leave the
// native test on a weaker policy. No private WebKit scheme registration is used.
const protocol = await readFile(path.join(repo, 'src-tauri/src/plugin_runtime/protocol.rs'), 'utf8')
const cspMatch = protocol.match(/pub fn csp_header\([^]*?\{\s*"([^]*?)"\s*\.to_string\(\)/)
if (!cspMatch) throw new Error('Could not extract production plugin CSP')
const csp = cspMatch[1].replace(/\\\n\s*/g, '')
await writeFile(path.join(output, 'plugin-csp.txt'), csp)
const html = await readFile(path.join(plugin, 'index.html'), 'utf8')
const jsPath = html.match(/src="\.\/(assets\/[^\"]+\.js)"/)?.[1]
if (!jsPath) throw new Error('Build Timeline before running native WebKit QA')
const identity = {
  pluginJS: jsPath,
  pluginSHA256: createHash('sha256').update(await readFile(path.join(plugin, jsPath))).digest('hex'),
  csp,
}
await writeFile(path.join(output, 'identity.json'), JSON.stringify(identity, null, 2))
const binary = path.join(output, 'wk-file-views')
for (const [command, args] of [
  ['xcrun', ['swiftc', path.join(fixture, 'main.swift'), '-o', binary]],
  [binary, [output, plugin, fixture]],
]) {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
