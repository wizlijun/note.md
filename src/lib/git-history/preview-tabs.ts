export interface PreviewTab {
  id: string
  title: string
  kind: 'diff' | 'rich'
  content: string
}

/** Merge a tab into the list: if `tab.id` already exists, replace it in place
 *  (keeping position); otherwise append. Returns a NEW array plus the id to
 *  activate (always the upserted tab). Pure — no mutation of `tabs`. */
export function upsertTab(tabs: PreviewTab[], tab: PreviewTab): { tabs: PreviewTab[]; activeId: string } {
  const idx = tabs.findIndex((x) => x.id === tab.id)
  const next = idx >= 0
    ? tabs.map((x, i) => (i === idx ? tab : x))
    : [...tabs, tab]
  return { tabs: next, activeId: tab.id }
}
