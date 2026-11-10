import { invoke } from '@tauri-apps/api/core'
import type { SmartSearchResponse } from '../search/api'
import type { SummaryTaskStart } from './summary'
import type { SummaryStyle } from './settings'
import type { ModelSelector } from './model-routing'
import type { HandoffPacket } from './handoff'
import type { AgentTaskStart } from './agent'

export interface LocalLookupResponse {
  search: SmartSearchResponse
  /** Host-retained run that summary and handoff are started from. */
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
  startSummary: (
    lookupRunId: string,
    selectedResultIds: string[],
    sourceLimit: number,
    charLimit: number,
    style: SummaryStyle,
    provider: string,
    modelSelector: ModelSelector,
    invocationId: string,
  ) => invoke<SummaryTaskStart>('smart_lookup_start_summary', {
    lookupRunId,
    selectedResultIds,
    sourceLimit,
    charLimit,
    style,
    provider,
    invocationId,
    ...modelSelector,
  }),
  startHandoff: (
    packet: HandoffPacket,
    provider: string,
    invocationId: string,
  ) => invoke<AgentTaskStart>('smart_lookup_start_handoff', {
    question: packet.question,
    resolvedFilters: packet.resolvedFilters,
    queryTerms: packet.queryTerms,
    selectedRefs: packet.selectedRefs,
    provider,
    invocationId,
  }),
}
