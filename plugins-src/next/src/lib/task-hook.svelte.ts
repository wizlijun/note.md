import { bridge } from './bridge'

export interface TaskHookConfig {
  available: boolean
  configured: boolean
  scriptPath?: string
  environmentSupported?: boolean
  environmentKeys?: string[]
}

export interface TaskHookJob {
  taskId: string
  title: string
  status: 'running' | 'synced' | 'pending'
  counts?: { created: number; updated: number; deleted: number }
  errorCode?: string
}

export const taskHook = $state({
  config: { available: false, configured: false } as TaskHookConfig,
  jobs: {} as Record<string, TaskHookJob>,
})

function configuration(value: unknown): TaskHookConfig {
  if (!value || typeof value !== 'object' || typeof (value as any).configured !== 'boolean') {
    throw new Error('Invalid task hook configuration')
  }
  const result = value as { configured: boolean; scriptPath?: string; environmentSupported?: boolean; environmentKeys?: unknown }
  return {
    available: true, configured: result.configured,
    ...(result.scriptPath ? { scriptPath: result.scriptPath } : {}),
    environmentSupported: result.environmentSupported === true,
    environmentKeys: Array.isArray(result.environmentKeys)
      ? result.environmentKeys.filter((key): key is string => key === 'DESK_DISPLAY_URL' || key === 'DESK_DISPLAY_TOKEN')
      : [],
  }
}

// A settings mutation invalidates reads started both before and during it.
let configurationEpoch = 0

export async function loadTaskHook(): Promise<TaskHookConfig> {
  const epoch = configurationEpoch
  try {
    const loaded = configuration(await bridge().request('host.taskHook.get', {}))
    if (epoch === configurationEpoch) taskHook.config = loaded
    return loaded
  } catch {
    if (epoch === configurationEpoch) taskHook.config = { available: false, configured: false }
    return taskHook.config
  }
}

async function changeConfiguration(method: string, params: Record<string, string>): Promise<void> {
  configurationEpoch++
  try { taskHook.config = configuration(await bridge().request(method, params)) }
  finally { configurationEpoch++ }
}

export async function selectTaskHook(): Promise<void> {
  await changeConfiguration('host.taskHook.select', {})
}

export async function clearTaskHook(): Promise<void> {
  await changeConfiguration('host.taskHook.clear', {})
}

export async function setTaskHookEnvironment(text: string): Promise<void> {
  await changeConfiguration('host.taskHook.setEnvironment', { text })
}

const pending = new Map<string, Promise<void>>()

/** Runs after a verified save. Failures must never reject the Task mutation. */
export function syncTaskHook(taskId: string, title: string): Promise<void> {
  const previous = pending.get(taskId) ?? Promise.resolve()
  const job = previous.then(async () => {
    const config = await loadTaskHook()
    if (!config.configured) return
    taskHook.jobs[taskId] = { taskId, title, status: 'running' }
    try {
      const result = await bridge().request('host.taskHook.run', { taskId })
      if (result?.ok === true && result.status === 'disabled') {
        delete taskHook.jobs[taskId]
        return
      }
      const synced = result?.ok === true && result.status === 'synced'
      const counts = synced && [result.created, result.updated, result.deleted]
        .every((count) => Number.isSafeInteger(count) && count >= 0)
        ? { created: result.created, updated: result.updated, deleted: result.deleted }
        : undefined
      taskHook.jobs[taskId] = {
        taskId, title, status: synced ? 'synced' : 'pending',
        ...(counts ? { counts } : {}),
        ...(!synced ? { errorCode: typeof result?.errorCode === 'string' ? result.errorCode : 'script_failed' } : {}),
      }
    } catch {
      taskHook.jobs[taskId] = { taskId, title, status: 'pending', errorCode: 'host_unavailable' }
    }
  })
  pending.set(taskId, job)
  void job.finally(() => { if (pending.get(taskId) === job) pending.delete(taskId) })
  return job
}

export function dismissTaskHook(taskId: string): void {
  if (taskHook.jobs[taskId]?.status !== 'running') delete taskHook.jobs[taskId]
}
