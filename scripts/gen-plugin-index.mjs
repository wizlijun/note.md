#!/usr/bin/env node
// Build the marketplace registry index from packaged plugins (子项目③ Task 5).
//
//   node scripts/gen-plugin-index.mjs
//
// Scans dist-plugins/<id>/<version>/ produced by scripts/release-plugins.sh:
//   - reads the manifest.json that release-plugins.sh drops next to the packages
//   - finds every <arch>.notemdpkg sibling (arch = the triple, or "universal"
//     for ui-only plugins)
//   - computes each package's size + sha256
//   - emits one RegistryEntry per <id>/<version> into dist-plugins/index.json
//
// The output shape mirrors src-tauri/src/plugin_runtime/market.rs RegistryEntry
// and is what the CF Worker serves at GET /api/index.json.
//
// Does NOT upload. Tail prints the wrangler kv command as guidance.

import { readFileSync, readdirSync, writeFileSync, statSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_ROOT = join(REPO_ROOT, 'dist-plugins')
const REGISTRY_BASE = 'https://plugins.notemd.net'

function sha256Hex(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function dirsIn(path) {
  if (!existsSync(path)) return []
  return readdirSync(path, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
}

function pkgsIn(path) {
  return readdirSync(path, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.notemdpkg'))
    .map((d) => d.name)
}

function buildEntry(idDirName, version, versionDir) {
  const manifestPath = join(versionDir, 'manifest.json')
  if (!existsSync(manifestPath)) {
    throw new Error(`missing manifest.json in ${versionDir} — run scripts/release-plugins.sh first`)
  }
  const m = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const id = m.id ?? idDirName

  // arch = the .notemdpkg basename without extension: a triple, or "universal".
  const archs = []
  const sha256 = {}
  const download = {}
  const sizes = []
  for (const file of pkgsIn(versionDir).sort()) {
    const arch = file.replace(/\.notemdpkg$/, '')
    const pkgPath = join(versionDir, file)
    archs.push(arch)
    sha256[arch] = sha256Hex(pkgPath)
    sizes.push(statSync(pkgPath).size)
    download[arch] = `${REGISTRY_BASE}/api/download/${id}/${version}/${arch}`
  }
  if (archs.length === 0) {
    throw new Error(`no .notemdpkg found in ${versionDir}`)
  }

  return {
    id,
    version: m.version ?? version,
    // min_host = the engines.notemd semver range verbatim (e.g. ">=6.716.7").
    min_host: m.engines?.notemd ?? '>=0.0.0',
    archs,
    // size = the largest package (single number in RegistryEntry); per-arch
    // exactness lives in sha256/download maps.
    size: Math.max(...sizes),
    sha256,
    name: m.name ?? id,
    description: m.description ?? null,
    i18n: m.i18n ?? null,
    icon_url: m.icon_url ?? null,
    changelog_url: m.changelog_url ?? null,
    download,
  }
}

function main() {
  if (!existsSync(OUT_ROOT)) {
    console.error(`no dist-plugins/ — run scripts/release-plugins.sh first`)
    process.exit(1)
  }

  const plugins = []
  for (const idDirName of dirsIn(OUT_ROOT).sort()) {
    const idDir = join(OUT_ROOT, idDirName)
    for (const version of dirsIn(idDir).sort()) {
      const versionDir = join(idDir, version)
      // Skip dirs with no packages (e.g. a stale manifest-only leftover).
      if (pkgsIn(versionDir).length === 0) continue
      plugins.push(buildEntry(idDirName, version, versionDir))
    }
  }

  const index = { plugins }
  const outPath = join(OUT_ROOT, 'index.json')
  writeFileSync(outPath, JSON.stringify(index, null, 2) + '\n')
  console.log(`wrote ${outPath} (${plugins.length} plugin version(s))`)

  console.log('\n── publish the index (user step) ──────────────────────────────')
  console.log('  wrangler kv key put index --path dist-plugins/index.json')
}

main()
