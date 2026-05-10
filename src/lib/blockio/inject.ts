import type { ActiveBlock } from './yaml-schema'

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/

export interface FrontmatterSplit {
  fm: string         // including the trailing closing-fence newline; '' if none
  body: string       // remainder
  fmLines: number    // line count of fm (including trailing newline)
}

export function splitFrontmatter(source: string): FrontmatterSplit {
  const m = FRONTMATTER_RE.exec(source)
  if (!m) return { fm: '', body: source, fmLines: 0 }
  const fm = m[0]
  const body = source.slice(fm.length)
  const fmLines = fm.split('\n').length - 1 // trailing newline boundary contributes 1
  return { fm, body, fmLines }
}

function aiHintBlock(sourceBasename: string): string {
  return [
    '<!--',
    '  Each block in this document is preceded by an HTML anchor like:',
    '    <a id="b-xxxxxx"></a>',
    '  When citing a block from this document, use:',
    `    ((${sourceBasename}#b-xxxxxx))`,
    '-->',
    '',
  ].join('\n')
}

export interface GenerateBlockMdResult {
  output: string
  outLines: Map<string, number>
}

/**
 * Splice anchor + blank lines into source at each block's position,
 * preserving frontmatter at the top untouched. Optionally injects the
 * AI usage hint between frontmatter and the first block.
 */
export function generateBlockMd(
  source: string,
  activeBlocks: ActiveBlock[],
  injectAiHint: boolean,
  sourceBasename: string,
): GenerateBlockMdResult {
  const { fm, body } = splitFrontmatter(source)

  // Block positions are in the FULL source — adjust to body coordinates.
  const blocks = activeBlocks
    .map((b) => ({ ...b, body_pos: b.src_pos - fm.length }))
    .filter((b) => b.body_pos >= 0)
    .sort((a, b) => a.body_pos - b.body_pos)

  // Snap each block's body_pos to the previous newline (line start).
  for (const b of blocks) {
    if (b.body_pos === 0) continue
    if (body.charCodeAt(b.body_pos - 1) === 10) continue // already at line start
    let p = b.body_pos
    while (p > 0 && body.charCodeAt(p - 1) !== 10) p--
    b.body_pos = p
  }

  const pieces: string[] = []
  if (fm) pieces.push(fm)
  if (injectAiHint) pieces.push(aiHintBlock(sourceBasename))

  let prev = 0
  const anchorOffsets: { id: string; offset: number }[] = []
  for (const b of blocks) {
    pieces.push(body.slice(prev, b.body_pos))
    const offsetInOutput = pieces.reduce((n, s) => n + s.length, 0)
    pieces.push(`<a id="${b.id}"></a>\n\n`)
    anchorOffsets.push({ id: b.id, offset: offsetInOutput })
    prev = b.body_pos
  }
  pieces.push(body.slice(prev))

  const output = pieces.join('')

  // out_line: 1-based; anchor offset → number of \n in output[0..offset] + 1
  const outLines = new Map<string, number>()
  for (const a of anchorOffsets) {
    let line = 1
    for (let i = 0; i < a.offset; i++) {
      if (output.charCodeAt(i) === 10) line++
    }
    outLines.set(a.id, line)
  }

  return { output, outLines }
}
