export interface RevealRequest {
  seq: number
  /** 主文档 1-based 行号 */
  line: number
  /** 该行的锚文本（标题文本/高亮文本），rich 模式与 debounce 窗口兜底搜索用 */
  text: string
}

export const reveal = $state<{ req: RevealRequest | null }>({ req: null })

let seq = 0
export function requestReveal(line: number, text: string): void {
  reveal.req = { seq: ++seq, line, text }
}
