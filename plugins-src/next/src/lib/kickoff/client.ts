import type { AgentOption, AgentProviders } from '../agent-picker/types'
import type { AgentLimits, AgentRunParams, VaultInfo } from '../bridge'
import type { WorkspaceItem } from '../repository'
import { parseTaskSource } from '../task-source'
import { kickoffEligible } from './button-state'
import { buildKickoffDocument, carryPriorAnswers, kickoffPathFor, parseKickoffDocument, withAnswers, type KickoffAnswer, type KickoffDoc } from './document'
import { sha256 } from './hash'
import { parsePayload } from './payload'
import { REGISTRY_PATH, clearRun, markFailed, markRead as readRegistry, markRunning, markUnread, parseRegistry, serializeRegistry, type Registry, type KickoffRun } from './registry'
import { interpretKickoffStatus, type KickoffRunView } from './status'
import { needsConsent, parseDataSources, seedFiles, SKILL_FILES, TASK_ID, TEMPLATE_FILES, type DataSource } from './template'

const SKILL_PATH = 'skills/task-kickoff/SKILL.md'
export const KICKOFF_SAFETY_REASON = 'kickoff-safety-unverified'

export interface KickoffIo {
  exists(path: string): Promise<{ exists: boolean }>
  read(path: string): Promise<{ content: string }>
  write(path: string, content: string): Promise<{ ok: boolean }>
  list(path: string): Promise<{ entries: { name: string; is_dir: boolean }[] }>
  vaultInfo(): Promise<VaultInfo>
  agentProviders(): Promise<AgentProviders>
  agentLimits(): Promise<AgentLimits>
  agentRun(params: AgentRunParams): Promise<{ run_id: string }>
  agentStatus(task: string, runId: string, harness: string): Promise<unknown>
  /** Refresh the workspace projection, including its current lifecycle lane. */
  currentItem(taskId: string): Promise<WorkspaceItem | null>
}

export interface KickoffResult {
  path: string
  doc: KickoffDoc
}

export interface KickoffSnapshot {
  registry: Registry
  results: Record<string, KickoffResult>
  statuses: Record<string, KickoffRunView>
  hashes: Record<string, string>
  providers: AgentOption[]
  providerDefault: string
  unsupported: boolean
  dataSources: DataSource[]
  needsConsent: boolean
}

export interface KickoffStartInput {
  item: WorkspaceItem
  providerId: string
  today?: string
  consent?: boolean
}

export interface KickoffPreflight {
  taskId: string
  taskPath: string
  title: string
  basedOn: string
  lane: 'inbox' | 'waiting' | 'dormant'
  providerId: string
  vaultRoot: string
}

export interface SaveAnswersInput {
  taskId: string
  runId: string
  answers: KickoffAnswer[]
}

export class KickoffClientError extends Error {
  constructor(readonly kind: string, message: string) {
    super(message)
    this.name = 'KickoffClientError'
  }
}

export interface KickoffClientOptions {
  /** Explicit evidence injection for isolated integration tests. Production passes no overrides. */
  verifiedProviders?: readonly string[]
  now?: () => string
  notificationTitles?: { ok: string; fail: string }
}

