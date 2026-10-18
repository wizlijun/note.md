import { renderPeleSvg } from '../lib/diagrams/pele-renderer'
import type { ShareMermaidAppearance } from './contract'

export const shareMermaid = {
  supportsResponsiveLayout: true,
  async render(code: string, appearance: ShareMermaidAppearance, options?: { maxWidth?: number }): Promise<string> {
    return renderPeleSvg(code, { ...options, appearance, links: false })
  },
}
if (typeof window !== 'undefined') Object.assign(window, { NotemdShareMermaid: shareMermaid })
