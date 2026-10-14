import type { FileRecovery, FileSnapshot } from './file-contract'

export type SavedFile = Readonly<{ generation: number; hash: string }>

export function recoveryFromSnapshot(snapshot: FileSnapshot): FileRecovery {
  return Object.freeze({ v: 1, sourceHash: snapshot.sourceHash, sourceRevision: snapshot.sourceRevision,
    bindings: Object.freeze(snapshot.bindings.map(row => Object.freeze({ ...row }))) })
}

/** Caller establishes the same baseline identity and exact durable bytes first. */
export function acknowledgeSaved(previous: SavedFile | undefined, snapshot: FileSnapshot): SavedFile {
  return previous && previous.generation >= snapshot.generation ? previous
    : Object.freeze({ generation: snapshot.generation, hash: snapshot.sourceHash })
}
