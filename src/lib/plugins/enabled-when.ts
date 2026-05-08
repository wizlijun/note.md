import type { EnabledWhenContext } from './types'

type PathSegment = { kind: 'literal'; value: string } | { kind: 'computed'; node: Node }

type Node =
  | { kind: 'lit'; value: boolean }
  | { kind: 'str'; value: string }
  | { kind: 'path'; segments: PathSegment[] }
  | { kind: 'not'; inner: Node }
  | { kind: 'and'; left: Node; right: Node }
  | { kind: 'or';  left: Node; right: Node }
  | { kind: 'cmp'; op: '==' | '!='; left: Node; right: Node }

type Token =
  | { kind: 'sym'; value: '(' | ')' | '!' | '&&' | '||' | '.' | '[' | ']' | '==' | '!=' }
  | { kind: 'ident'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'eof' }

function tokenize(src: string): Token[] {
  const out: Token[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) { i++; continue }
    if (c === '(' || c === ')' || c === '.' || c === '[' || c === ']') {
      out.push({ kind: 'sym', value: c }); i++; continue
    }
    if (c === '!' && src[i + 1] === '=') { out.push({ kind: 'sym', value: '!=' }); i += 2; continue }
    if (c === '!') { out.push({ kind: 'sym', value: '!' }); i++; continue }
    if (c === '=' && src[i + 1] === '=') { out.push({ kind: 'sym', value: '==' }); i += 2; continue }
    if (c === '&' && src[i + 1] === '&') { out.push({ kind: 'sym', value: '&&' }); i += 2; continue }
    if (c === '|' && src[i + 1] === '|') { out.push({ kind: 'sym', value: '||' }); i += 2; continue }
    if (c === '"' || c === "'") {
      const quote = c
      let j = i + 1
      while (j < src.length && src[j] !== quote) j++
      if (j >= src.length) throw new Error(`unterminated string`)
      out.push({ kind: 'string', value: src.slice(i + 1, j) })
      i = j + 1; continue
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++
      out.push({ kind: 'ident', value: src.slice(i, j) })
      i = j; continue
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} at ${i}`)
  }
  out.push({ kind: 'eof' })
  return out
}

class Parser {
  private pos = 0
  constructor(private toks: Token[]) {}

  parseExpr(): Node {
    return this.parseOr()
  }

  private parseOr(): Node {
    let left = this.parseAnd()
    while (this.peekSym('||')) {
      this.consume()
      const right = this.parseAnd()
      left = { kind: 'or', left, right }
    }
    return left
  }

  private parseAnd(): Node {
    let left = this.parseCompare()
    while (this.peekSym('&&')) {
      this.consume()
      const right = this.parseCompare()
      left = { kind: 'and', left, right }
    }
    return left
  }

  private parseCompare(): Node {
    const left = this.parseUnary()
    if (this.peekSym('==') || this.peekSym('!=')) {
      const tok = this.consume() as Extract<Token, { kind: 'sym' }>
      const op = tok.value as '==' | '!='
      const right = this.parseUnary()
      return { kind: 'cmp', op, left, right }
    }
    return left
  }

  private parseUnary(): Node {
    if (this.peekSym('!')) {
      this.consume()
      return { kind: 'not', inner: this.parseAtom() }
    }
    return this.parseAtom()
  }

  private parseAtom(): Node {
    const t = this.peek()
    if (t.kind === 'sym' && t.value === '(') {
      this.consume()
      const inner = this.parseExpr()
      this.expectSym(')')
      return inner
    }
    if (t.kind === 'ident' && (t.value === 'true' || t.value === 'false')) {
      this.consume()
      return { kind: 'lit', value: t.value === 'true' }
    }
    if (t.kind === 'string') {
      this.consume()
      return { kind: 'str', value: t.value }
    }
    if (t.kind === 'ident') {
      return this.parsePath()
    }
    throw new Error(`unexpected token ${JSON.stringify(t)}`)
  }

  private parsePath(): Node {
    const segments: PathSegment[] = []
    const head = this.consume()
    if (head.kind !== 'ident') throw new Error('path must start with identifier')
    segments.push({ kind: 'literal', value: head.value })
    while (true) {
      if (this.peekSym('.')) {
        this.consume()
        const t = this.consume()
        if (t.kind !== 'ident') throw new Error('expected identifier after `.`')
        segments.push({ kind: 'literal', value: t.value })
        continue
      }
      if (this.peekSym('[')) {
        this.consume()
        const next = this.peek()
        if (next.kind === 'string') {
          this.consume()
          segments.push({ kind: 'literal', value: next.value })
        } else if (next.kind === 'ident') {
          // Multi-segment computed index — recursively parse a full path,
          // then evaluate it at lookup time and use the result as the key.
          const sub = this.parsePath()
          segments.push({ kind: 'computed', node: sub })
        } else {
          throw new Error('expected string or identifier inside `[ ]`')
        }
        this.expectSym(']')
        continue
      }
      break
    }
    return { kind: 'path', segments }
  }

  private peek(): Token { return this.toks[this.pos] }
  private consume(): Token { return this.toks[this.pos++] }
  private peekSym(v: string): boolean {
    const t = this.peek()
    return t.kind === 'sym' && t.value === v
  }
  private expectSym(v: string): void {
    if (!this.peekSym(v)) throw new Error(`expected '${v}'`)
    this.consume()
  }

  expectEof(): void {
    if (this.peek().kind !== 'eof')
      throw new Error(`unexpected trailing token ${JSON.stringify(this.peek())}`)
  }
}

export function parseEnabledWhen(src: string): Node {
  const toks = tokenize(src)
  const p = new Parser(toks)
  const node = p.parseExpr()
  p.expectEof()
  return node
}

function lookup(ctx: EnabledWhenContext, segments: PathSegment[]): unknown {
  let cur: unknown = ctx as unknown
  for (const seg of segments) {
    if (cur == null || typeof cur !== 'object') return undefined
    let key: string
    if (seg.kind === 'literal') {
      key = seg.value
    } else {
      const v = evalRaw(seg.node, ctx)
      if (v == null) return undefined
      key = String(v)
    }
    cur = (cur as Record<string, unknown>)[key]
  }
  return cur
}

/** Returns the raw (non-boolean-coerced) value for a node — used for computed index resolution and == / != comparisons. */
function evalRaw(node: Node, ctx: EnabledWhenContext): unknown {
  if (node.kind === 'path') return lookup(ctx, node.segments)
  if (node.kind === 'str')  return node.value
  if (node.kind === 'lit')  return node.value
  // For non-path nodes (logical ops), fall back to boolean result.
  return evalNode(node, ctx)
}

function truthy(v: unknown): boolean {
  if (v == null) return false
  if (typeof v === 'string') return v.length > 0
  if (typeof v === 'number') return v !== 0
  if (typeof v === 'boolean') return v
  if (Array.isArray(v)) return v.length > 0
  if (typeof v === 'object') return Object.keys(v).length > 0
  return Boolean(v)
}

function evalNode(node: Node, ctx: EnabledWhenContext): boolean {
  switch (node.kind) {
    case 'lit': return node.value
    case 'str': return node.value.length > 0
    case 'path': return truthy(lookup(ctx, node.segments))
    case 'not': return !evalNode(node.inner, ctx)
    case 'and': return evalNode(node.left, ctx) && evalNode(node.right, ctx)
    case 'or':  return evalNode(node.left, ctx) || evalNode(node.right, ctx)
    case 'cmp': {
      const l = evalRaw(node.left, ctx)
      const r = evalRaw(node.right, ctx)
      const eq = l === r || (l == null && r == null)
      return node.op === '==' ? eq : !eq
    }
  }
}

export function evaluateEnabledWhen(src: string, ctx: EnabledWhenContext): boolean {
  return evalNode(parseEnabledWhen(src), ctx)
}
