/**
 * Split raw YAML frontmatter into contiguous `key: value` regions ("kv") and
 * everything else ("md"). Frontmatter is not required to be a single YAML
 * mapping — prose, quotes and stray lines between metadata all render on their
 * own. Segments partition the input contiguously, so concatenating every
 * `text` reproduces `raw` exactly (needed for surgical edit write-back).
 */
export interface FmSegment {
  kind: 'kv' | 'md'
  text: string
  start: number
  end: number
}

interface Line {
  start: number
  end: number
  text: string      // includes trailing newline (except possibly the last line)
  content: string   // without trailing newline
}

// A top-level mapping key line: starts at column 0, has a `key:` (followed by a
// space or end-of-line), is not a list item and not a fence.
const KEY_LINE = /^[^\s#][^:]*:(\s|$)/

function splitLines(raw: string): Line[] {
  const lines: Line[] = []
  let pos = 0
  while (pos < raw.length) {
    const nl = raw.indexOf('\n', pos)
    const end = nl === -1 ? raw.length : nl + 1
    const text = raw.slice(pos, end)
    lines.push({ start: pos, end, text, content: text.replace(/\n$/, '') })
    pos = end
  }
  return lines
}

type LineClass = 'key' | 'cont' | 'blank' | 'other'

function classify(line: Line): LineClass {
  if (line.content.trim() === '') return 'blank'
  if (/^\s/.test(line.text)) return 'cont'          // indented → continuation
  if (line.content.startsWith('-')) return 'other'  // top-level list item
  if (line.content.trim() === '---') return 'other'
  if (KEY_LINE.test(line.content)) return 'key'
  return 'other'
}

export function segmentFrontmatter(raw: string): FmSegment[] {
  const lines = splitLines(raw)
  const segments: FmSegment[] = []
  let curKind: 'kv' | 'md' | null = null
  let curStartLine = 0

  const flush = (endLineIdx: number) => {
    if (curKind == null) return
    const start = lines[curStartLine].start
    const end = lines[endLineIdx].end
    segments.push({ kind: curKind, text: raw.slice(start, end), start, end })
  }

  const nextNonBlank = (from: number): number => {
    for (let j = from; j < lines.length; j++) {
      if (classify(lines[j]) !== 'blank') return j
    }
    return -1
  }

  for (let i = 0; i < lines.length; i++) {
    const c = classify(lines[i])
    let target: 'kv' | 'md'
    if (c === 'key') {
      target = 'kv'
    } else if (c === 'cont') {
      // Indented lines continue a kv block; outside one they are just md text.
      target = curKind === 'kv' ? 'kv' : 'md'
    } else if (c === 'blank') {
      // A blank only stays inside a kv block when it sits within an indented
      // value (e.g. a block scalar with internal blanks). Otherwise it breaks
      // the contiguous key run.
      if (curKind === 'kv') {
        const j = nextNonBlank(i + 1)
        target = j !== -1 && classify(lines[j]) === 'cont' ? 'kv' : 'md'
      } else {
        target = 'md'
      }
    } else {
      target = 'md'
    }

    if (curKind !== target) {
      if (curKind != null) flush(i - 1)
      curKind = target
      curStartLine = i
    }
  }
  if (curKind != null) flush(lines.length - 1)

  return segments
}
