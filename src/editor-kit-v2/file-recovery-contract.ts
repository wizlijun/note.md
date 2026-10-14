import type { RootIdRow } from '@moraya/core/source-history'

export type FileRecovery = Readonly<{ v: 1; sourceHash: string; sourceRevision: number; bindings: readonly RootIdRow[] }>
