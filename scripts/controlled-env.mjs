import { readdirSync, realpathSync } from 'node:fs'

// Opt-in only: normal development retains Vite's existing dotenv behavior.
export function controlledEnvDir(value = process.env.NOTEMD_EMPTY_ENV_DIR) {
  if (value === undefined) return undefined
  if (!value) throw new Error('NOTEMD_EMPTY_ENV_DIR must name an empty directory')
  const directory = realpathSync(value)
  if (readdirSync(directory).length) throw new Error('NOTEMD_EMPTY_ENV_DIR must be empty')
  return directory
}
