import { untrack } from 'svelte'
import type { FrontmatterViewFactory } from '@moraya/core'
import type { EditorView } from 'prosemirror-view'
import { settings } from './settings.svelte'
import { frontmatterFactory, readonlyFrontmatterFactory } from './frontmatter-view'
import { hiddenFrontmatterSelectionPlugin } from './hidden-frontmatter-selection'

/** Apply the display preference to each live NodeView without remounting its editor. */
function withVisibility(factory: FrontmatterViewFactory): FrontmatterViewFactory {
  return {
    render(container, raw, onChange) {
      let handle: ReturnType<FrontmatterViewFactory['render']>
      let rendered = false, destroyed = false
      function apply(hidden: boolean) {
        const active = container.ownerDocument.activeElement
        // A preference change from another window must commit a focused value
        // before hiding it. That commit can replace/destroy this NodeView.
        if (hidden && active instanceof HTMLElement && container.contains(active)) active.blur()
        if (destroyed) return
        container.hidden = hidden
        container.style.display = hidden ? 'none' : ''
        if (!hidden && !rendered) {
          rendered = true
          handle = factory.render(container, raw, onChange)
        }
      }
      apply(settings.hideRichFrontmatter)
      const stop = $effect.root(() => {
        $effect(() => {
          const hidden = settings.hideRichFrontmatter
          untrack(() => apply(hidden))
        })
      })
      return { destroy() { destroyed = true; stop(); handle?.destroy() } }
    },
  }
}

export const desktopFrontmatterFactory = withVisibility(frontmatterFactory)
export const readonlyDesktopFrontmatterFactory = withVisibility(readonlyFrontmatterFactory)

export function desktopFrontmatterSelectionPlugin(ensureBody: (view: EditorView) => void) {
  return hiddenFrontmatterSelectionPlugin({
    ensureBody,
    isHidden: () => settings.hideRichFrontmatter,
    observeVisibility: update => $effect.root(() => {
      $effect(() => {
        void settings.hideRichFrontmatter
        untrack(update)
      })
    }),
  })
}
