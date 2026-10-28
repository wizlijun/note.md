import { describe, expect, it } from 'vitest'
import { TEMPLATE_FILES, SKILL_FILES, parseDataSources, seedFiles, needsConsent } from './template'

const base = '.notemd/agent-tasks/next-task-kickoff-v3'
describe('kickoff templates', () => {
  it('uses identical instructions and research protocol and read-only configuration', () => {
    expect(TEMPLATE_FILES[`${base}/CLAUDE.md`]).toBe(TEMPLATE_FILES[`${base}/AGENTS.md`])
    expect(TEMPLATE_FILES[`${base}/CLAUDE.md`]).toMatch(/^<!-- next-task-kickoff template v3 -->/)
    for (const text of ['next-kickoff/v1', '不写', '30 分钟', '90 天']) expect(TEMPLATE_FILES[`${base}/CLAUDE.md`] + SKILL_FILES['skills/task-kickoff/SKILL.md']).toContain(text)
    expect(JSON.parse(TEMPLATE_FILES[`${base}/task.json`])).toMatchObject({ protocol_version: 3, strict_readonly: false, max_turns: 40, timeout_seconds: 600 })
    for (const name of ['settings.json', 'settings.scoped.json']) expect(JSON.parse(TEMPLATE_FILES[`${base}/.claude/${name}`]).permissions.deny).toEqual(expect.arrayContaining(['Write', 'Edit', 'mcp__*']))
    expect(TEMPLATE_FILES[`${base}/AGENTS.md`]).toContain('notemd search')
    expect(TEMPLATE_FILES[`${base}/AGENTS.md`]).toContain('联网检索')
    expect(JSON.parse(TEMPLATE_FILES[`${base}/.claude/settings.json`]).permissions.allow).toContain('Bash(notemd search:*)')
    expect(JSON.parse(TEMPLATE_FILES[`${base}/policy.json`]).permission_mode).toBe('read-only')
  })
  it('requires source display fields accepted by the payload contract', () => {
    const instructions = TEMPLATE_FILES[`${base}/CLAUDE.md`]
    expect(instructions).toContain('{id,resource,title,locator}')
    expect(instructions).toContain('title、locator 必填，均为可空字符串')
    expect(instructions).not.toContain('title?')
    expect(SKILL_FILES['skills/task-kickoff/SKILL.md']).not.toContain('{id,resource,title,locator}')
    expect(instructions).not.toContain('先读 `${VAULT}')
    expect(instructions).not.toContain('只读 `${VAULT}')
  })
  it('seeds only missing files and consent depends on skill existence', async () => {
    const files = new Map<string, string>([['existing', 'user edited']])
    const io = { exists: async (path: string) => ({ exists: files.has(path) }), read: async (path: string) => ({ content: files.get(path) ?? '' }), write: async (path: string, content: string) => { files.set(path, content); return { ok: true } } }
    expect(await needsConsent(io)).toBe(true)
    await seedFiles(io, { existing: 'replacement', fresh: 'new', ...SKILL_FILES })
    expect(files.get('existing')).toBe('user edited')
    expect(files.get('fresh')).toBe('new')
    expect(await needsConsent(io)).toBe(false)
  })
  it('reads vault sources and preserves disabled unsupported sources', () => {
    expect(parseDataSources(SKILL_FILES['skills/task-kickoff/SKILL.md'])).toHaveLength(4)
    expect(parseDataSources('---\ndata_sources:\n - id: mail\n   kind: gmail\n   label: 邮件\n   paths: []\n---\n')[0]).toMatchObject({ id: 'mail', enabled: false })
    for (const malformed of ['', '---\ndata_sources: [\n---\n', '---\ndata_sources: []\n---\n', '---\ndata_sources:\n - id: bad\n---\n']) expect(parseDataSources(malformed)).toEqual([expect.objectContaining({ id: 'task', kind: 'vault', enabled: true, fallback: true })])
  })
  it('surfaces write failures', async () => {
    await expect(seedFiles({ exists: async () => ({ exists: false }), read: async () => ({ content: '' }), write: async () => ({ ok: false }) }, { a: 'b' })).rejects.toThrow('a')
  })
})
