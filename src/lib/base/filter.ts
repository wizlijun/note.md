import type { BaseFilter, FileRecord } from './model'

/** Resolve a property path against a record. `file.*` → file props;
 *  `note.x` / bare `x` → frontmatter; `formula.*` → undefined (v1). */
export function resolveProp(path: string, rec: FileRecord): unknown {
  if (path.startsWith('file.')) {
    const k = path.slice(5)
    switch (k) {
      case 'name': return rec.name
      case 'path': return rec.path
      case 'folder': return rec.folder
      case 'ext': return rec.ext
      case 'mtime': return rec.mtime
      case 'ctime': return rec.ctime
      case 'size': return rec.size
      case 'tags': return rec.tags
      default: return undefined
    }
  }
  if (path.startsWith('formula.')) return undefined
  const key = path.startsWith('note.') ? path.slice(5) : path
  return rec.frontmatter[key]
}

function parseLiteral(s: string): unknown {
  const t = s.trim()
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1)
  }
  if (t === 'true') return true
  if (t === 'false') return false
  if (t !== '' && !Number.isNaN(Number(t))) return Number(t)
  return t
}

function compare(a: unknown, op: string, b: unknown): boolean {
  if (op === '==') return String(a) === String(b) || a === b
  if (op === '!=') return !(String(a) === String(b) || a === b)
  // Relational ops need real numbers on both sides; null/undefined (missing or
  // explicit YAML null) must NOT coerce to 0, else `rating < 5` matches `rating: null`.
  if (a == null || b == null) return false
  const na = typeof a === 'number' ? a : Number(a)
  const nb = typeof b === 'number' ? b : Number(b)
  if (Number.isNaN(na) || Number.isNaN(nb)) return false
  if (op === '>') return na > nb
  if (op === '<') return na < nb
  if (op === '>=') return na >= nb
  if (op === '<=') return na <= nb
  return false
}

const FN_RE = /^([\w.]+)\s*\((.*)\)$/
const CMP_RE = /^(.+?)\s*(==|!=|>=|<=|>|<)\s*(.+)$/

/** Evaluate a leaf statement. Unknown/unsupported → true (fail-open). */
function evalLeaf(stmt: string, rec: FileRecord): boolean {
  const fn = FN_RE.exec(stmt.trim())
  if (fn) {
    const name = fn[1]
    const arg = parseLiteral(fn[2])
    const argS = String(arg).replace(/^#/, '')
    switch (name) {
      case 'file.hasTag':
        return rec.tags.map((x) => x.replace(/^#/, '')).includes(argS)
      case 'file.inFolder':
        return rec.folder === argS || rec.folder.endsWith('/' + argS) || rec.folder.includes('/' + argS + '/')
      default:
        return true // 未支持函数(含 file.hasLink):fail-open
    }
  }
  const cmp = CMP_RE.exec(stmt.trim())
  if (cmp) {
    const left = resolveProp(cmp[1].trim(), rec)
    const right = parseLiteral(cmp[3])
    return compare(left, cmp[2], right)
  }
  return true // 无法解析:fail-open
}

/** Evaluate a filter tree against a record. */
export function evalFilter(filter: BaseFilter | undefined, rec: FileRecord): boolean {
  if (filter == null) return true
  if (typeof filter === 'string') return evalLeaf(filter, rec)
  if ('and' in filter) return filter.and.every((f) => evalFilter(f, rec))
  if ('or' in filter) return filter.or.some((f) => evalFilter(f, rec))
  if ('not' in filter) return !filter.not.some((f) => evalFilter(f, rec)) // NOT(OR): keep row when none match
  return true
}
