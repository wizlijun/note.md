import { Inflate } from 'fflate'

export const MAX_ZIP_BYTES = 32 * 1024 * 1024
export const MAX_FILE_BYTES = 25 * 1024 * 1024
const MAX_MANIFEST_BYTES = 256 * 1024
const MAX_FILES = 512
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false })
export function projectPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && new TextEncoder().encode(value).length <= 1024
    && !/[\\:\x00-\x1f]/.test(value) && value.split('/').every(part => !!part && part !== '.' && part !== '..')
}
export async function digest(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('')
}
export async function boundedBody(req: Request, limit: number): Promise<Uint8Array> {
  if (Number(req.headers.get('Content-Length')) > limit) throw new Error('body exceeds limit')
  const reader = req.body?.getReader()
  if (!reader) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > limit) { await reader.cancel(); throw new Error('body exceeds limit') }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return bytes
}
interface ZipEntry { path: string; method: number; size: number; crc: number; data: Uint8Array }
const crcTable = Uint32Array.from({ length: 256 }, (_, i) => {
  for (let j = 0; j < 8; j++) i = (i >>> 1) ^ (i & 1 ? 0xedb88320 : 0)
  return i >>> 0
})
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
// Parse central and local records before inflation; no filesystem extraction.
function entries(bytes: Uint8Array): Map<string, ZipEntry> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const u16 = (p: number) => view.getUint16(p, true)
  const u32 = (p: number) => view.getUint32(p, true)
  let end = bytes.length - 22
  for (; end >= Math.max(0, bytes.length - 65557); end--) {
    if (u32(end) === 0x06054b50 && end + 22 + u16(end + 20) === bytes.length) break
  }
  if (end < 0 || u32(end) !== 0x06054b50 || u16(end + 4) || u16(end + 6) || u16(end + 8) !== u16(end + 10)) throw new Error('invalid ZIP end')
  const count = u16(end + 10), start = u32(end + 16)
  if (count < 3 || count > MAX_FILES + 2 || start + u32(end + 12) !== end) throw new Error('invalid ZIP directory')
  const result = new Map<string, ZipEntry>(), names = new Set<string>()
  const ranges: { start: number; end: number }[] = []
  let offset = start, total = 0
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || u32(offset) !== 0x02014b50) throw new Error('invalid ZIP record')
    const flags = u16(offset + 8), method = u16(offset + 10), compressed = u32(offset + 20), size = u32(offset + 24)
    const nameLength = u16(offset + 28), local = u32(offset + 42), crc = u32(offset + 16)
    const next = offset + 46 + nameLength + u16(offset + 30) + u16(offset + 32)
    if (next > end || local + 30 > start || u32(local) !== 0x04034b50 || u16(offset + 34)) throw new Error('invalid ZIP offsets')
    const path = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength))
    const unixType = (u32(offset + 38) >>> 16) & 0xf000
    if (!projectPath(path) || names.has(path.toLowerCase()) || (unixType && unixType !== 0x8000)
      || (flags & ~0x0808) || ![0, 8].includes(method) || size > MAX_FILE_BYTES
      || u16(local + 6) !== flags || u16(local + 8) !== method || u16(local + 26) !== nameLength) throw new Error('unsafe ZIP entry')
    if (decoder.decode(bytes.subarray(local + 30, local + 30 + nameLength)) !== path) throw new Error('ZIP name mismatch')
    const dataStart = local + 30 + nameLength + u16(local + 28), dataEnd = dataStart + compressed
    let localEnd = dataEnd
    if (dataEnd > start) throw new Error('invalid ZIP data')
    if (flags & 8) {
      if (dataEnd + 12 > start) throw new Error('truncated ZIP descriptor')
      const descriptor = u32(dataEnd) === 0x08074b50 ? dataEnd + 4 : dataEnd
      if (descriptor + 12 > start || u32(descriptor) !== crc || u32(descriptor + 4) !== compressed || u32(descriptor + 8) !== size) throw new Error('invalid ZIP descriptor')
      localEnd = descriptor + 12
    } else if (u32(local + 14) !== crc || u32(local + 18) !== compressed || u32(local + 22) !== size) throw new Error('ZIP size mismatch')
    total += size
    if (total > MAX_FILE_BYTES * 2 + MAX_MANIFEST_BYTES) throw new Error('ZIP expands beyond limit')
    names.add(path.toLowerCase()); ranges.push({ start: local, end: localEnd })
    result.set(path, { path, method, size, crc, data: bytes.subarray(dataStart, dataEnd) })
    offset = next
  }
  if (offset !== end) throw new Error('ZIP directory mismatch')
  ranges.sort((a, b) => a.start - b.start)
  let cursor = 0
  for (const range of ranges) { if (range.start !== cursor) throw new Error('unlisted ZIP data'); cursor = range.end }
  if (cursor !== start) throw new Error('unlisted ZIP entries')
  return result
}
function inflate(entry: ZipEntry, limit: number): Uint8Array {
  if (entry.size > limit) throw new Error('ZIP entry exceeds limit')
  const output = new Uint8Array(entry.size)
  let length = 0
  const emit = (chunk: Uint8Array) => {
    length += chunk.length
    if (length > entry.size || length > limit) throw new Error('ZIP expands beyond declared size')
    output.set(chunk, length - chunk.length)
  }
  if (entry.method === 0) emit(entry.data)
  else {
    const stream = new Inflate(emit)
    for (let offset = 0; offset < entry.data.length; offset += 4096) stream.push(entry.data.subarray(offset, offset + 4096), offset + 4096 >= entry.data.length)
  }
  if (length !== entry.size || crc32(output) !== entry.crc) throw new Error('ZIP content checksum mismatch')
  return output
}
export async function validateProjectZip(bytes: Uint8Array, projectId: string, snapshotId: string, entry: string): Promise<Uint8Array> {
  const files = entries(bytes), internal = `.__notemd-${snapshotId}/`
  const manifestEntry = files.get(internal + 'manifest.json'), htmlEntry = files.get(internal + 'reader.html')
  if (!manifestEntry || !htmlEntry) throw new Error('ZIP publication missing')
  const manifest = JSON.parse(decoder.decode(inflate(manifestEntry, MAX_MANIFEST_BYTES)))
  if (manifest.schemaVersion !== 1 || manifest.project_id !== projectId || manifest.snapshotId !== snapshotId
    || manifest.entry !== entry || manifest.htmlPath !== htmlEntry.path || !Array.isArray(manifest.files)
    || !manifest.files.length || manifest.files.length > MAX_FILES || files.size !== manifest.files.length + 2) throw new Error('ZIP manifest mismatch')
  const seen = new Set<string>()
  let total = 0
  for (const file of manifest.files) {
    if (!file || !projectPath(file.path) || file.path.startsWith(internal) || seen.has(file.path.toLowerCase()) || !/^[a-f0-9]{64}$/.test(file.hash)
      || !Number.isSafeInteger(file.bytes) || file.bytes < 0) throw new Error('invalid ZIP manifest file')
    seen.add(file.path.toLowerCase())
    const source = files.get(file.path)
    if (!source || source.size !== file.bytes || (total += source.size) > MAX_FILE_BYTES || await digest(inflate(source, MAX_FILE_BYTES)) !== file.hash) throw new Error('ZIP source mismatch')
  }
  if (!seen.has(entry.toLowerCase()) || !files.has(entry)) throw new Error('ZIP entry missing')
  const expected = new Set([internal + 'manifest.json', htmlEntry.path, ...manifest.files.map((file: { path: string }) => file.path)])
  if (expected.size !== files.size || [...files.keys()].some(path => !expected.has(path))) throw new Error('ZIP contains unlisted files')
  return inflate(htmlEntry, MAX_FILE_BYTES)
}
