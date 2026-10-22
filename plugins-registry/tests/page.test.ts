import { describe, expect, it } from 'vitest'
import { PAGE_HTML } from '../src/page'

describe('marketplace plugin metadata', () => {
  it('does not advertise the removed OpenClaw plugin', () => {
    expect(PAGE_HTML).not.toMatch(/openclaw/i)
    expect(PAGE_HTML).toContain('notemd.claude-agent')
  })
})
