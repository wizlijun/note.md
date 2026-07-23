/** 该天的全部节点文本里是否命中查询(大小写不敏感子串)。空查询恒真。 */
export function dayMatches(nodeTexts: string[], query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return nodeTexts.some(t => t.toLowerCase().includes(q))
}
