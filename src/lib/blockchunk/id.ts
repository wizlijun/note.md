/** Strict regex for a block id: `b-` + 6 lowercase hex chars. */
export const BLOCK_ID_RE = /^b-[0-9a-f]{6}$/

const HEX = '0123456789abcdef'

function randomHex6(): string {
  // Use crypto for strong randomness so the 24 bits are uniform.
  const buf = new Uint8Array(3)
  crypto.getRandomValues(buf)
  let out = ''
  for (const byte of buf) out += HEX[byte >> 4] + HEX[byte & 0x0f]
  return out
}

/**
 * Allocate a fresh block id that is not in `reservedIds`. Caller should pass
 * the union of currently-active and historically-retired ids.
 *
 * 24-bit space (16M possibilities) makes accidental collision essentially
 * impossible for any single document. We retry up to 3 times for paranoia.
 */
export function newBlockId(reservedIds: Set<string>): string {
  for (let i = 0; i < 3; i++) {
    const id = `b-${randomHex6()}`
    if (!reservedIds.has(id)) return id
  }
  throw new Error('newBlockId: id space exhausted (3 collisions in a row)')
}
