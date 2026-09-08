import { describe, expect, it } from 'vitest'
import { canvasRenameTarget } from './naming'

const now = new Date(2026, 8, 8, 9, 7, 5)
const canvas = (...texts: string[]) => JSON.stringify({
  nodes: texts.map((text, index) => ({ id: String(index), type: 'text', text })), edges: [],
})

describe('canvasRenameTarget', () => {
  it('uses the first text card title and the local save date', () => {
    expect(canvasRenameTarget('untitled.canvas', canvas('# 产品 设计\n\n正文', '# 第二张'), now))
      .toBe('2026-09-08-产品-设计.canvas')
    expect(canvasRenameTarget('untitled-2.canvas', canvas('\n## Canvas planning\n正文'), now))
      .toBe('2026-09-08-Canvas-planning.canvas')
  })

  it('skips empty cards and the untouched new-card placeholder', () => {
    expect(canvasRenameTarget('untitled.canvas', canvas('', '# 新卡片\n\n双击开始编辑', '# 实际标题'), now))
      .toBe('2026-09-08-实际标题.canvas')
  })

  it('uses HHmmss when there is no usable title', () => {
    for (const content of [canvas(), canvas(''), canvas('# 新卡片\n\n双击开始编辑'), canvas('# ///')]) {
      expect(canvasRenameTarget('untitled.canvas', content, now)).toBe('2026-09-08-090705.canvas')
    }
  })

  it('does not rename a named document or malformed JSON', () => {
    expect(canvasRenameTarget('2026-09-08-产品.canvas', canvas('# 新标题'), now)).toBeNull()
    expect(canvasRenameTarget('board.canvas', canvas('# 标题'), now)).toBeNull()
    expect(canvasRenameTarget('untitled.canvas', '{', now)).toBeNull()
  })
})
