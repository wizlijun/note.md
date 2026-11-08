/** Runtime-only resource state. Never persisted with user effect preferences. */
export interface PowerModeAssets {
  status: 'ready' | 'missing' | 'disabled'
  base: string | null
}
const OFF: PowerModeAssets = { status: 'disabled', base: null }
let current: PowerModeAssets = OFF
let generation = 0

export function normalizeAssets(raw: unknown): PowerModeAssets {
  if (!raw || typeof raw !== 'object') return { status: 'missing', base: null }
  const value = raw as Partial<PowerModeAssets>
  if (value.status === 'disabled') return OFF
  if (value.status === 'ready' && (value.base === '/__power_mode__/'
    || value.base === 'plugin://notemd.power-mode/__power_mode__/')) {
    return { status: 'ready', base: value.base }
  }
  return { status: 'missing', base: null }
}

export function assetsStatus(): PowerModeAssets['status'] { return current.status }
export function assetBase(): string | null { return current.base }

/** Late responses after disable/update cannot restore an older resource set. */
export async function refreshAssets(load: () => Promise<unknown>): Promise<PowerModeAssets> {
  const request = ++generation
  try {
    const next = normalizeAssets(await load())
    if (request === generation) current = next
  } catch {
    if (request === generation) current = OFF
  }
  return current
}
