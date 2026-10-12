import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { createArtifactPlan, md5Hex, MULTIPART_BYTES, verifyArtifactPlan } from './multipart'

describe('frozen multipart plans', () => {
  it('uses standard MD5 vectors without changing the source bytes', () => {
    for (const [input, expected] of [['', 'd41d8cd98f00b204e9800998ecf8427e'], ['abc', '900150983cd24fb0d6963f7d28e17f72'], ['message digest', 'f96b697d7cb7938d525a2f31aaf161d0']]) {
      expect(md5Hex(new TextEncoder().encode(input))).toBe(expected)
    }
  })
  it('freezes 5MiB parts and computes the native multipart ETag from binary digests', async () => {
    const bytes = new Uint8Array(MULTIPART_BYTES + 3).fill(97)
    const plan = await createArtifactPlan('reader', bytes)
    expect(plan.bytes).toBe(bytes.length)
    expect(plan.parts.map(part => [part.number, part.bytes])).toEqual([[1, MULTIPART_BYTES], [2, 3]])
    expect(plan.sha256).toMatch(/^[0-9a-f]{64}$/)
    const digests = Uint8Array.from(plan.parts.flatMap(part => part.md5.match(/../g)!.map(byte => parseInt(byte, 16))))
    expect(plan.etag).toBe(md5Hex(digests) + '-2')
    await expect(verifyArtifactPlan(plan, bytes)).resolves.toBeUndefined()
    bytes[bytes.length - 1] = 98
    await expect(verifyArtifactPlan(plan, bytes)).rejects.toThrow('冻结')
  })
  it('keeps an empty artifact as a single final part', async () => {
    const plan = await createArtifactPlan('archive', new Uint8Array())
    expect(plan.parts).toEqual([{ number: 1, bytes: 0, md5: 'd41d8cd98f00b204e9800998ecf8427e' }])
  })
})

it('matches independent native MD5 at padding and block boundaries', () => {
  for (const length of [0, 1, 55, 56, 63, 64, 65, 127, 128, 1024, MULTIPART_BYTES]) {
    const bytes = Uint8Array.from({ length }, (_, index) => index % 251)
    expect(md5Hex(bytes)).toBe(createHash('md5').update(bytes).digest('hex'))
  }
})
