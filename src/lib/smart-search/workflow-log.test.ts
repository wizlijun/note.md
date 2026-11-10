import { describe, expect, it } from 'vitest'
import {
  appendWorkflowEntry,
  formatWorkflowLog,
  isNearLogBottom,
  WORKFLOW_LOG_LIMIT,
  type WorkflowEntry,
} from './workflow-log'

describe('smart-search workflow log', () => {
  it('keeps phase history and removes repeated provider snapshots', () => {
    let entries: WorkflowEntry[] = []
    entries = appendWorkflowEntry(entries, { id: 1, stage: 'summary', level: 'active', message: '理解问题' })
    entries = appendWorkflowEntry(entries, {
      id: 2, stage: 'summary', level: 'active', message: 'building plan', runId: 'p1', steps: 1,
    })
    const beforeDuplicate = entries
    const same = appendWorkflowEntry(entries, {
      id: 3, stage: 'summary', level: 'active', message: 'building plan', runId: 'p1', steps: 1,
    })
    entries = appendWorkflowEntry(same, { id: 4, stage: 'search', level: 'success', message: '找到 3 条' })

    expect(same).toBe(beforeDuplicate)
    expect(entries.map((entry) => entry.message)).toEqual(['理解问题', 'building plan', '找到 3 条'])
  })

  it('bounds runaway logs and keeps the newest terminal entry', () => {
    let entries: WorkflowEntry[] = []
    for (let id = 1; id <= WORKFLOW_LOG_LIMIT + 5; id += 1) {
      entries = appendWorkflowEntry(entries, {
        id, stage: 'summary', level: id === WORKFLOW_LOG_LIMIT + 5 ? 'success' : 'active',
        message: `step ${id}`,
      })
    }
    expect(entries).toHaveLength(WORKFLOW_LOG_LIMIT)
    expect(entries.at(-1)).toMatchObject({ message: `step ${WORKFLOW_LOG_LIMIT + 5}`, level: 'success' })
  })

  it('only follows the tail while the user is near the bottom', () => {
    expect(isNearLogBottom({ scrollTop: 176, clientHeight: 100, scrollHeight: 300 } as HTMLElement)).toBe(true)
    expect(isNearLogBottom({ scrollTop: 120, clientHeight: 100, scrollHeight: 300 } as HTMLElement)).toBe(false)
  })

  it('formats entries as one JSON object per line with timing and usage', () => {
    const text = formatWorkflowLog([
      { id: 1, stage: 'search', level: 'success', message: '找到 3 条', elapsedMs: 42 },
      { id: 2, stage: 'summary', level: 'success', message: 'ok', elapsedMs: 9100, usage: { input_tokens: 5 } },
      { id: 3, stage: 'handoff', level: 'warning', message: 'no timing' },
    ])
    expect(text.split('\n')).toEqual([
      '{"stage":"search","level":"success","elapsedMs":42,"usage":null,"message":"找到 3 条"}',
      '{"stage":"summary","level":"success","elapsedMs":9100,"usage":{"input_tokens":5},"message":"ok"}',
      '{"stage":"handoff","level":"warning","elapsedMs":null,"usage":null,"message":"no timing"}',
    ])
  })
})
