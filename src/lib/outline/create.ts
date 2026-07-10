// src/lib/outline/create.ts
import { touchFrontmatter } from './frontmatter'
import { pageNameOf } from './backlinks'

/** 新大纲文件的完整文本:front-matter + 单个空节点(空大纲) */
export function newOutlineFileText(title: string, now?: string): string {
  const fm = touchFrontmatter(null, { title, now })
  return `---\n${fm}\n---\n- \n`
}

/** 确保 .note.md 存在(不存在则以空大纲创建),返回 path 供 openFile 使用 */
export async function ensureOutlineFile(path: string): Promise<string> {
  const { exists, writeTextFile } = await import('@tauri-apps/plugin-fs')
  if (!(await exists(path).catch(() => false))) {
    await writeTextFile(path, newOutlineFileText(pageNameOf(path)))
  }
  return path
}
