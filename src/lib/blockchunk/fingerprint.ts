/**
 * Compact representation of a block's content used to detect identity across
 * edits.
 *
 *   - `hash` is the fast path: SHA-256 of normalized text (12 hex chars).
 *     Pass 1 of merge uses exact equality on this field.
 *
 *   - `minhash` is a fixed-size MinHash signature over the block's 5-gram
 *     shingle set. Persisted as a hex string in yaml. Used by Pass 2 / 3 / 4
 *     of merge for similarity-based id preservation across edits.
 *
 *     We use k=32 hashes, each a 32-bit unsigned integer. Approximate
 *     Jaccard ≈ (count of matching positions) / 32. Standard error ~ 0.18,
 *     which is enough to reliably classify the threshold-region blocks for
 *     our merge algorithm; misclassifications fall back to fresh-id +
 *     retired (with `replaced_by` linkage) and the citation-history chain
 *     still resolves them.
 *
 *   - `length` is the normalized character count. Used by `coverage` to
 *     estimate set-coverage from Jaccard when |small| << |big|.
 */
export interface BlockFingerprint {
  hash: string
  minhash: number[]   // length === MINHASH_K, each 32-bit unsigned
  length: number
}

export const MINHASH_K = 32
const MAX_HASH = 0xffffffff
const SHINGLE_K = 5

/**
 * Lowercase + collapse whitespace + trim. Structural markdown markers (#, -,
 * >) are kept because they carry block-type information and help the
 * matcher distinguish a heading from a paragraph that happens to share words.
 */
export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim()
}

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

/**
 * Seeded 32-bit FNV-1a. Mixing the seed into the FNV offset basis gives k
 * pseudo-independent hash functions. Result kept in unsigned-32 range via
 * `>>> 0`.
 */
function fnv1a(str: string, seed: number): number {
  let h = (2166136261 ^ seed) >>> 0
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h
}

function computeMinHash(shingles: Set<string>): number[] {
  const sig = new Array<number>(MINHASH_K).fill(MAX_HASH)
  for (const s of shingles) {
    for (let i = 0; i < MINHASH_K; i++) {
      const h = fnv1a(s, i)
      if (h < sig[i]) sig[i] = h
    }
  }
  return sig
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
  const minhash = computeMinHash(shingleSet(norm))
  return { hash, minhash, length: norm.length }
}

/**
 * Approximate Jaccard similarity from two MinHash signatures. Counts the
 * fraction of positions where the two signatures hold the same min-hash.
 * Returns 0 if either signature has no shingle data (length === 0).
 */
export function jaccard(a: BlockFingerprint, b: BlockFingerprint): number {
  if (a.length === 0 && b.length === 0) return 1
  if (a.length === 0 || b.length === 0) return 0
  if (a.minhash.length !== b.minhash.length) return 0
  let matches = 0
  for (let i = 0; i < a.minhash.length; i++) {
    if (a.minhash[i] === b.minhash[i]) matches++
  }
  return matches / a.minhash.length
}

/**
 * Approximate set-coverage of `small` by `big`: |A∩B| / |A|.
 *
 * Derived from Jaccard via:
 *     J = |A∩B| / |A∪B|
 *     |A∩B| = J × |A∪B|
 *     |A∪B| ≈ max(|A|, |B|)  when one set is much larger
 * giving:
 *     |A∩B| / |A| ≈ J × max(|A|, |B|) / |A|
 *
 * Capped at 1.0. Approximation; good enough for the split / merge
 * coverage thresholds we use (default 0.3).
 */
export function coverage(small: BlockFingerprint, big: BlockFingerprint): number {
  if (small.length === 0) return 0
  const j = jaccard(small, big)
  const denom = Math.max(1, small.length)
  const numer = Math.max(big.length, small.length)
  return Math.min(1, (j * numer) / denom)
}

/**
 * Hex-encode a MinHash signature: each 32-bit unsigned integer becomes
 * 8 hex chars; concatenated, no separators. Length === MINHASH_K * 8.
 */
export function serializeMinHash(arr: number[]): string {
  return arr.map((n) => (n >>> 0).toString(16).padStart(8, '0')).join('')
}

/**
 * Inverse of `serializeMinHash`. Returns a number[] of length MINHASH_K
 * if the input is well-formed; otherwise returns an array filled with
 * MAX_HASH (no shingles seen) so jaccard() will report similarity 0.
 */
export function parseMinHash(s: string): number[] {
  if (typeof s !== 'string' || s.length !== MINHASH_K * 8) {
    return new Array(MINHASH_K).fill(MAX_HASH)
  }
  const out: number[] = []
  for (let i = 0; i < s.length; i += 8) {
    const n = parseInt(s.slice(i, i + 8), 16)
    out.push(Number.isFinite(n) ? (n >>> 0) : MAX_HASH)
  }
  return out
}
