/**
 * Wrap raw content in a markdown fenced code block.
 * Used for code-kind tabs in rich mode so @moraya/core's code-block-view
 * applies hljs syntax highlighting.
 */
export function buildFencedBlock(content: string, language: string): string {
  return '```' + language + '\n' + content + '\n```'
}

/**
 * Strip the surrounding fence from a markdown string that should consist of
 * exactly one fenced code block.
 *
 * If the input doesn't match the "single fenced block" shape, the input is
 * returned unchanged. This is intentional: the rich editor may produce slightly
 * different markdown after editing (e.g., user added paragraph above the
 * code block); preserving the input avoids data loss, even at the cost of
 * potential language mismatch on the next mount.
 */
export function stripCodeFence(md: string): string {
  const lines = md.split('\n')
  if (
    lines.length >= 3 &&
    lines[0]!.startsWith('```') &&
    lines[lines.length - 1]!.trim() === '```' &&
    !lines.slice(1, -1).some((l) => l.trimStart().startsWith('```'))
  ) {
    return lines.slice(1, -1).join('\n')
  }
  return md
}
