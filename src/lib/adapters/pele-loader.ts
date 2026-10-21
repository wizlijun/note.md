import { renderPeleSvg } from '../diagrams/pele-renderer'
import { mermaidAppearance } from '../../share-editor/mermaid-loader'

export const supportsResponsiveLayout = true
export async function renderMermaid(code: string, options?: { maxWidth?: number; container?: HTMLElement }) {
  try {
    return { svg: renderPeleSvg(code, { maxWidth: options?.maxWidth, appearance: mermaidAppearance(options?.container ?? document.documentElement, 'pele'), links: true }) }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}
// Read the current computed theme on every render.
export function updateMermaidTheme() {}
