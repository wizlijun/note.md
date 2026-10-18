import type { MermaidLoader } from '@moraya/core'
/** Stable desktop capability; shared mounts never import this adapter. */
export const loadDesktopMermaid: MermaidLoader = () => import.meta.env.VITE_DIAGRAM_RENDERER === 'pele'
  ? import('./pele-loader')
  : import('@moraya/core/plugins/mermaid-renderer')
