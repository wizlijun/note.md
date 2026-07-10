// src/lib/outline/create.ts
import { touchFrontmatter } from './frontmatter'
import { pageNameOf } from './backlinks'

/** 新大纲文件的完整文本:front-matter + 单个空节点(空大纲) */
export function newOutlineFileText(title: string, now?: string): string {
  const fm = touchFrontmatter(null, { title, now })
  return `---\n${fm}\n---\n- \n`
}

/** 确保 .note.md 存在(不存在则以空大纲创建)。title 缺省取文件名;
 *  wikipage 建页传原始标题(spec §5:文件名 slug 化、fm title 存原文)。 */
export async function ensureOutlineFile(path: string, title?: string): Promise<string> {
  const { exists, writeTextFile } = await import('@tauri-apps/plugin-fs')
  if (!(await exists(path).catch(() => false))) {
    await writeTextFile(path, newOutlineFileText(title ?? pageNameOf(path)))
  }
  return path
}
