import type { MermaidLoader } from '@moraya/core'
/** Stable desktop capability; shared mounts never import this adapter. */
export const loadDesktopMermaid: MermaidLoader = () => import('@moraya/core/plugins/mermaid-renderer')