const message = (error: unknown): string => error instanceof Error ? error.message : String(error)
const localDate = (): string => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** All asynchronous operations share one queue, including read/poll and answer saves. */
export function createKickoffClient(io: KickoffIo, options: KickoffClientOptions = {}) {
  const now = options.now ?? (() => new Date().toISOString())
  const state: KickoffSnapshot = {
    registry: parseRegistry(null),
    results: {},
    statuses: {},
    hashes: {},
    providers: [],
    providerDefault: '',
    unsupported: false,
    dataSources: [],
    needsConsent: true,
  }
  const pendingRuns: Record<string, Extract<KickoffRun, { state: 'running' }>> = {}
  let queue: Promise<unknown> = Promise.resolve()
  const snapshot = (): KickoffSnapshot => JSON.parse(JSON.stringify(state)) as KickoffSnapshot
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work).catch(error => {
      if (error instanceof KickoffClientError) throw error
      throw new KickoffClientError('io-error', message(error))
    })
    queue = next.catch(() => undefined)
    return next
  }
  const diskRegistry = async (): Promise<Registry> => (await io.exists(REGISTRY_PATH)).exists
    ? parseRegistry((await io.read(REGISTRY_PATH)).content) : parseRegistry(null)
  const withPending = (current: Registry): Registry => {
    for (const [id, run] of Object.entries(pendingRuns)) current = markRunning(current, id, run)
    return current
  }
  const registry = async (): Promise<Registry> => withPending(await diskRegistry())
  const writeVerified = async (path: string, content: string): Promise<void> => {
    if (!(await io.write(path, content)).ok) throw new KickoffClientError('io-error', `写入失败：${path}`)
    if ((await io.read(path)).content !== content) throw new KickoffClientError('io-error', `写后回读不一致：${path}`)
  }
  const updateRegistry = async (update: (current: Registry) => Registry): Promise<void> => {
    const latest = await diskRegistry()
    const next = update(withPending(latest))
    const content = serializeRegistry(next)
    if (content !== serializeRegistry(latest)) await writeVerified(REGISTRY_PATH, content)
    state.registry = next
    for (const id of Object.keys(pendingRuns)) delete pendingRuns[id]
  }
  const discover = async (): Promise<void> => {
    const found: Record<string, KickoffResult> = {}
    if ((await io.exists('inbox/tasks')).exists) {
      for (const entry of (await io.list('inbox/tasks')).entries) {
        if (entry.is_dir || !/^[^/\\\0]+\.kickoff\.md$/.test(entry.name) || entry.name === '..') continue
        const path = `inbox/tasks/${entry.name}`
        const doc = parseKickoffDocument((await io.read(path)).content)
        if (!doc) throw new KickoffClientError('conflict', `开头结果无法解析，已保留原文件：${path}`)
        const id = doc.kickoff.task_id
        if (found[id]) throw new KickoffClientError('conflict', `同一个 Task 有多份开头结果：${id}`)
        found[id] = { path, doc }
      }
    }
    state.results = found
  }
  const providers = async (): Promise<void> => {
    try {
      const result = await io.agentProviders()
      if (!Array.isArray(result.providers)) throw new KickoffClientError('unsupported', '宿主不支持 agent 列表，请更新 note.md')
      state.unsupported = false
      state.providerDefault = result.default
      state.providers = result.providers.map(provider => {
        if (options.verifiedProviders?.includes(provider.id)) return provider
        return {
          ...provider,
          harness: {
            ...(provider.harness ?? { harness: provider.name }),
            ok: false,
            hint: [provider.harness?.hint, KICKOFF_SAFETY_REASON].filter(Boolean).join('; '),
          },
        }
      })
    } catch (error) {
      if (error instanceof KickoffClientError || /unknown|unsupported|not found|not supported|method.*(?:missing|unavailable)/i.test(message(error))) {
        state.unsupported = true
        state.providers = []
        return
      }
      throw error
    }
  }
  const loadInternal = async (items: WorkspaceItem[] = []): Promise<KickoffSnapshot> => {
    state.registry = await registry()
    await providers()
    state.needsConsent = await needsConsent(io)
    const skill = (await io.exists(SKILL_PATH)).exists ? (await io.read(SKILL_PATH)).content : SKILL_FILES[SKILL_PATH]
    state.dataSources = parseDataSources(skill)
    for (const item of items) {
      if (!item.task || !item.path) continue
      if ((await io.exists(item.path)).exists) {
        const content = (await io.read(item.path)).content
        state.hashes[item.task.id] = await sha256(content)
      } else delete state.hashes[item.task.id]
    }
    await discover()
    return snapshot()
  }
  const preflightInternal = async (input: KickoffStartInput): Promise<KickoffPreflight> => {
    const id = input.item.task?.id
    if (!id || !kickoffEligible(input.item)) throw new KickoffClientError('ineligible', '这个任务当前不能开个头')
    const item = await io.currentItem(id)
    if (!item || item.task?.id !== id || !item.path) throw new KickoffClientError('task-changed', '任务已删除或身份已改变')
    if (!kickoffEligible(item)) throw new KickoffClientError('ineligible', '任务已经不在可开头的泳道')
    kickoffPathFor(item.path)
    if (!(await io.exists(item.path)).exists) throw new KickoffClientError('task-changed', '任务文件不存在')
    const content = (await io.read(item.path)).content
    let source
    try {
      source = parseTaskSource(item.path, content)
    } catch {
      throw new KickoffClientError('task-changed', '任务文件不再是合法 Task')
    }
    if (source.task.id !== id) throw new KickoffClientError('task-changed', '任务身份已改变')
    state.registry = await registry()
    if (state.registry.runs[id]?.state === 'running') throw new KickoffClientError('already-running', '这个任务已经在开头')
    await providers()
    if (state.unsupported) throw new KickoffClientError('unsupported', '宿主不支持 agent 列表，请更新 note.md')
    const provider = state.providers.find(p => p.id === input.providerId)
    if (!provider) throw new KickoffClientError('agent-missing', '没有可用的 agent 插件')
    if (provider.harness?.ok !== true) throw new KickoffClientError('provider-unavailable', provider.harness?.hint || '这个 agent 当前不可用')
    const limits = await io.agentLimits()
    const maximum = limits.providers.find(p => p.id === provider.id)?.max_concurrency ?? provider.max_concurrency ?? 1
    const running = Object.values(state.registry.runs).filter(run => run.state === 'running')
    if (running.filter(run => run.harness === provider.id).length >= maximum) throw new KickoffClientError('capacity', '选中的 agent 已达到并行上限')
    // Every provider shares this task's host lock, which is not a capacity queue.
    if (running.length) throw new KickoffClientError('capacity', '已有开头正在运行，请完成后再开始另一个任务')
    const root = (await io.vaultInfo()).root
    if (!root || !/^(?:\/|[a-z]:[\\/])/i.test(root)) throw new KickoffClientError('start-error', '无法获取 Vault 路径')
    const basedOn = await sha256(content)
    state.hashes[id] = basedOn
    return {
      taskId: id,
      taskPath: item.path,
      title: source.title,
      basedOn,
      lane: item.state === 'capture' ? 'inbox' : item.state as 'waiting' | 'dormant',
      providerId: provider.id,
      vaultRoot: root.replace(/[\\/]$/, ''),
    }
  }
  const startInternal = async (input: KickoffStartInput): Promise<KickoffSnapshot> => {
    const ready = await preflightInternal(input)
    if (await needsConsent(io)) {
      if (!input.consent) throw new KickoffClientError('consent-required', '需要确认添加开头规程与任务模板')
    }
    await seedFiles(io, { ...TEMPLATE_FILES, ...SKILL_FILES })
    state.needsConsent = false
    state.dataSources = parseDataSources((await io.read(SKILL_PATH)).content)
    const taskDefinition = (await io.read(`.notemd/agent-tasks/${TASK_ID}/task.json`)).content
    let definition: Record<string, unknown>
    try { definition = JSON.parse(taskDefinition) } catch {
      throw new KickoffClientError('start-error', 'Existing task.json is not valid JSON; it was preserved')
    }
    if (definition?.strict_readonly !== true
      || !Number.isInteger(definition.max_turns) || Number(definition.max_turns) < 1 || Number(definition.max_turns) > 40
      || !Number.isInteger(definition.timeout_seconds) || Number(definition.timeout_seconds) < 1 || Number(definition.timeout_seconds) > 600) {
      throw new KickoffClientError('start-error', 'Existing task.json must enable strict_readonly and limit max_turns to 40 and timeout_seconds to 600; it was preserved')
    }
    const requestedAt = now()
    let runId: string
    try {
      const result = await io.agentRun({
        task: TASK_ID,
        harness: ready.providerId,
        note_path: `${ready.vaultRoot}/${ready.taskPath}`,
        prompt: [
          'schema: next-kickoff/v1',
          `task_path: ${ready.taskPath}`,
          `task_id: ${ready.taskId}`,
          `based_on: ${ready.basedOn}`,
          `lane: ${ready.lane}`,
          `today: ${input.today ?? localDate()}`,
          `skill: ${SKILL_PATH}`,
        ].join('\n'),
        notify: {
          title_ok: `${options.notificationTitles?.ok ?? 'Kickoff ready'} · ${ready.title}`,
          title_fail: `${options.notificationTitles?.fail ?? 'Kickoff failed'} · ${ready.title}`,
        },
      })
      if (typeof result.run_id !== 'string' || !result.run_id.trim()) throw new Error('agent 未返回 run_id')
      runId = result.run_id
    } catch (error) {
      const detail = message(error)
      const kind = detail.includes('agent_unavailable') ? 'agent-missing'
        : /capacity|concurrency|busy/i.test(detail) ? 'capacity' : 'start-error'
      const failure = { kind, message: detail, at: now() }
      await updateRegistry(current => current.runs[ready.taskId]?.state === 'running' ? current : {
        ...current,
        runs: {
          ...current.runs,
          [ready.taskId]: {
            run_id: null,
            harness: ready.providerId,
            requested_at: requestedAt,
            task_path: ready.taskPath,
            based_on: ready.basedOn,
            state: 'failed',
            failure,
          },
        },
      })
      state.statuses[ready.taskId] = { state: 'failed', failure }
      throw new KickoffClientError(kind, detail)
    }
    pendingRuns[ready.taskId] = {
      run_id: runId,
      harness: ready.providerId,
      requested_at: requestedAt,
      task_path: ready.taskPath,
      based_on: ready.basedOn,
      state: 'running',
      failure: null,
    }
    state.registry = withPending(state.registry)
    state.statuses[ready.taskId] = { state: 'running', steps: 0, last: '' }
    await updateRegistry(current => current)
    return snapshot()
  }
  const reconcileInternal = async (): Promise<KickoffSnapshot> => {
    state.registry = await registry()
    await discover()
    for (const [id, run] of Object.entries(state.registry.runs)) {
      if (run.state !== 'running') continue
      let status: KickoffRunView
      try {
        status = interpretKickoffStatus(await io.agentStatus(TASK_ID, run.run_id, run.harness))
      } catch (error) {
        status = { state: 'failed', failure: { kind: 'lost', message: message(error), at: now() } }
      }
      state.statuses[id] = status
      if (status.state === 'running') {
        if (Object.keys(pendingRuns).length) await updateRegistry(current => current)
        continue
      }
      const fail = async (kind: string, detail: string, rawSnippet?: string): Promise<void> => {
        await updateRegistry(current => current.runs[id]?.run_id === run.run_id
          ? markFailed(current, id, {
            kind,
            message: Array.from(detail).slice(0, 300).join(''),
            at: now(),
            warning: status.state === 'failed' ? status.failure.warning : status.warning,
            rawSnippet,
          })
          : current)
      }
      if (status.state === 'failed') {
        await fail(status.failure.kind, status.failure.message, status.failure.rawSnippet)
        continue
      }
      let source
      const currentItem = await io.currentItem(id)
      if (!currentItem?.path || currentItem.task?.id !== id || currentItem.kind !== 'task') {
        await fail('task-changed', '任务在运行期间被删除或换了身份')
        continue
      }
      const currentPath = currentItem.path
      try { kickoffPathFor(currentPath) } catch {
        await fail('task-changed', '任务路径不再安全')
        continue
      }
      if (!(await io.exists(currentPath)).exists) {
        await fail('task-changed', '任务在运行期间被删除或换了身份')
        continue
      }
      const currentTask = (await io.read(currentPath)).content
      try {
        source = parseTaskSource(currentPath, currentTask)
      } catch {
        await fail('task-changed', '任务不再是合法 Task')
        continue
      }
      if (source.task.id !== id) {
        await fail('task-changed', '任务身份已改变')
        continue
      }
      let old = state.results[id]
      if (old) {
        const current = parseKickoffDocument((await io.read(old.path)).content)
        if (!current || current.kickoff.task_id !== id) throw new KickoffClientError('conflict', '结果文件身份已改变')
        old = { path: old.path, doc: current }
      }
      // A previous result write may have succeeded before a registry IO failure.
      if (old?.doc.kickoff.run_id !== run.run_id) {
        let sourceIoError: unknown
        const parsed = await parsePayload(status.content, { taskId: id, basedOn: run.based_on }, async path => {
          try {
            return (await io.exists(path)).exists
          } catch (error) {
            sourceIoError = error
            throw error
          }
        })
        if (sourceIoError) throw sourceIoError
        if (!parsed.ok) {
          const snippet = new TextDecoder().decode(new TextEncoder().encode(status.content).slice(0, 2048), { stream: true })
          await fail('invalid-output', parsed.error, snippet)
          continue
        }
        const path = old?.path ?? kickoffPathFor(currentPath)
        // The fixed conventional path can belong to a malformed or other Task document.
        if (!old && (await io.exists(path)).exists) throw new KickoffClientError('conflict', `结果路径已存在，未覆盖：${path}`)
        const reportedStart = Date.parse(status.started_at ?? '')
        const start = Number.isFinite(reportedStart) ? reportedStart : Date.parse(run.requested_at)
        const end = Date.parse(status.ended_at ?? now())
        const content = await buildKickoffDocument({
          payload: parsed.payload,
          taskPath: currentPath,
          taskTitle: source.title,
          runId: run.run_id,
          endedAt: status.ended_at ?? now(),
          durationSeconds: Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, (end - start) / 1000) : 0,
          harness: status.harness,
          model: status.model,
          providerId: run.harness,
          repairs: parsed.repairs,
          priorAnswers: carryPriorAnswers(old?.doc ?? null, old?.doc.kickoff.run_id ?? ''),
        })
        if (old) {
          if ((await io.read(path)).content !== old.doc.raw) throw new KickoffClientError('conflict', '结果文件在生成期间已改变，请重试对账')
        } else if ((await io.exists(path)).exists) {
          throw new KickoffClientError('conflict', `结果路径已存在，未覆盖：${path}`)
        }
        await writeVerified(path, content)
        const doc = parseKickoffDocument(content)
        if (!doc) throw new KickoffClientError('io-error', '结果文件无法回读解析')
        state.results[id] = { path, doc }
      }
      await updateRegistry(current => current.runs[id]?.run_id === run.run_id ? markUnread(clearRun(current, id), id) : current)
    }
    return snapshot()
  }
  const saveInternal = async (input: SaveAnswersInput): Promise<{ snapshot: KickoffSnapshot; result: KickoffResult; rerendered: boolean }> => {
    await discover()
    const previous = state.results[input.taskId]
    if (!previous) throw new KickoffClientError('conflict', '开头结果不存在')
    const raw = (await io.read(previous.path)).content
    const doc = parseKickoffDocument(raw)
    if (!doc || doc.kickoff.task_id !== input.taskId || doc.kickoff.run_id !== input.runId) throw new KickoffClientError('conflict', '开头已经更新，请重新打开后保存')
    // Task0 found no authoritative USER.md owner field; never use a device author or caller actor.
    const answers = input.answers.map(answer => ({ ...answer, by: 'human:owner' }))
    const updated = await withAnswers(doc, answers, now())
    if ((await io.read(previous.path)).content !== raw) throw new KickoffClientError('conflict', '开头结果在保存期间已改变，请重新打开后保存')
    await writeVerified(previous.path, updated.content)
    const saved = parseKickoffDocument((await io.read(previous.path)).content)
    if (!saved || saved.kickoff.task_id !== input.taskId || saved.kickoff.run_id !== input.runId) throw new KickoffClientError('io-error', '答案回读校验失败')
    const result = { path: previous.path, doc: saved }
    state.results[input.taskId] = result
    return { snapshot: snapshot(), result, rerendered: updated.rerendered }
  }
  return {
    snapshot,
    load: (items?: WorkspaceItem[]) => serial(() => loadInternal(items)),
    preflight: (input: KickoffStartInput) => serial(() => preflightInternal(input)),
    startKickoff: (input: KickoffStartInput) => serial(() => startInternal(input)),
    reconcile: () => serial(reconcileInternal),
    saveAnswers: (input: SaveAnswersInput) => serial(() => saveInternal(input)),
    markRead: (taskId: string) => serial(async () => {
      await updateRegistry(current => readRegistry(current, taskId))
      return snapshot()
    }),
  }
}
