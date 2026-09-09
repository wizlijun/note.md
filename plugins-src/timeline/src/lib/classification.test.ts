import { describe, expect, it } from 'vitest'
import { classifyItem, DEFAULT_RULES, normalizeRules, type ClassificationRule } from './classification'

describe('activity keyword rules', () => {
  it('matches a keyword anywhere inside the activity category', () => {
    expect(classifyItem({ action: '产品代码审阅与修订' }, DEFAULT_RULES).category).toBe('work')
    expect(classifyItem({ action: '晚间家庭安排' }, DEFAULT_RULES).category).toBe('life')
    expect(classifyItem({ action: 'REVIEW code' }, DEFAULT_RULES).category).toBe('work')
  })
  it('never classifies using the activity description or the rule name', () => {
    const item = { action: '未知', text: '审阅开发会议家庭阅读' }
    expect(classifyItem(item, DEFAULT_RULES).category).toBe('other')
    expect(classifyItem({ action: '审阅' }, [{ id: 'a', name: '审阅', keywords: ['家庭'], category: 'life' }]).category).toBe('other')
  })
  it('uses the first matching rule, including an explicit other override', () => {
    const rules: ClassificationRule[] = [
      { id: 'a', name: '特例', keywords: ['家庭沟通'], category: 'life' },
      { id: 'b', name: '一般', keywords: ['沟通'], category: 'work' },
    ]
    expect(classifyItem({ action: '晚间家庭沟通' }, rules).category).toBe('life')
    expect(classifyItem({ action: '晚间家庭沟通' }, [...rules].reverse()).category).toBe('work')
  })
  it('validates persisted rules without silently dropping mistakes', () => {
    expect(normalizeRules(DEFAULT_RULES)).toEqual(DEFAULT_RULES)
    expect(normalizeRules([])).toEqual([])
    for (const value of [null, {}, [{ ...DEFAULT_RULES[0], keywords: [' '] }], [{ ...DEFAULT_RULES[0], category: 'blue' }], [DEFAULT_RULES[0], DEFAULT_RULES[0]]]) expect(normalizeRules(value)).toBeNull()
    expect(classifyItem({ action: '审阅' }, [{ ...DEFAULT_RULES[0], keywords: [''] }]).category).toBe('other')
  })
})
