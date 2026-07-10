// src/lib/outline/migrate.ts
import { companionPathFor } from './store.svelte'

/** xxx.md 的旧后缀伴生路径(仅迁移期使用) */
export function legacyCompanionPathFor(mainPath: string): string | null {
  const target = companionPathFor(mainPath)
  return target ? target.replace(/\.note\.md$/, '.notes.md') : null
}

/** 任意 *.notes.md 路径的新后缀目标;非旧后缀返回 null */
export function migratedPathFor(legacyPath: string): string | null {
  return /\.notes\.md$/i.test(legacyPath)
    ? legacyPath.replace(/\.notes\.md$/i, '.note.md')
    : null
}

/** 就地重命名单个旧后缀文件(git 可追溯,无备份副本)。 */
export async function migrateLegacyFile(
  legacyPath: string,
): Promise<'renamed' | 'conflict' | 'none'> {
  const target = migratedPathFor(legacyPath)
  if (!target) return 'none'
  const { exists, rename } = await import('@tauri-apps/plugin-fs')
  if (!(await exists(legacyPath).catch(() => false))) return 'none'
  if (await exists(target).catch(() => false)) return 'conflict'
  try {
    await rename(legacyPath, target)
    return 'renamed'
  } catch (e) {
    console.warn('[outline] migrate failed:', legacyPath, e)
    return 'none'
  }
}

/** 打开 xxx.md 时:若存在旧后缀伴生文件则先迁移(目标已存在则保留双份,索引期报告) */
export async function migrateLegacyCompanion(mainPath: string): Promise<void> {
  const legacy = legacyCompanionPathFor(mainPath)
  if (legacy) await migrateLegacyFile(legacy)
}
