import { buildIndexes } from './indexes'
import { parseStrictJson } from './strict-json'
import { effectiveStatus, recordLabel } from './types'
import { isSupportedDataset, validateKnowledgeDataset } from './validator'
import type { KnowledgeDataset, KnowledgeKind, KnowledgeRecord, ParseResult, ViewRecord } from './types'

const COLLECTIONS: KnowledgeKind[] = ['entities', 'concepts', 'claims', 'events', 'narratives', 'relations']

async function sha256(source: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(source))
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('')
}

export async function parseKnowledgeDataset(sourceText: string, uri: string): Promise<ParseResult> {
  const snapshotHash = await sha256(sourceText)
  const strict = parseStrictJson(sourceText)
  if (strict.value === undefined || strict.diagnostics.length) return {
    status: 'invalid', uri, sourceText, snapshotHash, records: [], raw: strict.value,
    diagnostics: strict.diagnostics, fatal: true, unsupported: false,
  }
  const validation = validateKnowledgeDataset(strict.value)
  const raw = strict.value as Record<string, unknown>
  const generated = raw && typeof raw === 'object' && raw.generated && typeof raw.generated === 'object' ? raw.generated as Record<string, unknown> : undefined
  const unsupported = typeof raw?.schema === 'string' && (!isSupportedDataset(strict.value) || generated?.rule !== 'relation-schema-extractor/3.0.0' || generated?.types !== '1.0.0')
  if (unsupported) return {
    status: 'unsupported', uri, sourceText, snapshotHash, records: [], raw: strict.value,
    diagnostics: validation.diagnostics, fatal: true, unsupported: true,
  }
  const dataset = strict.value as KnowledgeDataset
  if (validation.fatal) return {
    status: 'invalid', uri, sourceText, snapshotHash, records: [], raw: strict.value, dataset,
    diagnostics: validation.diagnostics, fatal: true, unsupported: false,
  }
  const indexes = buildIndexes(dataset, validation.isolatedIds)
  const records: ViewRecord[] = []
  let originalOrder = 0
  for (const kind of COLLECTIONS) for (let index = 0; index < dataset[kind].length; index++) {
    const raw = dataset[kind][index] as KnowledgeRecord
    if (!validation.isolatedIds.has(raw.id)) records.push({ id: raw.id, kind, label: recordLabel(raw), pointer: `/${kind}/${index}`, raw, effectiveStatus: effectiveStatus(raw), originalOrder })
    originalOrder++
  }
  return {
    status: validation.valid ? 'ready' : 'partial', uri, sourceText, snapshotHash, records, raw: strict.value,
    dataset, indexes, diagnostics: validation.diagnostics, fatal: false, unsupported: false,
  }
}
