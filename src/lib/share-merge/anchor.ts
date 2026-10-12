import type { AnchorResult, TextSelector } from './types'

export function makeSelector(text: string, start: number, end: number): TextSelector {
  return { exact: text.slice(start, end), prefix: text.slice(Math.max(0, start - 32), start),
    suffix: text.slice(end, end + 32), start, end }
}

function occurrences(text: string, exact: string): number[] {
  const positions: number[] = []
  for (let at = text.indexOf(exact); at >= 0 && positions.length < 1000; at = text.indexOf(exact, at + 1)) positions.push(at)
  return positions
}

function commonContext(text: string, start: number, length: number, prefix: string, suffix: string): number {
  let before = 0
  let after = 0
  while (before < prefix.length && start > before && prefix[prefix.length - 1 - before] === text[start - 1 - before]) before++
  while (after < suffix.length && suffix[after] === text[start + length + after]) after++
  return before + after
}

// Reuse two banded rows for all windows beginning at a candidate start.
// Values above the threshold cannot contribute to any acceptable distance.
function windowDistances(text: string, start: number, exact: string, minLength: number, maxLength: number,
  threshold: number, visit: (length: number, distance: number) => void): void {
  const n = exact.length
  let previous = new Int32Array(n + 1)
  let current = new Int32Array(n + 1)
  previous.fill(threshold + 1)
  for (let j = 0; j <= Math.min(n, threshold); j++) previous[j] = j
  for (let i = 1; i <= maxLength; i++) {
    const low = Math.max(1, i - threshold)
    const high = Math.min(n, i + threshold)
    current[0] = i <= threshold ? i : threshold + 1
    if (low > 1) current[low - 1] = threshold + 1
    let minimum = current[0]
    for (let j = low; j <= high; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1,
        previous[j - 1] + (text[start + i - 1] === exact[j - 1] ? 0 : 1))
      minimum = Math.min(minimum, current[j])
    }
    if (high < n) current[high + 1] = threshold + 1
    if (i >= minLength && high === n && current[n] <= threshold) visit(i, current[n])
    if (minimum > threshold) break
    const swap = previous
    previous = current
    current = swap
  }
}

function similarContext(actual: string, expected: string): boolean {
  const limit = Math.floor(expected.length * 0.4)
  if (Math.abs(actual.length - expected.length) > limit) return false
  let matches = actual.length === 0 && expected.length <= limit
  windowDistances(actual, 0, expected, actual.length, actual.length, limit, () => { matches = true })
  return matches
}

export function anchor(text: string, selector: TextSelector): AnchorResult {
  const { exact, prefix = '', suffix = '', start, end } = selector
  if (start !== undefined && end !== undefined && Number.isSafeInteger(start) && Number.isSafeInteger(end) &&
    start >= 0 && end >= start && end <= text.length && text.slice(start, end) === exact) return { status: 'exact', start, end }
  const center = start ?? 0
  const nearest = (positions: number[]) => positions.sort((a, b) => Math.abs(a - center) - Math.abs(b - center) || a - b)[0]
  if (exact) {
    const positions = occurrences(text, exact)
    if (positions.length) {
      positions.sort((a, b) => commonContext(text, b, exact.length, prefix, suffix) - commonContext(text, a, exact.length, prefix, suffix) ||
        Math.abs(a - center) - Math.abs(b - center) || a - b)
      return { status: 'exact', start: positions[0], end: positions[0] + exact.length }
    }
  } else {
    if (prefix || suffix) {
      const joined = occurrences(text, prefix + suffix)
      if (joined.length) {
        const at = nearest(joined) + prefix.length
        return { status: 'exact', start: at, end: at }
      }
      for (const [context, offset] of [[prefix, prefix.length], [suffix, 0]] as const) {
        if (!context) continue
        const positions = occurrences(text, context)
        if (positions.length === 1) return { status: 'exact', start: positions[0] + offset, end: positions[0] + offset }
      }
    }
    return { status: 'orphan' }
  }
  if (exact.length < 8 || exact.length > 512) return { status: 'orphan' }
  const threshold = Math.floor(exact.length * 0.2)
  const minLength = Math.ceil(exact.length * 0.8)
  const maxLength = Math.floor(exact.length * 1.2)
  const radius = 2000 + exact.length
  let best: { start: number; end: number; distance: number } | undefined
  const low = Math.max(0, Math.ceil(center - radius))
  const high = Math.min(text.length - minLength, Math.floor(center + radius))
  const starts = Array.from({ length: Math.max(0, high - low + 1) }, (_, i) => low + i)
  starts.sort((a, b) => Math.abs(a - center) - Math.abs(b - center) || a - b)
  const available = new Set(text.slice(low, Math.min(text.length, high + maxLength)).split(''))
  let minimumDistance = 0
  for (let i = 0; i < exact.length; i++) if (!available.has(exact[i])) minimumDistance++
  if (minimumDistance > threshold) return { status: 'orphan' }
  minimumDistance = Math.max(1, minimumDistance)
  // Precompute suffix eligibility once. If neither adjacent context can
  // pass, skip the quote DP entirely, including near-matching repeated text.
  const firstEnd = low + minLength
  const lastEnd = Math.min(text.length, high + maxLength)
  const suffixCounts = new Int32Array(Math.max(0, lastEnd - firstEnd + 2))
  if (suffix) {
    for (let at = firstEnd; at <= lastEnd; at++) suffixCounts[at - firstEnd + 1] = suffixCounts[at - firstEnd] +
      Number(similarContext(text.slice(at, at + suffix.length), suffix))
  }
  const suffixPasses = (at: number) => suffixCounts[at - firstEnd + 1] > suffixCounts[at - firstEnd]
  // Visit proximity ties in their final order. Later starts must improve the
  // distance. Missing quote characters bound the best achievable distance;
  // it is at least 1 because the exact-search stage found none.
  for (const at of starts) {
    const lengthLimit = Math.min(maxLength, text.length - at)
    const prefixPasses = !!prefix && similarContext(text.slice(Math.max(0, at - prefix.length), at), prefix)
    const needsSuffix = (prefix || suffix) && !prefixPasses
    if (needsSuffix && suffixCounts[at + lengthLimit - firstEnd + 1] === suffixCounts[at + minLength - firstEnd]) continue
    const limit = best ? best.distance - 1 : threshold
    windowDistances(text, at, exact, minLength, lengthLimit, limit, (length, distance) => {
      if (best && distance >= best.distance) return
      if (!needsSuffix || suffixPasses(at + length)) best = { start: at, end: at + length, distance }
    })
    if (best?.distance === minimumDistance) break
  }
  return best ? { status: 'fuzzy', start: best.start, end: best.end } : { status: 'orphan' }
}
