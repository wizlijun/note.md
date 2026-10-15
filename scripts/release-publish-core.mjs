import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createInterface } from 'node:readline/promises'

const tagPattern = /^v\d+\.\d+\.\d+$/
function fail(message) { throw new Error(message) }
function versionOf(tag) {
  if (!tagPattern.test(tag || '')) fail('expected an exact vX.Y.Z tag')
  return tag.slice(1)
}

/** Assets use gh's name/url fields plus downloaded content (signatures/checksums)
 * and sha256 (debs). This validates evidence; it does not cryptographically verify
 * updater payloads or replace the existing signed macOS/Windows build gates.
 */
export function validateRelease({ tag, draft, assets, latest, without }) {
  const version = versionOf(tag)
  if (draft !== true) fail('release must be an existing draft')
  if (without !== undefined && !['windows', 'linux'].includes(without)) fail('invalid omitted platform')
  if (!Array.isArray(assets)) fail('missing release assets')
  const byName = new Map()
  for (const asset of assets) {
    if (!asset || typeof asset.name !== 'string' || byName.has(asset.name)) fail('invalid/duplicate asset')
    byName.set(asset.name, asset)
  }
  const requireAsset = name => byName.get(name) || fail(`missing release asset: ${name}`)
  const manifestAsset = requireAsset('latest.json')
  const manifestURL = new URL(manifestAsset.url)
  if (manifestURL.protocol !== 'https:' || manifestURL.hostname !== 'github.com' ||
      !new RegExp(`^/[^/]+/[^/]+/releases/download/${tag.replaceAll('.', '\\.')}/latest\\.json$`).test(manifestURL.pathname) ||
      manifestURL.search || manifestURL.hash) fail('latest.json asset URL is not the current tag')
  const base = manifestAsset.url.slice(0, -'latest.json'.length)
  const requireCurrentAsset = name => {
    const asset = requireAsset(name)
    if (asset.url !== base + name) fail(`asset URL is not current tag/name: ${name}`)
    return asset
  }
  for (const arch of ['aarch64', 'x86_64']) requireCurrentAsset(`note.md-${version}-${arch}.dmg`)
  if (!latest || latest.version !== version || !latest.platforms || Array.isArray(latest.platforms) || typeof latest.platforms !== 'object') fail('manifest version/platforms mismatch')
  const expected = {
    'darwin-aarch64': 'note.md-aarch64.app.tar.gz',
    'darwin-x86_64': 'note.md-x86_64.app.tar.gz',
  }
  if (without !== 'windows') expected['windows-x86_64'] = `note.md_${version}_x64-setup.exe`
  for (const key of Object.keys(latest.platforms)) {
    if (key.startsWith('linux-')) fail('Linux package-manager builds must never appear in latest.json')
    if (key.startsWith('windows-') && without === 'windows') fail('stale updater reference to omitted Windows assets')
    if (key === 'windows-aarch64') expected[key] = `note.md_${version}_arm64-setup.exe`
    if (key === 'windows-i686') expected[key] = `note.md_${version}_x86-setup.exe`
    if (!Object.hasOwn(expected, key)) fail(`unsupported updater platform: ${key}`)
  }
  for (const [platform, name] of Object.entries(expected)) {
    const payload = requireCurrentAsset(name), signature = requireCurrentAsset(name + '.sig')
    const entry = latest.platforms[platform]
    if (!entry || entry.url !== payload.url) fail(`missing/mismatched updater URL: ${platform}`)
    if (typeof entry.signature !== 'string' || !entry.signature.trim() ||
        typeof signature.content !== 'string' || entry.signature.trim() !== signature.content.trim()) fail(`updater signature mismatch: ${platform}`)
  }
  if (without !== 'linux') {
    const checksum = requireCurrentAsset('SHA256SUMS-linux.txt')
    const lines = typeof checksum.content === 'string' ? checksum.content.trim().split(/\r?\n/) : []
    if (lines.length !== 2) fail('Linux checksums must contain exactly two debs')
    const hashes = new Map()
    for (const line of lines) {
      const match = /^([a-fA-F0-9]{64}) [ *](note\.md_\d+\.\d+\.\d+_(?:amd64|arm64)\.deb)$/.exec(line)
      if (!match || hashes.has(match[2])) fail('invalid/duplicate Linux checksum entry')
      hashes.set(match[2], match[1].toLowerCase())
    }
    for (const arch of ['amd64', 'arm64']) {
      const name = `note.md_${version}_${arch}.deb`, asset = requireCurrentAsset(name)
      if (!/^[a-f0-9]{64}$/.test(asset.sha256 || '') || hashes.get(name) !== asset.sha256) fail(`Linux checksum mismatch: ${name}`)
    }
  }
  return { version }
}

