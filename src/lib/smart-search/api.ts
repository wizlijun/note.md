import { invoke } from '@tauri-apps/api/core'
import type { SmartSearchResponse } from '../search/api'

export interface LocalLookupResponse {
  search: SmartSearchResponse
  /** Host-retained run that later actions are started from. */
  lookupRunId: string
}

export const smartSearchApi = {
  /** Enter: local results plus a retained lookup run; never starts a model. */
  localLookup: (
    question: string,
    options: { limit?: number; deep?: boolean; timeoutMs?: number } = {},
  ) => invoke<LocalLookupResponse>('smart_lookup_local', {
    question,
    limit: options.limit,
    deep: options.deep,
    timeoutMs: options.timeoutMs,
  }),
}
