interface ProjectedLot {
  node: { id: string; nodeType: string; evidence?: string[] }
  x: number
  z: number
  style?: string
}

/** Overview blocks are visual containers; their members retain their original identities. */
export function overviewBlocks<T extends ProjectedLot>(lots: T[]): { x: number; z: number; members: T[]; representatives: T[] }[] {
  const blocks = new Map<string, { x: number; z: number; members: T[]; representatives: T[] }>()
  for (const lot of lots) {
    if (lot.style) continue
    const x = Math.floor(lot.x / 8) * 8 + 4, z = Math.floor(lot.z / 8) * 8 + 4
    const key = `${x}:${z}`
    let block = blocks.get(key)
    if (!block) { block = { x, z, members: [], representatives: [] }; blocks.set(key, block) }
    block.members.push(lot)
  }
  const rank = (lot: T) => lot.node.nodeType === 'project' ? 0 : ['concept', 'entity'].includes(lot.node.nodeType) ? 1 : 2
  for (const block of blocks.values()) {
    block.members.sort((a, b) => rank(a) - rank(b) || (b.node.evidence?.length ?? 0) - (a.node.evidence?.length ?? 0) || (a.node.id < b.node.id ? -1 : a.node.id > b.node.id ? 1 : 0))
    block.representatives = block.members.slice(0, 9)
  }
  return [...blocks.values()].sort((a, b) => a.x - b.x || a.z - b.z)
}
