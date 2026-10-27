import { it, expect } from 'vitest'
import { sha256 } from './hash'
it('uses standard UTF-8 SHA-256 with the shared prefix', async () => {
  expect(await sha256('abc')).toBe('sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  expect(await sha256('中文')).toBe('sha256:72726d8818f693066ceb69afa364218b692e62ea92b385782363780f47529c21')
})
