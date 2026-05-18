// src/lib/openclaw/pair.ts
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

export interface PairCreateOut { code: string; pairing_id: string; expires_at: number; qr_svg: string }
export interface PairClaimOut { pairing_id: string; device_id: string }
export interface PendingClaim { device_id: string; hostname: string; at: number }

export const pairCreate = (): Promise<PairCreateOut> => invoke('openclaw_pair_create')
export const pairClaim  = (code: string, hostname?: string): Promise<PairClaimOut> => invoke('openclaw_pair_claim', { code, hostname })
export const revokeDevice = (deviceId: string): Promise<void> => invoke('openclaw_revoke_device', { deviceId })
export const forgetDevice = (deviceId: string): Promise<void> => invoke('openclaw_forget_device', { deviceId })
export const approveClaim = (deviceId: string, hostname: string): Promise<void> => invoke('openclaw_approve_pending', { deviceId, hostname })
export const rejectClaim  = (deviceId: string): Promise<void> => invoke('openclaw_reject_pending', { deviceId })

export const onPendingClaim = (cb: (c: PendingClaim) => void): Promise<UnlistenFn> =>
  listen<PendingClaim>('openclaw://pending-claim', (e) => cb(e.payload))
