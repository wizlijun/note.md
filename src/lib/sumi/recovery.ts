import { invoke } from '@tauri-apps/api/core'
import { SUMI_PLUGIN_ID } from './session'

export interface RecoveryEvidence {
  vault: string
  path: string
  markdown_sha256: string
  metadata_path: string
  metadata_sha256: string | null
}
export interface RecoveryProbe {
  evidence: RecoveryEvidence
  status: 'matching_pair' | 'markdown_only' | 'damaged_metadata'
  source_page_id?: string | null
  known_page: boolean
  preserve_line_times: boolean
  normalize_crlf: boolean
  warnings: string[]
}
export interface RecoveredPage {
  page_id: string
  path: string | null
  preserved_line_times: boolean
}
export function probeRecovery(path: string, pluginId = SUMI_PLUGIN_ID): Promise<RecoveryProbe> {
  return invoke('sumi_recovery_probe', { plugin_id: pluginId, path })
}
export function recoverNewPage(probe: RecoveryProbe, requestId: string, normalizeCrlf: boolean, pluginId = SUMI_PLUGIN_ID): Promise<RecoveredPage> {
  return invoke('sumi_recover_new', {
    plugin_id: pluginId, request_id: requestId, evidence: probe.evidence, normalize_crlf: normalizeCrlf,
  })
}
