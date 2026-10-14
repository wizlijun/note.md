import { scanOwnerAnnotations } from '../lib/share-merge/critic'
function counts(raw: string): Map<string, number> {
  const result = new Map<string, number>()
  for (const annotation of scanOwnerAnnotations(raw)) result.set(annotation.raw, (result.get(annotation.raw) ?? 0) + 1)
  return result
}
/** This protects counts of exact raw annotations, not individual occurrences. */
export function ownerAnnotationFloor(base: string, initial: string): ReadonlyMap<string, number> {
  const initialCounts = counts(initial)
  return new Map([...counts(base)].map(([raw, count]) => [raw, Math.min(count, initialCounts.get(raw) ?? 0)]))
}
export function acceptsOwnerFloor(floor: ReadonlyMap<string, number>, candidate: string): boolean {
  const current = counts(candidate)
  return [...floor].every(([raw, count]) => (current.get(raw) ?? 0) >= count)
}
