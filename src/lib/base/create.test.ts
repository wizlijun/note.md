import { describe, it, expect } from 'vitest'
import { newBaseTemplate } from './create'
import { parseBase } from './parse'

describe('newBaseTemplate', () => {
  it('produces a valid single-table .base parseable with no error', () => {
    const cfg = parseBase(newBaseTemplate())
    expect(cfg.error).toBeUndefined()
    expect(cfg.views).toHaveLength(1)
    expect(cfg.views[0].type).toBe('table')
    expect(cfg.views[0].order).toContain('file.name')
  })
})
