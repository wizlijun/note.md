import { fileNameTimestamp, titleSlug } from '../quick-note-name'

/** Give an untitled Canvas its permanent name on explicit save. */
export function canvasRenameTarget(name: string, content: string, now = new Date()): string | null {
  if (!/^untitled(?:-(?:[2-9]|[1-9]\d+))?\.canvas$/i.test(name)) return null
  let document: { nodes?: unknown[] }
  try { document = JSON.parse(content) }
  catch { return null }
  if (!document || !Array.isArray(document.nodes)) return null
  let title = ''
  for (const entry of document.nodes) {
    if (!entry || typeof entry !== 'object') continue
    const node = entry as { type?: string; text?: string }
    if (node.type !== 'text' || typeof node.text !== 'string') continue
    const text = node.text.trim()
    if (!text || text === '# 新卡片\n\n双击开始编辑') continue
    title = text.split(/\r?\n/)[0].replace(/^#{1,6}[ \t]+/, '').replace(/[ \t]+#+$/, '').trim()
    break
  }
  const timestamp = fileNameTimestamp(now)
  return `${timestamp.slice(0, 10)}-${titleSlug(title) ?? timestamp.slice(11)}.canvas`
}
