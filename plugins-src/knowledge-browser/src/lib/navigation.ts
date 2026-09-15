export interface KnowledgeLocation {
  datasetId: string
  ref: string
  evidence?: string
}

export interface NavigationState {
  datasetId: string
  current?: KnowledgeLocation
  back: KnowledgeLocation[]
}

export interface KnowledgeReference {
  format: 'knowledge-ref/1'
  path: string
  dataset: string
  ref: string
  snapshot?: string
  evidence?: string
}

export type ReferenceAssessment =
  | { status: 'ready'; reference: KnowledgeReference }
  | { status: 'dataset-mismatch'; reference: KnowledgeReference }
  | { status: 'snapshot-changed'; reference: KnowledgeReference }
  | { status: 'missing-ref'; reference: KnowledgeReference }

const MAX_HISTORY = 100
const LOCAL_ID = /^[ecqvnr][1-9]\d*$/
const EVIDENCE_ID = /^x[1-9]\d*$/
const DATASET_ID = /^ks_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function validPath(path: unknown): path is string {
  return typeof path === 'string' && path.length > 0 && path.length <= 16_384
    && !path.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(path)
    && !/[\u0000-\u001f\u007f]/.test(path)
    && !path.replace(/\\/g, '/').split('/').some(part => !part || part === '.' || part === '..')
}

function sameLocation(a: KnowledgeLocation | undefined, b: KnowledgeLocation): boolean {
  return !!a && a.datasetId === b.datasetId && a.ref === b.ref && a.evidence === b.evidence
}

export function createNavigation(datasetId: string, ref?: string): NavigationState {
  return { datasetId, current: ref ? { datasetId, ref } : undefined, back: [] }
}

/** Navigate without recursively rendering reference chains; cycles stay finite. */
export function navigateTo(state: NavigationState, location: KnowledgeLocation): NavigationState {
  if (location.datasetId !== state.datasetId) return { datasetId: location.datasetId, current: { ...location }, back: [] }
  if (sameLocation(state.current, location)) return state
  return {
    datasetId: state.datasetId,
    current: { ...location },
    back: state.current ? [...state.back, state.current].slice(-MAX_HISTORY) : state.back,
  }
}

export function navigateBack(state: NavigationState): NavigationState {
  const current = state.back.at(-1)
  if (!current) return state
  return { datasetId: state.datasetId, current, back: state.back.slice(0, -1) }
}

/** At most three visible ancestors; callers may put the rest in a history menu. */
export function visibleBreadcrumbs(state: NavigationState): { visible: KnowledgeLocation[]; hidden: KnowledgeLocation[] } {
  const trail = state.current ? [...state.back, state.current] : [...state.back]
  return { visible: trail.slice(-3), hidden: trail.slice(0, -3) }
}

export function keepSelectionForSnapshot(
  state: NavigationState,
  datasetId: string,
  availableIds: ReadonlySet<string>,
): { state: NavigationState; missingPrevious: boolean } {
  if (state.datasetId !== datasetId) return { state: createNavigation(datasetId), missingPrevious: false }
  if (!state.current || availableIds.has(state.current.ref)) return { state, missingPrevious: false }
  return { state: createNavigation(datasetId), missingPrevious: true }
}

export function serializeKnowledgeReference(reference: Omit<KnowledgeReference, 'format'>): string {
  const normalized = validateReference({ format: 'knowledge-ref/1', ...reference })
  if (!normalized) throw new Error('Invalid knowledge reference')
  return JSON.stringify(normalized)
}

function validateReference(value: unknown): KnowledgeReference | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const keys = Object.keys(raw)
  if (keys.some(key => !['format', 'path', 'dataset', 'ref', 'snapshot', 'evidence'].includes(key))
    || raw.format !== 'knowledge-ref/1' || !validPath(raw.path)
    || typeof raw.dataset !== 'string' || !DATASET_ID.test(raw.dataset)
    || typeof raw.ref !== 'string' || !LOCAL_ID.test(raw.ref)
    || (raw.snapshot !== undefined && (typeof raw.snapshot !== 'string' || !/^[a-f0-9]{64}$/i.test(raw.snapshot)))
    || (raw.evidence !== undefined && (typeof raw.evidence !== 'string' || !EVIDENCE_ID.test(raw.evidence)))) return null
  return {
    format: 'knowledge-ref/1',
    path: raw.path.replace(/\\/g, '/'),
    dataset: raw.dataset,
    ref: raw.ref,
    ...(raw.snapshot === undefined ? {} : { snapshot: raw.snapshot }),
    ...(raw.evidence === undefined ? {} : { evidence: raw.evidence }),
  } as KnowledgeReference
}

export function parseKnowledgeReference(text: string): KnowledgeReference | null {
  if (text.length > 32_768) return null
  try { return validateReference(JSON.parse(text)) }
  catch { return null }
}

export function assessKnowledgeReference(
  reference: KnowledgeReference,
  context: { datasetId: string; snapshotHash?: string; availableIds: ReadonlySet<string> },
): ReferenceAssessment {
  if (reference.dataset !== context.datasetId) return { status: 'dataset-mismatch', reference }
  if (reference.snapshot && reference.snapshot !== context.snapshotHash) return { status: 'snapshot-changed', reference }
  if (!context.availableIds.has(reference.ref)) return { status: 'missing-ref', reference }
  return { status: 'ready', reference }
}
