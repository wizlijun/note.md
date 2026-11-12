import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { validateCompanionMetadata } from './release-publish-core.mjs'

const approvalPath = join(dirname(fileURLToPath(import.meta.url)), 'release-companions/fcitx5.json')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')

// Stage only the approved modified build, never the newest arbitrary Downloads file.
export function stageCompanion({ approved, source, output }) {
  validateCompanionMetadata(approved)
  if (basename(source) !== approved.filename) throw new Error('Fcitx5 package filename differs from approved version')
  const bytes = readFileSync(source)
  if (bytes.length !== approved.bytes || sha(bytes) !== approved.sha256) throw new Error('Fcitx5 package differs from approved build')
  mkdirSync(output, { recursive: true })
  const packagePath = join(output, approved.filename)
  const metadataPath = join(output, 'fcitx5-companion.json')
  if (existsSync(packagePath) || existsSync(metadataPath)) throw new Error('Fcitx5 staging destination already exists')
  copyFileSync(source, packagePath)
  const staged = readFileSync(packagePath)
  if (staged.length !== approved.bytes || sha(staged) !== approved.sha256) throw new Error('Fcitx5 package changed during staging')
  writeFileSync(metadataPath, JSON.stringify(approved, null, 2) + '\n')
  const signature = approved.packageSigned ? 'The installer package is signed.' : 'The installer package itself is unsigned.'
  writeFileSync(join(output, 'fcitx5-release-note.md'), `Companion input method for Apple silicon: Fcitx5 for Sumi ${approved.version} (attached as \`${approved.filename}\`). The modified App inside is Developer ID signed and notarized. ${signature}\n`)
  return { packagePath, metadataPath, sha256: approved.sha256 }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2)
    if (args.length !== 2 && args.length !== 4) throw new Error('usage: release-companion.mjs --output-dir <directory> [--package <approved pkg>]')
    if (args[0] !== '--output-dir' || (args.length === 4 && args[2] !== '--package')) throw new Error('invalid companion staging arguments')
    const approved = JSON.parse(readFileSync(approvalPath, 'utf8'))
    const source = args[3] || process.env.FCITX5_PACKAGE_PATH || process.env.FAITC5_PACKAGE_PATH || join(homedir(), 'Downloads', approved.filename)
    console.log(JSON.stringify(stageCompanion({ approved, source: resolve(source), output: resolve(args[1]) })))
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
