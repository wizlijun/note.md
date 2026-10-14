import { afterEach, expect, it } from 'vitest'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { projectShareBrowserSource } from './project-share-browser.mjs'
const temporary: string[] = []
afterEach(async () => { for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true }) })
it('bundles deterministically and rebuilds the actual shared policy after a watched edit', async () => {
  const root = resolve('.'), plugin = projectShareBrowserSource(), watched: string[] = []
  plugin.configResolved({ root })
  const id = plugin.resolveId('virtual:project-share-browser')!
  const build = () => plugin.load.call({ addWatchFile: (path: string) => watched.push(path) }, id)
  const first = await build()
  expect(await build()).toBe(first)
  expect(watched).toContain(resolve('src/editor-kit-v2/source-projection.ts'))
  expect(watched).toContain(resolve('src/share-editor/owner-policy.ts'))
  expect(watched).toContain(resolve('src/share-editor/media-policy.ts'))
  const scratch = await mkdtemp(join(tmpdir(), 'notemd-inline-reader-')); temporary.push(scratch)
  for (const path of new Set(watched)) { const target = join(scratch, relative(root, path)); await mkdir(dirname(target), { recursive: true }); await cp(path, target) }
  plugin.configResolved({ root: scratch })
  expect(await build()).toBe(first)
  const policy = join(scratch, 'src/share-editor/media-policy.ts')
  await writeFile(policy, (await readFile(policy, 'utf8')).replace('return value && rasterData.test(value) ? value : \'\'', "return 'changed-policy'"))
  const module = {}, invalidated: unknown[] = []
  expect(plugin.handleHotUpdate({ file: policy, modules: [], server: { moduleGraph: { getModuleById: () => module, invalidateModule: (value: unknown) => invalidated.push(value) } } })).toEqual([module])
  expect(invalidated).toEqual([module])
  const changed = await build()
  expect(changed).not.toBe(first); expect(changed).toContain('changed-policy')
})
