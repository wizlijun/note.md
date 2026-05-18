// src/lib/openclaw/devices.svelte.ts
import { invoke } from '@tauri-apps/api/core'

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
    devicesState.list = await invoke<Device[]>('openclaw_list_devices')
  } finally {
    devicesState.loading = false
  }
}
