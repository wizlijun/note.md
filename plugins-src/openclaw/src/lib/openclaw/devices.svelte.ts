// src/lib/openclaw/devices.svelte.ts — v2 bridge port of the device store.
import { request } from '../bridge'

export interface Device {
  device_id: string
  hostname: string
  status: 'active' | 'revoked'
  last_seen: number | null
}

export const devicesState = $state({
  list: [] as Device[],
  loading: false,
})

export async function refresh(): Promise<void> {
  devicesState.loading = true
  try {
    devicesState.list = (await request('list_devices')) as Device[]
  } finally {
    devicesState.loading = false
  }
}
