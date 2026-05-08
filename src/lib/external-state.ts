/**
 * Pure decision function for external file-change detection.
 *
 * Given the tab's current state and a fresh disk event, returns what the
 * caller should do. Side-effect-free; trivially testable. Lives outside
 * the Svelte runes so we can unit-test without a DOM.
 */

export interface DiskSnapshot {
  /** Last-modification time, ms since epoch. */
  mtime: number
  /** sha256 hex of the disk content. */
  hash: string
  /** The freshly-read content (UTF-8). */
  content: string
}

export type ExternalEvent =
  | { type: 'modified'; snapshot: DiskSnapshot }
  | { type: 'deleted' }

export interface TabSnapshot {
  initialContent: string
  currentContent: string
  lastKnownMtime: number
  lastKnownHash: string
  externalState: 'fresh' | 'changed' | 'deleted'
}

export type Decision =
  | { kind: 'ignore' }
  | { kind: 'autoReload'; snapshot: DiskSnapshot }
  | { kind: 'showChanged'; snapshot: DiskSnapshot }
  | { kind: 'showDeleted' }

export function decide(tab: TabSnapshot, event: ExternalEvent): Decision {
  if (event.type === 'deleted') {
    return tab.externalState === 'deleted' ? { kind: 'ignore' } : { kind: 'showDeleted' }
  }
  // event.type === 'modified'
  const { mtime, hash } = event.snapshot
  // Hash equality alone is enough to ignore: identical content means there's
  // nothing the user could possibly want to know about (covers both "we just
  // saved and it echoed" and "external touch with no content change").
  if (hash === tab.lastKnownHash) return { kind: 'ignore' }
  // mtime equality with hash mismatch is impossible if our recordOurWrite is
  // correct, but treat it as a real change anyway — the hash is authoritative.
  void mtime
  const dirty = tab.currentContent !== tab.initialContent
  return dirty
    ? { kind: 'showChanged', snapshot: event.snapshot }
    : { kind: 'autoReload', snapshot: event.snapshot }
}
