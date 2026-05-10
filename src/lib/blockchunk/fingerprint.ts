/**
 * Compact representation of a block's content used to detect identity across
 * edits. `hash` is the fast path (untouched blocks); `shingles` enables
 * Jaccard similarity for "edited" blocks.
 */
export interface BlockFingerprint {
  hash: string       // SHA-256 of normalized text, truncated to 12 hex chars
  shingles: string   // sorted, '|'-joined 5-gram set of normalized text
  length: number     // length(normalizedText)
}

/**
 * Lowercase + collapse whitespace + trim. Structural markdown markers (#, -,
 * >) are kept because they carry block-type information and help the
 * matcher distinguish a heading from a paragraph that happens to share words.
 */
export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim()
}

const SHINGLE_K = 5

function shingleSet(normalized: string): Set<string> {
  const out = new Set<string>()
  if (normalized.length < SHINGLE_K) {
    if (normalized.length > 0) out.add(normalized)
    return out
  }
  for (let i = 0; i <= normalized.length - SHINGLE_K; i++) {
    out.add(normalized.slice(i, i + SHINGLE_K))
  }
  return out
}

async function sha256Hex(text: string, chars: number): Promise<string> {
  const data = new TextEncoder().encode(text)
  const buf = await crypto.subtle.digest('SHA-256', data)
  const arr = Array.from(new Uint8Array(buf))
  return arr.map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, chars)
}

export async function computeFingerprint(text: string): Promise<BlockFingerprint> {
  const norm = normalizeText(text)
  const hash = await sha256Hex(norm, 12)
  const shingles = Array.from(shingleSet(norm)).sort().join('|')
  return { hash, shingles, length: norm.length }
}

/**
 * Jaccard similarity over the 5-gram shingle sets of two fingerprints.
 * O(|A|+|B|) using the serialized sorted strings.
 */
export function jaccard(a: BlockFingerprint, b: BlockFingerprint): number {
  if (a.shingles === '' && b.shingles === '') return 1.0
  if (a.shingles === '' || b.shingles === '') return 0.0
  const setA = new Set(a.shingles.split('|'))
  const setB = new Set(b.shingles.split('|'))
  let inter = 0
  for (const s of setA) if (setB.has(s)) inter++
  const union = setA.size + setB.size - inter
  return union === 0 ? 0 : inter / union
}
