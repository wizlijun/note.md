import type { EditorView } from 'prosemirror-view'

/** Resolve Markdown heading fragments without relying on generated DOM IDs. */
export function findRichAnchorTarget(view: EditorView, href: string): HTMLElement | null {
  const raw = href.trim()
  if (!raw.startsWith('#') || raw === '#') return null
  let fragment: string
  try {
    fragment = decodeURIComponent(raw.slice(1))
  } catch {
    return null
  }

  const used = new Set<string>()
  let target: HTMLElement | null = null
  view.state.doc.descendants((node, pos) => {
    if (node.type.name !== 'heading') return
    // Read the document, not DOM text: live-preview widgets add Markdown
    // delimiters to the active heading. Preserve each space ("A × B" → "a--b").
    const base = node.textContent.trim().toLowerCase()
      .replace(/[\p{P}\p{S}]/gu, (char) => char === '-' || char === '_' ? char : '')
      .replace(/\s/g, '-')
    let slug = base
    let suffix = 0
    while (used.has(slug)) slug = `${base}-${++suffix}`
    used.add(slug)
    if (!target && (slug === fragment || node.attrs.id === fragment)) {
      const dom = view.nodeDOM(pos)
      if (dom instanceof HTMLElement) target = dom
    }
    return false
  })
  return target
}
