/** Parsed representation of one line of a unified diff (as produced by
 *  `git show <rev> -- <file>`), for rendering a colored, git-tool-like view. */
export type DiffRowType = 'meta' | 'hunk' | 'add' | 'del' | 'context'

export interface DiffRow {
  type: DiffRowType
  /** Old-file (pre-image) line number, or null (add / meta / hunk rows). */
  oldLn: number | null
  /** New-file (post-image) line number, or null (del / meta / hunk rows). */
  newLn: number | null
  /** Display text: for add/del/context the leading +/-/space marker is
   *  stripped (the row type conveys it); meta/hunk keep the raw line. */
  text: string
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

/**
 * Parse `git show`/`git diff` unified-diff output into rows carrying old/new
 * line numbers and a semantic type. Pure and synchronous so it's unit-testable.
 *
 * State machine: everything is `meta` until a hunk header (`@@ … @@`) flips us
 * into hunk-body mode, where a line's first char decides add/del/context. A new
 * `diff --git` resets to meta mode (multi-file diffs). Because the `---`/`+++`
 * file headers only ever appear in meta mode, a deletion line whose content
 * itself begins with `-` (e.g. removing a `- list item`) is never mistaken for
 * a header.
 */
export function parseUnifiedDiff(text: string): DiffRow[] {
  const lines = text.split('\n')
  // Drop the single trailing '' produced by a final newline (real trailing
  // blank lines inside a hunk are space-prefixed context, not '').
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

  const rows: DiffRow[] = []
  let oldLn = 0
  let newLn = 0
  let inHunk = false

  for (const line of lines) {
    const h = line.match(HUNK_RE)
    if (h) {
      oldLn = parseInt(h[1], 10)
      newLn = parseInt(h[2], 10)
      inHunk = true
      rows.push({ type: 'hunk', oldLn: null, newLn: null, text: line })
      continue
    }
    if (line.startsWith('diff --git')) {
      inHunk = false
      rows.push({ type: 'meta', oldLn: null, newLn: null, text: line })
      continue
    }
    if (!inHunk) {
      rows.push({ type: 'meta', oldLn: null, newLn: null, text: line })
      continue
    }
    // Inside a hunk body: the first char is the change marker.
    const marker = line[0]
    if (marker === '+') {
      rows.push({ type: 'add', oldLn: null, newLn: newLn++, text: line.slice(1) })
    } else if (marker === '-') {
      rows.push({ type: 'del', oldLn: oldLn++, newLn: null, text: line.slice(1) })
    } else if (marker === '\\') {
      // "\ No newline at end of file" — a note, not content.
      rows.push({ type: 'meta', oldLn: null, newLn: null, text: line })
    } else {
      // Context line: space-prefixed (or empty within some tools).
      const t = marker === ' ' ? line.slice(1) : line
      rows.push({ type: 'context', oldLn: oldLn++, newLn: newLn++, text: t })
    }
  }
  return rows
}
