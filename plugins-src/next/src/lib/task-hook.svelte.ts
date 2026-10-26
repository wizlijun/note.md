import { bridge } from './bridge'

export interface TaskHookConfig {
  available: boolean
  configured: boolean
  scriptPath?: string
}

export interface TaskHookJob {
  taskId: string
  title: string
  status: 'running' | 'synced' | 'pending'
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
  const result = value as { configured: boolean; scriptPath?: string }
  return { available: true, configured: result.configured, ...(result.scriptPath ? { scriptPath: result.scriptPath } : {}) }
}

export async function loadTaskHook(): Promise<void> {
  try {
    taskHook.config = configuration(await bridge().request('host.taskHook.get', {}))
  } catch {
    taskHook.config = { available: false, configured: false }
  }
}

export async function selectTaskHook(): Promise<void> {
  taskHook.config = configuration(await bridge().request('host.taskHook.select', {}))
}

export async function clearTaskHook(): Promise<void> {
  taskHook.config = configuration(await bridge().request('host.taskHook.clear', {}))
}

const pending = new Map<string, Promise<void>>()

/** Runs after a verified save. Failures must never reject the Task mutation. */
export function syncTaskHook(taskId: string, title: string): Promise<void> {
  const previous = pending.get(taskId) ?? Promise.resolve()
  const job = previous.then(async () => {
    await loadTaskHook()
    if (!taskHook.config.configured) return
    taskHook.jobs[taskId] = { taskId, title, status: 'running' }
    try {
      const result = await bridge().request('host.taskHook.run', { taskId })
      if (result?.ok === true && result.status === 'disabled') {
        delete taskHook.jobs[taskId]
        return
      }
      const synced = result?.ok === true && result.status === 'synced'
      taskHook.jobs[taskId] = {
        taskId, title, status: synced ? 'synced' : 'pending',
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
