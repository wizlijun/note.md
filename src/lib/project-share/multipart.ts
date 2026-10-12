export const MULTIPART_BYTES = 5 * 1024 * 1024
export type ArtifactName = 'entry' | 'reader' | 'archive'
export interface ArtifactPlan {
  name: ArtifactName
  bytes: number
  sha256: string
  etag: string
  parts: { number: number; bytes: number; md5: string }[]
}

const shifts = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21]
const constants = Array.from({ length: 64 }, (_, index) => Math.floor(Math.abs(Math.sin(index + 1)) * 0x100000000))
const hex = (bytes: Uint8Array) => Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('')

/** RFC 1321 MD5, used only for R2's native multipart transmission checksums. */
export function md5Hex(input: Uint8Array): string {
  const padded = new Uint8Array(Math.ceil((input.length + 9) / 64) * 64)
  padded.set(input)
  padded[input.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, input.length * 8, true)
  view.setUint32(padded.length - 4, Math.floor(input.length / 0x20000000), true)
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476
  for (let offset = 0; offset < padded.length; offset += 64) {
    let a = a0, b = b0, c = c0, d = d0
    for (let index = 0; index < 64; index++) {
      const group = Math.floor(index / 16)
      const f = group === 0 ? (b & c) | (~b & d) : group === 1 ? (d & b) | (~d & c) : group === 2 ? b ^ c ^ d : c ^ (b | ~d)
      const word = group === 0 ? index : group === 1 ? (5 * index + 1) % 16 : group === 2 ? (3 * index + 5) % 16 : (7 * index) % 16
      const sum = (a + f + constants[index] + view.getInt32(offset + word * 4, true)) | 0
      const shift = shifts[group * 4 + index % 4]
      a = d; d = c; c = b; b = (b + ((sum << shift) | (sum >>> (32 - shift)))) | 0
    }
    a0 = (a0 + a) | 0; b0 = (b0 + b) | 0; c0 = (c0 + c) | 0; d0 = (d0 + d) | 0
  }
  const digest = new Uint8Array(16)
  const output = new DataView(digest.buffer)
  ;[a0, b0, c0, d0].forEach((value, index) => output.setInt32(index * 4, value, true))
  return hex(digest)
}

export async function artifactSha256(bytes: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)))
}

export async function createArtifactPlan(name: ArtifactName, bytes: Uint8Array): Promise<ArtifactPlan> {
  const parts = []
  for (let offset = 0; offset < bytes.length || !parts.length; offset += MULTIPART_BYTES) {
    const part = bytes.subarray(offset, Math.min(offset + MULTIPART_BYTES, bytes.length))
    parts.push({ number: parts.length + 1, bytes: part.length, md5: md5Hex(part) })
  }
  const digests = Uint8Array.from(parts.flatMap(part => part.md5.match(/../g)!.map(value => parseInt(value, 16))))
  return { name, bytes: bytes.length, sha256: await artifactSha256(bytes), etag: md5Hex(digests) + '-' + parts.length, parts }
}

export async function verifyArtifactPlan(plan: ArtifactPlan, bytes: Uint8Array): Promise<void> {
  if (JSON.stringify(await createArtifactPlan(plan.name, bytes)) !== JSON.stringify(plan)) throw new Error('发布产物与冻结计划不一致，请保留本轮记录并检查本机缓存。')
}
