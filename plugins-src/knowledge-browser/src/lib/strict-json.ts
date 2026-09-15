import type { Diagnostic } from './types'

export interface StrictJsonOptions { maxBytes?: number; maxDepth?: number }
export interface StrictJsonResult { value?: unknown; diagnostics: Diagnostic[]; byteLength: number }

const syntaxDiagnostic = (message: string): Diagnostic => ({
  code: 'json.syntax', severity: 'error', pointer: '', message, suggestion: '查看源码并修正 JSON 语法后重试。',
})

/** JSON.parse does not report duplicate members. This scanner validates nesting and records them before parsing. */
class DuplicateScanner {
  private index = 0
  readonly diagnostics: Diagnostic[] = []
  constructor(private readonly source: string, private readonly maxDepth: number) {}

  scan(): void { this.ws(); this.value('', 0); this.ws(); if (this.index !== this.source.length) throw new Error(`位置 ${this.index} 后存在多余内容`) }
  private ws(): void { while (/\s/.test(this.source[this.index] ?? '')) this.index++ }
  private value(pointer: string, depth: number): void {
    if (depth > this.maxDepth) throw new Error(`JSON 嵌套深度超过 ${this.maxDepth}`)
    this.ws(); const char = this.source[this.index]
    if (char === '{') return this.object(pointer, depth + 1)
    if (char === '[') return this.array(pointer, depth + 1)
    if (char === '"') { this.string(); return }
    const start = this.index
    while (this.index < this.source.length && !/[\s,\]}]/.test(this.source[this.index])) this.index++
    if (start === this.index) throw new Error(`位置 ${this.index} 缺少 JSON 值`)
    JSON.parse(this.source.slice(start, this.index))
  }
  private string(): string {
    const start = this.index++
    while (this.index < this.source.length) {
      const char = this.source[this.index++]
      if (char === '"') return JSON.parse(this.source.slice(start, this.index)) as string
      if (char === '\\') this.index++
      else if (char < ' ') throw new Error(`位置 ${this.index - 1} 的字符串含控制字符`)
    }
    throw new Error('字符串未闭合')
  }
  private object(pointer: string, depth: number): void {
    this.index++; this.ws(); const keys = new Set<string>()
    if (this.source[this.index] === '}') { this.index++; return }
    for (;;) {
      if (this.source[this.index] !== '"') throw new Error(`位置 ${this.index} 的对象键不是字符串`)
      const key = this.string(); const child = `${pointer}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`
      if (keys.has(key)) this.diagnostics.push({ code: 'json.duplicate-key', severity: 'error', pointer: child, message: `重复 JSON 属性键：${key}`, suggestion: '删除重复属性；不能依赖后一个值覆盖前一个值。' })
      keys.add(key); this.ws(); if (this.source[this.index++] !== ':') throw new Error(`属性 ${key} 后缺少冒号`)
      this.value(child, depth); this.ws(); const next = this.source[this.index++]
      if (next === '}') return
      if (next !== ',') throw new Error(`位置 ${this.index - 1} 应为逗号或右花括号`)
      this.ws()
    }
  }
  private array(pointer: string, depth: number): void {
    this.index++; this.ws(); if (this.source[this.index] === ']') { this.index++; return }
    let item = 0
    for (;;) {
      this.value(`${pointer}/${item++}`, depth); this.ws(); const next = this.source[this.index++]
      if (next === ']') return
      if (next !== ',') throw new Error(`位置 ${this.index - 1} 应为逗号或右方括号`)
      this.ws()
    }
  }
}

export function parseStrictJson(source: string, options: StrictJsonOptions = {}): StrictJsonResult {
  const maxBytes = options.maxBytes ?? 30 * 1024 * 1024
  const maxDepth = options.maxDepth ?? 64
  const byteLength = new TextEncoder().encode(source).byteLength
  if (byteLength > maxBytes) return { byteLength, diagnostics: [{ code: 'json.too-large', severity: 'error', pointer: '', message: `JSON 为 ${byteLength} bytes，超过 ${maxBytes} bytes 上限。`, suggestion: '查看源码或选择较小的数据集。' }] }
  const scanner = new DuplicateScanner(source, maxDepth)
  try {
    scanner.scan()
    const value = JSON.parse(source) as unknown
    return { value, diagnostics: scanner.diagnostics, byteLength }
  } catch (error) {
    return { byteLength, diagnostics: [...scanner.diagnostics, syntaxDiagnostic(error instanceof Error ? error.message : 'JSON 无法解析')] }
  }
}
