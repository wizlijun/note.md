import { createHash } from 'node:crypto'
import { readFile, writeFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const base = fileURLToPath(new URL('../', import.meta.url))
const sha256 = async relative => createHash('sha256').update(await readFile(path.join(base, relative))).digest('hex')
const sourcePaths = [
  'scripts/task-api.ts', 'scripts/task-cli.ts', 'scripts/cli-manifest.mjs',
  'vite.cli.config.ts', 'package.json',
  ...(await readdir(path.join(base, 'src/lib'))).filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts')).map(name => `src/lib/${name}`),
].sort()
const yaml = JSON.parse(await readFile(path.join(base, 'node_modules/yaml/package.json'), 'utf8'))
await writeFile(path.join(base, 'dist-cli/THIRD-PARTY-LICENSES.txt'), `yaml ${yaml.version} (ISC)\n\n${await readFile(path.join(base, 'node_modules/yaml/LICENSE'), 'utf8')}`)
await writeFile(path.join(base, 'dist-cli/LICENSE'), await readFile(path.join(base, '../../LICENSE')))
const manifest = {
  format: 'next-task-cli-build', version: 1, minimum_node: '20.0.0',
  artifact: { file: 'next-task-cli.mjs', sha256: await sha256('dist-cli/next-task-cli.mjs') },
  dependencies: [{ name: 'yaml', version: yaml.version, license: 'ISC' }],
  source_files: Object.fromEntries(await Promise.all(sourcePaths.map(async name => [name, await sha256(name)]))),
}
await writeFile(path.join(base, 'dist-cli/build-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
