import { describe, expect, it } from 'vitest'
import { crc32 as nativeCrc32, deflateRawSync } from 'node:zlib'
import { Buffer } from 'node:buffer'
import { strToU8, zipSync } from 'fflate'
import { validateProjectZip } from '../src/project-zip'

const prefix = '.__notemd-full_1/'
async function packageOf(source: Uint8Array, path = 'README.md', level: 0 | 6 = 6, declaredBytes = source.length) {
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', source))].map(n => n.toString(16).padStart(2, '0')).join('')
  return zipSync({ [path]: source, [prefix + 'reader.html']: strToU8('<p>full</p>'),
    [prefix + 'manifest.json']: strToU8(JSON.stringify({ schemaVersion: 1, project_id: 'project_1', snapshotId: 'full_1', entry: path, htmlPath: prefix + 'reader.html', files: [{ path, hash, bytes: declaredBytes }] })),
  }, { level })
}
function firstCentral(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer)
  for (let p = 0; p < bytes.length - 46; p++) if (view.getUint32(p, true) === 0x02014b50) return p
  throw new Error('central record missing')
}
const validate = (bytes: Uint8Array, path = 'README.md') => validateProjectZip(bytes, 'project_1', 'full_1', path)

describe('project ZIP runtime and boundaries', () => {
  it('provides native CRC32 in the deployed workerd compatibility mode', () => {
    expect(nativeCrc32(strToU8('123456789'))).toBe(0xcbf43926)
    expect(deflateRawSync(new Uint8Array()).length).toBeGreaterThan(0)
  })
  it.each([0, 6] as const)('accepts empty source files with compression level %i', async level => {
    expect(new TextDecoder().decode(await validate(await packageOf(new Uint8Array(), 'README.md', level)))).toBe('<p>full</p>')
  })
  it.each(['.notemd/project.json', 'docs/.notemd/manifest.json', 'docs/.NOTEMD/secret.md'])('refuses mirror management source paths: %s', async path => {
    await expect(validate(await packageOf(strToU8('private'), path), path)).rejects.toThrow('invalid ZIP manifest file')
  })
  it.each([0, 6] as const)('rejects bad CRC after structurally consistent headers at level %i', async level => {
    const bytes = await packageOf(strToU8('# Hello'), 'README.md', level), view = new DataView(bytes.buffer)
    view.setUint32(14, 0, true); view.setUint32(firstCentral(bytes) + 16, 0, true)
    await expect(validate(bytes)).rejects.toThrow('checksum')
  })
  it('validates 63 source files and a self-contained reader at real project scale', async () => {
    const files: Record<string, Uint8Array> = {}, manifest: { path: string; hash: string; bytes: number }[] = []
    for (let i = 0; i < 63; i++) {
      const bytes = new Uint8Array(i < 31 ? 21535 : 141004)
      for (let p = 0; p < bytes.length; p += 65536) crypto.getRandomValues(bytes.subarray(p, p + 65536))
      const path = i === 0 ? 'README.md' : i < 31 ? `docs/${i}.md` : `assets/${i}.bin`
      files[path] = bytes
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('')
      manifest.push({ path, hash, bytes: bytes.length })
    }
    const html = strToU8('<html>' + Object.values(files).map(bytes => Buffer.from(bytes).toString('base64')).join('\n') + '</html>')
    files[prefix + 'manifest.json'] = strToU8(JSON.stringify({ schemaVersion: 1, project_id: 'project_1', snapshotId: 'full_1', entry: 'README.md', htmlPath: prefix + 'reader.html', files: manifest }))
    files[prefix + 'reader.html'] = html
    const zip = zipSync(files, { level: 6 })
    expect(zip.length).toBeGreaterThan(9 * 1024 * 1024)
    const output = await validate(zip)
    expect(output.length).toBe(html.length)
    expect(nativeCrc32(output)).toBe(nativeCrc32(html))
  }, 15000)
  it('rejects a source declared empty whose deflate stream produces one byte', async () => {
    const bytes = await packageOf(strToU8('X'), 'README.md', 6, 0), view = new DataView(bytes.buffer)
    view.setUint32(22, 0, true); view.setUint32(firstCentral(bytes) + 24, 0, true)
    await expect(validate(bytes)).rejects.toThrow()
  })
  it('rejects a truncated deflate stream even when it produces the declared output', async () => {
    const original = await packageOf(strToU8('# Hello'))
    const old = new DataView(original.buffer), nameLength = old.getUint16(26, true), dataStart = 30 + nameLength + old.getUint16(28, true)
    const compressed = old.getUint32(18, true), cut = dataStart + compressed - 1
    const bytes = new Uint8Array(original.length - 1); bytes.set(original.subarray(0, cut)); bytes.set(original.subarray(cut + 1), cut)
    const view = new DataView(bytes.buffer), central = firstCentral(bytes)
    view.setUint32(18, compressed - 1, true); view.setUint32(central + 20, compressed - 1, true)
    let p = central
    while (view.getUint32(p, true) === 0x02014b50) {
      const local = view.getUint32(p + 42, true)
      if (local > cut) view.setUint32(p + 42, local - 1, true)
      p += 46 + view.getUint16(p + 28, true) + view.getUint16(p + 30, true) + view.getUint16(p + 32, true)
    }
    view.setUint32(p + 16, central, true)
    await expect(validate(bytes)).rejects.toThrow()
  })
})
