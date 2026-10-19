import type { MermaidLoader } from '@moraya/core'
/** Stable desktop capability; shared mounts never import this adapter. */
export const loadDesktopMermaid: MermaidLoader = () => import.meta.env.VITE_DIAGRAM_RENDERER === 'mermaid'
  ? import('@moraya/core/plugins/mermaid-renderer')
  : import('./pele-loader')
