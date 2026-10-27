export const REGISTRY_PATH = '.notemd/next-kickoff.json'

export interface KickoffFailure {
  kind: string
  message: string
  at: string
  warning?: string
  rawSnippet?: string
}

interface KickoffRunBase {
  harness: string
  requested_at: string
  task_path: string
  based_on: string
}

export type KickoffRun = KickoffRunBase & ({
  state: 'running'
  run_id: string
  failure: null
} | {
  state: 'failed'
  /** null means the host never returned a run id for this real start attempt. */
  run_id: string | null
  failure: KickoffFailure
})

export interface Registry {
  version: 1
  runs: Record<string, KickoffRun>
  unread: string[]
}
const empty = (): Registry => ({
  version: 1,
  runs: {},
  unread: []
})
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim()

export function parseRegistry(raw: string | null): Registry {
  try {
    const r: unknown = JSON.parse(raw ?? 'null')
    if(!object(r) || r.version !== 1 || !object(r.runs) || !Array.isArray(r.unread) || !r.unread.every(text))
      return empty()
    for(const run of Object.values(r.runs)) {
      if(!object(run) || !['harness', 'requested_at', 'task_path', 'based_on'].every(k => text(run[k])) || !['running', 'failed'].includes(String(run.state)))
        return empty()
      if (run.state === 'running' ? !text(run.run_id) : run.run_id !== null && !text(run.run_id)) return empty()
      const f = run.failure
      if(run.state === 'running' ? f !== null : !object(f) || !['kind', 'message', 'at'].every(k => typeof f[k] === 'string') || !['warning', 'rawSnippet'].every(k => f[k] === undefined || typeof f[k] === 'string'))
        return empty()
    }
    return {
      version: 1,
      runs: r.runs as unknown as Registry['runs'],
      unread: [...new Set(r.unread)]
    }
  } catch {
    return empty()
  }
}

export function serializeRegistry(r: Registry): string {
  return JSON.stringify(r, null, 2) + '\n'
}

export function markRunning(r: Registry, id: string, run: Extract<KickoffRun, { state: 'running' }>): Registry {
  return {
    ...r,
    runs: {
      ...r.runs,
      [id]: {
        ...run,
        state: 'running',
        failure: null
      }
    }
  }
}

export function markFailed(r: Registry, id: string, failure: KickoffFailure): Registry {
  const runs = { ...r.runs }
  if(runs[id]) {
    runs[id] = {
      ...runs[id],
      state: 'failed',
      failure: { ...failure },
    }
  }
  return {
    ...r,
    runs
  }
}

export function clearRun(r: Registry, id: string): Registry {
  const runs = {
    ...r.runs
  }
  delete runs[id]
  return {
    ...r,
    runs
  }
}

export function markUnread(r: Registry, id: string): Registry {
  return {
    ...r,
    unread: [...new Set([...r.unread, id])]
  }
}

export function markRead(r: Registry, id: string): Registry {
  return {
    ...r,
    unread: r.unread.filter(v => v !== id)
  }
}
