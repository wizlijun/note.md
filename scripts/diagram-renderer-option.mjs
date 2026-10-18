export function diagramRendererOption(value) {
  if (value === undefined || value === '' || value === 'mermaid') return 'mermaid'
  if (value === 'pele') return 'pele'
  throw new Error(`Invalid VITE_DIAGRAM_RENDERER: ${value}; expected mermaid or pele`)
}
