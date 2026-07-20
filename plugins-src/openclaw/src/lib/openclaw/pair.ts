// src/lib/openclaw/pair.ts — v2 bridge port of the pairing/device commands.
//
// v1 `invoke('openclaw_pair_*', {deviceId,…})` → `request('pair_*', {device_id,…})`
// (backend params are snake_case). The `openclaw://pending-claim` listen is
// gone: PendingClaimToast subscribes through commands.ts `onPendingClaimMsg`,
// fed by the single onMessage dispatcher.

import { request } from '../bridge'
import { onPendingClaimMsg } from './commands'

export interface PairCreateOut { code: string; pairing_id: string; expires_at: number; qr_svg: string }
export interface PairClaimOut { pairing_id: string; device_id: string }
export interface PendingClaim { device_id: string; hostname: string; at: number }

export const pairCreate = (): Promise<PairCreateOut> => request('pair_create')
export const pairClaim  = (code: string, hostname?: string): Promise<PairClaimOut> =>
  request('pair_claim', { code, hostname })
export const revokeDevice = (deviceId: string): Promise<void> => request('revoke_device', { device_id: deviceId })
export const forgetDevice = (deviceId: string): Promise<void> => request('forget_device', { device_id: deviceId })
export const approveClaim = (deviceId: string, hostname: string): Promise<void> =>
  request('approve_pending', { device_id: deviceId, hostname })
export const rejectClaim  = (deviceId: string): Promise<void> => request('reject_pending', { device_id: deviceId })

/** Subscribe to pending-claim pushes. Returns an unsubscribe fn (v1 parity). */
export const onPendingClaim = (cb: (c: PendingClaim) => void): (() => void) =>
  onPendingClaimMsg((data) => cb(data as PendingClaim))
