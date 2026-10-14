import { execFileSync } from 'node:child_process'
import { readFileSync, lstatSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { controlledEnvDir } from './controlled-env.mjs'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')

export function checkClean(root, allowPath, versionChanges = false) {
  const entries = allowPath ? JSON.parse(readFileSync(allowPath, 'utf8')) : []
  if (!Array.isArray(entries)) throw new Error('Expected an exact untracked preservation list')
  const allowed = new Set(), seen = new Set()
  for (const item of entries) {
    if (typeof item.path !== 'string' || item.path.startsWith('/') || item.path.split('/').some(p => !p || p === '.' || p === '..') || seen.has(item.path)) throw new Error('Invalid preservation path')
    seen.add(item.path)
    const stat = lstatSync(join(root, item.path))
    if (item.path === '.pnpm-store' && item.directory === true) {
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Expected existing .pnpm-store directory')
      allowed.add(item.path + '/')
    } else {
      if (!stat.isFile() || stat.isSymbolicLink() || !/^[a-f0-9]{64}$/.test(item.sha256) || sha(readFileSync(join(root, item.path))) !== item.sha256) throw new Error(`Preserved file changed: ${item.path}`)
      allowed.add(item.path)
    }
  }
  // Normal untracked reporting intentionally preserves the existing cache as a
  // directory. All other directory entries fail unless individually enumerated.
  const status = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=normal'], { cwd: root }).toString('utf8')
  for (const record of status.split('\0').filter(Boolean)) {
    if (versionChanges && /^ [M] /.test(record) && ['package.json', 'src-tauri/tauri.conf.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'CHANGELOG.md', 'CHANGELOG.zh-CN.md'].includes(record.slice(3))) continue
    if (!record.startsWith('?? ') || !allowed.has(record.slice(3))) throw new Error(`Working tree is dirty: ${record}`)
  }
  return { preserved: [...allowed], status }
}

export function checkFrozenShare(candidate, directory) {
  const expected = readFileSync(candidate)
  if (!expected.equals(readFileSync(join(directory, 'share-editor-manifest.json')))) throw new Error('Frozen share manifest changed')
  const manifest = JSON.parse(expected)
  if (manifest.apiVersion !== 1) throw new Error('Invalid share API version')
  for (const kind of ['js', 'css', 'mermaid']) {
    const asset = manifest[kind]
    if (!asset || !/^share-editor(?:-mermaid)?\.[a-f0-9]{64}\.(?:js|css)$/.test(asset.name)) throw new Error(`Invalid ${kind} asset`)
    const bytes = readFileSync(join(directory, 'assets', asset.name))
    if (sha(bytes) !== asset.sha256 || !asset.name.includes('.' + asset.sha256 + '.') || 'sha384-' + createHash('sha384').update(bytes).digest('base64') !== asset.sri) throw new Error(`Frozen ${kind} bytes changed`)
  }
  return { manifestSha256: sha(expected), resources: ['js', 'css', 'mermaid'] }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, ...args] = process.argv.slice(2)
  if (command === 'clean' || command === 'version-changes') console.log(JSON.stringify(checkClean(process.cwd(), args[0], command === 'version-changes')))
  else if (command === 'share') console.log(JSON.stringify(checkFrozenShare(args[0], args[1] ?? 'dist')))
  else if (command === 'env') {
    if (!controlledEnvDir()) throw new Error('Controlled release requires NOTEMD_EMPTY_ENV_DIR')
    console.log('Empty envDir verified')
  } else throw new Error('Expected clean, share or env')
}
