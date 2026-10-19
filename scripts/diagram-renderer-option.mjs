export function diagramRendererOption(value) {
  if (value === undefined || value === '' || value === 'pele') return 'pele'
  if (value === 'mermaid') return 'mermaid'
  throw new Error(`Invalid VITE_DIAGRAM_RENDERER: ${value}; expected mermaid or pele`)
}
