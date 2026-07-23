import { parseDateLink } from '../outline/daily'

export type LinkRoute =
  | { kind: 'external'; href: string }
  | { kind: 'feed-date'; date: string }
  | { kind: 'page'; page: string }
  | { kind: 'md'; path: string }

const WIKILINK_RE = /^\[\[(.+?)\]\]$/

export function classifyLink(raw: string): LinkRoute | null {
  const s = raw.trim()
  if (/^https?:\/\//i.test(s)) return { kind: 'external', href: s }
  const wl = s.match(WIKILINK_RE)
  if (wl) {
    const target = wl[1]
    const d = parseDateLink(target)
    if (d && d.kind === 'day') return { kind: 'feed-date', date: target }
    // A wikilink whose target is an actual .md file must open in the main editor,
    // not be treated as a wiki-page name.
    if (/\.md$/i.test(target)) return { kind: 'md', path: target }
    return { kind: 'page', page: target }
  }
  if (/\.md$/i.test(s)) return { kind: 'md', path: s }
  return null
}
