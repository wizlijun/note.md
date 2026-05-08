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
  const { hash } = event.snapshot
  // Hash equality usually means "disk content matches what we last accepted"
  // → ignore (covers self-write echoes and external touch with no content
  // change). Exception: when the tab is currently `deleted`, a modify event
  // means the file was recreated and we MUST transition state, even if the
  // recreated content happens to equal the pre-deletion content.
  if (hash === tab.lastKnownHash && tab.externalState !== 'deleted') {
    return { kind: 'ignore' }
  }
  const dirty = tab.currentContent !== tab.initialContent
  return dirty
    ? { kind: 'showChanged', snapshot: event.snapshot }
    : { kind: 'autoReload', snapshot: event.snapshot }
}
