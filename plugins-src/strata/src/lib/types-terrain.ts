/** Backend supplies the complete authorized atlas, never only the selected dates. */
export interface SourceSupport {
  groupId: string
  groupVersion: string
  priority: number
  dates: string[]
  /** Frozen membership of this source group; includes members not yet drawable. */
  canonicalIds?: string[]
}

export interface TerrainInputNode {
  id: string
  title: string
  kind?: string
  state?: 'candidate' | 'verified'
  features?: string[]
  links?: string[]
  ownerSpecificity?: 'owner_specific' | 'general' | 'unknown'
  confidentiality?: 'confidential' | 'explicitly_public' | 'unknown'
  sourceGroups: SourceSupport[]
}

export interface AtlasNode extends TerrainInputNode {
  /** Coordinates in the fixed normalized world, independent of date selection. */
  x: number
  y: number
  radius: number
  parentTopic: string
  parentDomain: string
  crowded: boolean
}

export interface AtlasCluster {
  id: string
  name: string
  parentId?: string
  x: number
  y: number
  radius: number
  memberIds: string[]
}

export interface Atlas {
  version: string
  epoch: string
  worldSize: number
  nodes: AtlasNode[]
  domains: AtlasCluster[]
  topics: AtlasCluster[]
  idf: Record<string, number>
  diagnostics: {
    graphEdges: number
    crowdedNodes: number
    rebuildSuggested: boolean
    elapsedMs: number
  }
}

export interface TerrainBounds { x: number; y: number; width: number; height: number }
export interface TerrainGrid { width: number; height: number; bounds: TerrainBounds }
export interface TerrainContour {
  type: 'MultiPolygon'
  value: number
  /** D3 grid coordinates; world = bounds origin + coordinate / grid size * bounds size. */
  coordinates: number[][][][]
}
export interface PeakAnchor { id: string; x: number; y: number; height: number; resolved: boolean }

export interface TerrainSelection {
  from: string
  to: string
  includePublic?: boolean
  /** Explicit scope mask; omitted means all authorized nodes matching the dates. */
  nodeIds?: string[]
}

export interface TerrainRenderOptions {
  width?: number
  height?: number
  bounds?: TerrainBounds
  /** Select fixed thresholds, never rescale them to current min/max. */
  contourStep?: number
}

export interface TerrainResult {
  field: Float32Array
  grid: TerrainGrid
  contours: TerrainContour[]
  levels: number[]
  peakAnchors: PeakAnchor[]
  layout: Atlas
  visibleIds: string[]
  /** Aligned with layout.nodes. */
  masses: Float32Array
  stats: {
    elapsedMs: number
    selectedNodes: number
    totalMass: number
    fieldIntegral: number
    kernelBytes: number
    contourVertices: number
    contoursTruncated: boolean
    unresolvedPeaks: number
  }
}

export interface TerrainWorkerRequest {
  id: number
  action: 'build' | 'render'
  nodes?: TerrainInputNode[]
  epoch?: string
  previousAtlas?: Atlas
  selection: TerrainSelection
  options?: TerrainRenderOptions
}
export interface TerrainWorkerResponse {
  id: number
  result?: Omit<TerrainResult, 'layout'> & { layout?: Atlas }
  error?: string
}
