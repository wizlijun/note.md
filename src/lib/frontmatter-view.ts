import type { FrontmatterViewFactory } from '@moraya/core'

/** Keep YAML in the document model; editing metadata belongs to Source mode. */
export const frontmatterFactory: FrontmatterViewFactory = {
  render(container) {
    // Hide the NodeView itself so it occupies no space and has no focus target.
    // Inline display also wins over the editor skin's frontmatter block styles.
    container.hidden = true
    container.style.display = 'none'
    return { destroy() { /* DOM owned by the NodeView */ } }
  },
}
