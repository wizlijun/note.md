// Reuse the repository's installed Worker toolchain; never install a second Wrangler.
import { mkdirSync, existsSync, realpathSync, symlinkSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
const root = resolve(import.meta.dirname, '..')
for (const name of [
  'vitest',
  '@cloudflare/vitest-pool-workers',
  '@cloudflare/workers-types',
  'typescript',
  'wrangler',
]) {
  const source = resolve(root, '../worker/node_modules', name)
  if (!existsSync(source)) throw new Error(`Install the existing worker toolchain first: ${name}`)
  if (
    name === 'wrangler' &&
    !JSON.parse(readFileSync(resolve(source, 'package.json'), 'utf8')).version.startsWith('3.')
  )
    throw new Error('Sumi requires the repository Wrangler 3')
  const target = resolve(root, 'node_modules', name)
  if (!existsSync(target)) {
    mkdirSync(dirname(target), { recursive: true })
    symlinkSync(realpathSync(source), target, 'dir')
  }
}
