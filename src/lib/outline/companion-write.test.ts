import { describe, it, expect } from 'vitest'
import { decideCompanionWrite } from './companion-write'

describe('decideCompanionWrite', () => {
  it('无文件 → write（创建）', () => {
    expect(decideCompanionWrite({ fileExists: false, diskHash: null, lastHash: null, ourHash: 'a' })).toBe('write')
  })
  it('磁盘已等于我们要写的内容 → noop', () => {
    expect(decideCompanionWrite({ fileExists: true, diskHash: 'a', lastHash: 'x', ourHash: 'a' })).toBe('noop')
  })
  it('自加载以来磁盘未变 → write', () => {
    expect(decideCompanionWrite({ fileExists: true, diskHash: 'x', lastHash: 'x', ourHash: 'b' })).toBe('write')
  })
  it('磁盘在我们不知情时被改 → conflict', () => {
    expect(decideCompanionWrite({ fileExists: true, diskHash: 'y', lastHash: 'x', ourHash: 'b' })).toBe('conflict')
  })
  it('出现一个我们不知道的文件（lastHash 为 null） → conflict', () => {
    expect(decideCompanionWrite({ fileExists: true, diskHash: 'y', lastHash: null, ourHash: 'b' })).toBe('conflict')
  })
})
