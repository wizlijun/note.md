import { renderPeleSvg } from '../diagrams/pele-renderer'
import { mermaidAppearance } from '../../share-editor/mermaid-loader'

export const supportsResponsiveLayout = true
export async function renderMermaid(code: string, options?: { maxWidth?: number }) {
  try {
    return { svg: renderPeleSvg(code, { ...options, appearance: mermaidAppearance(document.documentElement), links: true }) }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}
// Read the current computed theme on every render.
export function updateMermaidTheme() {}
