// Read-only evidence probe; does not execute the app or prove runtime PHF lookup.
import { readFileSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { brotliDecompressSync } from 'node:zlib'

const host = process.cwd()
const target = host + '/src-tauri/target/'
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const sri = bytes => 'sha384-' + createHash('sha384').update(bytes).digest('base64')
try {
  if (process.argv.length !== 5) throw Error('Expected frozen-manifest app-MachO rust-depfile')
  const [manifestPath, binaryPath, depfilePath] = process.argv.slice(2).map(path => realpathSync(resolve(path)))
  if (!binaryPath.startsWith(target) || !depfilePath.startsWith(target)) throw Error('Binary/depfile outside build target')
  if (!binaryPath.includes('/bundle/macos/') || !binaryPath.endsWith('/Contents/MacOS/notemd')) throw Error('Expected existing release app Mach-O')
  const manifestBytes = readFileSync(manifestPath)
  const manifest = JSON.parse(manifestBytes)
  if (manifest.apiVersion !== 1 || !manifest.js || !manifest.css || !manifest.mermaid) throw Error('Expected frozen manifest with JS/CSS/Mermaid')
  const binary = readFileSync(binaryPath), depfile = readFileSync(depfilePath)
  if (binary.subarray(0, 4).toString('hex') !== 'cffaedfe') throw Error('Expected thin little-endian 64-bit Mach-O')
  const architecture = ({ 16777228: 'arm64', 16777223: 'x86_64' })[binary.readUInt32LE(4)]
  if (!architecture) throw Error('Unexpected Mach-O CPU type')
  // rustc depfiles list the include_bytes! dependencies, not the PHF key binding.
  const paths = [...new Set(depfile.toString().match(/\/[^\s:]*\/tauri-codegen-assets\/[a-f0-9]{64}\.(?:json|js|css)(?=[\s:]|$)/g) ?? [])]
  if (!paths.length) throw Error('No codegen JSON/JS/CSS dependencies in depfile')
  const wanted = [{ kind: 'manifest', key: '/share-editor-manifest.json', expectedSha256: sha(manifestBytes) }]
  for (const kind of ['js', 'css', 'mermaid']) {
    const asset = manifest[kind]
    const ext = kind === 'css' ? 'css' : 'js'
    if (!new RegExp(`^share-editor${kind === 'mermaid' ? '-mermaid' : ''}\\.[a-f0-9]{64}\\.${ext}$`).test(asset.name) || !asset.name.includes('.' + asset.sha256 + '.')) throw Error('Invalid frozen asset identity')
    wanted.push({ kind, key: '/assets/' + asset.name, expectedSha256: asset.sha256, expectedSri: asset.sri })
  }
  const matches = [], controlCandidates = []
  for (const path of paths) {
    if (!realpathSync(path).startsWith(target)) throw Error('Cache symlink outside target')
    const compressed = readFileSync(path)
    const raw = brotliDecompressSync(compressed)
    const rawSha256 = sha(raw)
    const expected = wanted.find(item => item.expectedSha256 === rawSha256)
    if (expected || controlCandidates.length < 3) {
      const offset = binary.indexOf(compressed)
      const secondOffset = offset < 0 ? -1 : binary.indexOf(compressed, offset + 1)
      const unique = offset >= 0 && secondOffset === -1
      const recovered = unique ? brotliDecompressSync(binary.subarray(offset, offset + compressed.length)) : undefined
      const result = {
        kind: expected?.kind ?? 'existing-cache-operation-control', cachePath: path,
        compressedBytes: compressed.length, compressedSha256: sha(compressed),
        rawBytes: raw.length, rawSha256, offset, secondOffset, unique,
        recoveredSha256: recovered ? sha(recovered) : null,
        recoveredMatchesCache: recovered ? recovered.equals(raw) : false,
        matchesFrozen: expected ? Boolean(recovered && sha(recovered) === expected.expectedSha256
          && (!expected.expectedSri || sri(recovered) === expected.expectedSri)
          && (expected.kind !== 'manifest' || recovered.equals(manifestBytes))) : null,
      }
      if (expected) matches.push(result)
      else controlCandidates.push(result)
    }
  }
  const control = controlCandidates.find(item => item.unique && item.recoveredMatchesCache)
  const resources = wanted.map(item => ({ ...item, matches: matches.filter(match => match.kind === item.kind) }))
  const contained = resources.every(item => item.matches.length === 1 && item.matches[0].matchesFrozen)
  console.log(JSON.stringify({
    proofScope: 'complete_compressed_byte_sequences_present_in_actual_MachO',
    runtimeResolverVerified: false, generatedPhfBindingVerified: false, sameBuildLifecycleVerified: false,
    candidateBytesContained: contained,
    status: contained ? 'contained-bytes-only' : 'existing-artifact-candidate-mismatch',
    manifestPath, manifestSha256: sha(manifestBytes), binaryPath, binarySha256: sha(binary), architecture,
    depfilePath, depfileSha256: sha(depfile), cacheDependencies: paths.length,
    codegenJsonDependencies: paths.filter(path => path.endsWith('.json')).length,
    originalManifestDependencyPresent: depfile.includes('/dist/share-editor-manifest.json'),
    operationControl: control, resources,
  }, null, 2))
  process.exitCode = contained ? 0 : 1
} catch (error) {
  console.error(JSON.stringify({ failureKind: 'probe-input-or-operation-error', error: error.message }))
  process.exitCode = 2
}
