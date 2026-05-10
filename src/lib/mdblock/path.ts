/**
 * Path resolution for the mdblock yaml cache.
 *
 * The yaml is keyed by the SHA-256 hash of the source file's absolute path
 * (truncated to 16 hex chars) and stored under
 *   <appLocalDataDir>/blocks/<hash>.yaml
 *
 * This keeps the user's content directories clean (no .block.yaml siblings
 * to .gitignore) at the cost of: (a) the yaml is local to one machine;
 * (b) renaming/moving the source file orphans its yaml — the user can
 * re-run Compute Blocks to rebuild.
 *
 * The .block.md (AI-facing artifact) still lives next to the source so it
 * can be passed to LLMs by path. Only the yaml moves to cache.
 */

let cachedDir: string | null = null
let cacheDirPromise: Promise<string> | null = null

async function getCacheDir(): Promise<string> {
  if (cachedDir) return cachedDir
  if (!cacheDirPromise) {
    cacheDirPromise = (async () => {
      const { appLocalDataDir } = await import('@tauri-apps/api/path')
      const { mkdir, exists } = await import('@tauri-apps/plugin-fs')
      const root = await appLocalDataDir()
      const dir = root.endsWith('/') ? `${root}blocks` : `${root}/blocks`
      if (!(await exists(dir))) await mkdir(dir, { recursive: true })
      cachedDir = dir
      return dir
    })()
  }
  return cacheDirPromise
}

async function pathHash(p: string): Promise<string> {
  const data = new TextEncoder().encode(p)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16)
}

/**
 * Cache path for the yaml of `absoluteSrcPath`. Always async because the
 * cache dir resolution + ensure-exists requires Tauri fs.
 */
export async function cachedYamlPath(absoluteSrcPath: string): Promise<string> {
  const dir = await getCacheDir()
  const hash = await pathHash(absoluteSrcPath)
  return `${dir}/${hash}.yaml`
}

/** Sibling-of-source path for the generated `.block.md` artifact. */
export function blockMdPathFor(mdPath: string): string {
  return mdPath.endsWith('.md')
    ? mdPath.slice(0, -3) + '.block.md'
    : `${mdPath}.block.md`
}