async function main(args) {
  const tag = args.shift()
  versionOf(tag)
  let without
  if (args.length) {
    if (args.length !== 2 || args[0] !== '--without' || !['windows', 'linux'].includes(args[1])) fail('usage: release-publish.sh <tag> [--without windows|linux]')
    without = args[1]
    if (!process.stdin.isTTY || !process.stdout.isTTY) fail('--without requires an interactive terminal; no automatic approval is allowed')
  }
  const repo = process.env.GH_REPO || 'wizlijun/note.md'
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) fail('invalid GH_REPO')
  const gh = argv => {
    const result = spawnSync('gh', ['-R', repo, ...argv], { encoding: 'utf8' })
    if (result.error || result.status !== 0) fail(`gh ${argv[1]} failed: ${result.error?.message || result.stderr}`)
    return result.stdout
  }
  const release = JSON.parse(gh(['release', 'view', tag, '--json', 'tagName,isDraft,isPrerelease,assets']))
  if (release.tagName !== tag || release.isDraft !== true || typeof release.isPrerelease !== 'boolean') fail('expected the exact existing draft tag and prerelease status')
  const root = mkdtempSync(join(tmpdir(), 'notemd-release-publish-'))
  try {
    const assets = release.assets.map(asset => ({ ...asset }))
    const download = name => {
      const asset = assets.find(a => a.name === name)
      if (!asset || asset.url !== `https://github.com/${repo}/releases/download/${tag}/${name}`) fail(`missing/current-tag asset: ${name}`)
      gh(['release', 'download', tag, '--pattern', name, '--dir', root])
      return readFileSync(join(root, name))
    }
    const latest = JSON.parse(download('latest.json').toString('utf8'))
    for (const asset of assets) {
      if (asset.name.endsWith('.sig')) asset.content = download(asset.name).toString('utf8')
    }
    if (without !== 'linux') {
      const checksums = download('SHA256SUMS-linux.txt')
      assets.find(a => a.name === 'SHA256SUMS-linux.txt').content = checksums.toString('utf8')
      for (const arch of ['amd64', 'arm64']) {
        const name = `note.md_${tag.slice(1)}_${arch}.deb`, bytes = download(name)
        assets.find(a => a.name === name).sha256 = createHash('sha256').update(bytes).digest('hex')
      }
    }
    validateRelease({ tag, draft: release.isDraft, assets, latest, without })
    if (without) {
      const exact = `${tag} without ${without}`
      const terminal = createInterface({ input: process.stdin, output: process.stdout })
      try {
        const answer = await terminal.question(`Type exactly "${exact}" to publish with this omission: `)
        if (answer !== exact) fail('omission confirmation did not match the exact tag/platform')
      } finally { terminal.close() }
    }
    // Re-read immediately before mutation so another operator cannot publish the
    // draft while this process was downloading assets or waiting for confirmation.
    const current = JSON.parse(gh(['release', 'view', tag, '--json', 'tagName,isDraft,isPrerelease,assets']))
    const identity = value => JSON.stringify({
      tag: value.tagName, draft: value.isDraft, prerelease: value.isPrerelease,
      assets: value.assets.map(({ id, name, url, size, updatedAt, state }) =>
        ({ id, name, url, size, updatedAt, state })).sort((a, b) => a.name.localeCompare(b.name)),
    })
    // Download counts legitimately increase as this verifier fetches evidence.
    if (identity(current) !== identity(release)) fail('release changed during validation; retry from fresh assets')
    gh(['release', 'edit', tag, '--draft=false', release.isPrerelease ? '--latest=false' : '--latest'])
    console.log(`Published ${tag}${release.isPrerelease ? ' (prerelease; not latest)' : ''}`)
  } finally { rmSync(root, { recursive: true, force: true }) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1 })
}
