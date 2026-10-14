import { diff } from '../lib/share-merge/diff'

/** The browser textarea's LF projection is display-only, never raw authority. */
export function displaySource(raw: string): string { return raw.replace(/\r\n?/g, '\n') }
export function sourceFromDisplay(raw: string, next: string): string {
  const before = displaySource(raw)
  if (before === next) return raw
  const offsets = [0]
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '\r' && raw[i + 1] === '\n') i++
    offsets.push(i + 1)
  }
  const eol = /\r\n|\r|\n/.exec(raw)?.[0] ?? '\n'
  let result = '', position = 0
  for (const change of diff(before.split(''), next.split(''))) {
    result += raw.slice(position, offsets[change.b0]) + next.slice(change.s0, change.s1).replace(/\n/g, eol)
    position = offsets[change.b1]
  }
  return result + raw.slice(position)
}

