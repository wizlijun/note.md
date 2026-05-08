/** Convert a UTF-16 character offset into 0-indexed (line, col). */
export function offsetToLineCol(text: string, offset: number): { line: number; col: number } {
  const o = Math.min(Math.max(offset, 0), text.length)
  let line = 0
  let lineStart = 0
  for (let i = 0; i < o; i++) {
    if (text.charCodeAt(i) === 0x0a /* \n */) {
      line++
      lineStart = i + 1
    }
  }
  return { line, col: o - lineStart }
}

/**
 * Convert (line, col) back to a UTF-16 offset, clamping if `line` exceeds the
 * total line count or `col` exceeds the matching line's length.
 */
export function lineColToOffset(text: string, line: number, col: number): number {
  const lines = text.split('\n')
  const targetLine = Math.min(Math.max(line, 0), lines.length - 1)
  let offset = 0
  for (let i = 0; i < targetLine; i++) offset += lines[i].length + 1 // +1 for \n
  const colMax = lines[targetLine].length
  return offset + Math.min(Math.max(col, 0), colMax)
}
