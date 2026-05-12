import { getAdapterFor, type DiagramAdapter } from 'mermaid-mini/canvasEdit'

const KEYWORD_TO_TYPE: Record<string, string> = {
  graph: 'flowchart-v2',
  flowchart: 'flowchart-v2',
  sequenceDiagram: 'sequenceDiagram',
  classDiagram: 'classDiagram',
  'classDiagram-v2': 'classDiagram',
  stateDiagram: 'stateDiagram',
  'stateDiagram-v2': 'stateDiagram',
  erDiagram: 'er',
  gantt: 'gantt',
  pie: 'pie',
  mindmap: 'mindmap',
  timeline: 'timeline',
  gitGraph: 'gitGraph',
  C4Context: 'c4',
  C4Container: 'c4',
  C4Component: 'c4',
  C4Dynamic: 'c4',
  C4Deployment: 'c4',
  architecture: 'architecture',
  block: 'block',
  'block-beta': 'block',
  kanban: 'kanban',
  sankey: 'sankey',
  'sankey-beta': 'sankey',
  xychart: 'xychart',
  'xychart-beta': 'xychart',
  quadrantChart: 'quadrantChart',
  requirement: 'requirement',
  requirementDiagram: 'requirement',
  journey: 'journey',
  packet: 'packet',
  'packet-beta': 'packet',
  radar: 'radar',
  venn: 'venn',
  wardley: 'wardley',
  treemap: 'treemap',
  treeView: 'treeView',
  ishikawa: 'ishikawa',
}

export function detectDiagramType(source: string): string | null {
  const lines = source.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('%%')) continue
    const keyword = trimmed.split(/[\s:{([\-]/)[0]
    if (keyword && keyword in KEYWORD_TO_TYPE) {
      return KEYWORD_TO_TYPE[keyword]
    }
    break
  }
  return null
}

export function getCanvasAdapter(source: string): DiagramAdapter | undefined {
  const type = detectDiagramType(source)
  if (!type) return undefined
  return getAdapterFor(type)
}
