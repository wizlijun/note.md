// src/lib/outline/note-writeback.ts
// Pure text surgery for "edit the note child in the outline → sync back to
// the main markdown": locate the CriticMarkup annotation and swap its note.

export interface NoteEdit {
  /** 包裹批注的原文；插入点批注传 null（按 oldNote 定位） */
  original: string | null
  oldNote: string
  newNote: string
  /** 1-based 行号提示（annotation 节点的 anchorLine），命中失败回退首个匹配 */
  anchorLine?: number
}

/** 与 moraya-core / note-anno 相同的批注内容清洗规则 */
function sanitizeNote(s: string): string {
  return s.replace(/\r?\n/g, ' ').replace(/<<\}/g, '< <}')
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Replace one annotation's note text in `md`. Returns the new markdown, or
 * null when no matching annotation exists (e.g. the doc changed underneath).
 */
export function replaceNoteInMd(md: string, edit: NoteEdit): string | null {
  const clean = sanitizeNote(edit.newNote)
  const target = edit.original != null
    ? `{==${edit.original}==}{>>${edit.oldNote}<<}`
    : `{>>${edit.oldNote}<<}`
  const replacement = edit.original != null
    ? `{==${edit.original}==}{>>${clean}<<}`
    : `{>>${clean}<<}`

  // 收集所有候选位置；插入点批注排除紧跟 ==} 的（那是包裹批注的一部分）。
  const re = new RegExp(escapeRe(target), 'g')
  const candidates: number[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(md)) !== null) {
    if (edit.original == null && md.slice(Math.max(0, m.index - 3), m.index).endsWith('==}')) continue
    candidates.push(m.index)
  }
  if (candidates.length === 0) return null

  // anchorLine 提示：优先落在该行上的匹配
  let chosen = candidates[0]
  if (edit.anchorLine != null && candidates.length > 1) {
    for (const idx of candidates) {
      const line = md.slice(0, idx).split('\n').length
      if (line === edit.anchorLine) { chosen = idx; break }
    }
  }
  return md.slice(0, chosen) + replacement + md.slice(chosen + target.length)
}
