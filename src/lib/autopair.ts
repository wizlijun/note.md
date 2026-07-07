/**
 * Auto-close paired markdown markers in a plain-text buffer (source mode).
 *
 * Given the buffer text, a collapsed cursor position, and the character the
 * user just typed, returns how to rewrite the buffer so the closing marker is
 * inserted and the caret ends up between the two markers — or null when no pair
 * should close.
 *
 * Doubled markers ([[  **  __  ^^  ~~  ==) close on the *second* keystroke (the
 * first char is already in the buffer); the single backtick (`) closes on its
 * own. Triples are avoided (typing a third identical char does not re-close).
 */
export interface AutoPairResult {
  /** Text to insert at the cursor: the typed char plus the closing marker. */
  insert: string
  /** Caret offset from the cursor after insertion (between the markers). */
  caret: number
}

/** Opening char → closing marker for doubled pairs. */
const DOUBLED: Record<string, string> = {
  '[': ']]', // [[ ]]
  '*': '**', // ** **
  '_': '__', // __ __
  '^': '^^', // ^^ ^^
  '~': '~~', // ~~ ~~
  '=': '==', // == ==
}

export function autoPairInsert(text: string, cursor: number, typed: string): AutoPairResult | null {
  const before = text[cursor - 1]
  const before2 = text[cursor - 2]

  const close = DOUBLED[typed]
  if (close) {
    // Complete a doubled marker: the previous char matches, but we're not
    // already sitting on a pair (which would make a triple).
    if (before === typed && before2 !== typed) {
      return { insert: typed + close, caret: 1 }
    }
    return null
  }

  // Single backtick — but not when extending an existing run (``` fences).
  if (typed === '`' && before !== '`') {
    return { insert: '``', caret: 1 }
  }

  return null
}
