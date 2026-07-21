export function decisionId(dateISO: string, seq: number): string {
  return `${dateISO}-${String(seq).padStart(2, '0')}`
}
export function nextSeq(existingIds: string[], dateISO: string): number {
  const prefix = `${dateISO}-`
  const seqs = existingIds
    .filter((id) => id.startsWith(prefix))
    .map((id) => parseInt(id.slice(prefix.length), 10))
    .filter((n) => Number.isFinite(n))
  return (seqs.length ? Math.max(...seqs) : 0) + 1
}
