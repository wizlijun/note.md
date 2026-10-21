import type { DraftV2, ProjectAnnotationV2, ShareSnapshotInput } from '../lib/project-share/types'
export type RebaseUiResult = { status: 'applied'; draft: DraftV2 } | { status: 'cancelled' }
export type ShareMermaidAppearance = {
  theme: 'default' | 'dark'
  themeVariables: { primaryColor: string; primaryTextColor: string; primaryBorderColor: string; lineColor: string; secondaryColor: string; tertiaryColor: string; background?: string }
}
export interface ShareEditorHost {
  apiVersion: 1
  snapshot: ShareSnapshotInput
  theme: { themeId: string; cssVars?: Record<string, string> }
  loadDraft(): Promise<DraftV2 | null>
  saveDraft(live: DraftV2): Promise<Readonly<DraftV2>>
  /** Explicit aggregate CAS, in the same durable FIFO as ordinary saves. */
  loadAnnotations?(): Promise<readonly ProjectAnnotationV2[]>
  transitionDraft?(expected: DraftV2, next: DraftV2, notes?: { expectedAnnotations: readonly ProjectAnnotationV2[]; annotations: readonly ProjectAnnotationV2[] }): Promise<Readonly<DraftV2>>
  submit(body: string, submissionId: string): Promise<{ ok: true } | { ok: false; status: number; message: string }>
  openFile(path: string): void
  notify(text: string): void
  setFileBadges?(rows: readonly { path: string; changed: boolean; annotations: number }[]): void
  loadMermaid?(): Promise<{ supportsResponsiveLayout?: boolean; render(code: string, appearance: ShareMermaidAppearance, options?: { maxWidth?: number }): Promise<string> }>
}
export interface ShareEditorHandle {
  switchFile(path: string): Promise<void>
  buildSubmission(input: { message?: string; name?: string; aiAssisted?: boolean }): Promise<{ body: string; submissionId: string; summary: { files: number; blocks: number; annotations: number } }>
  rebase(newSnapshot: ShareEditorHost['snapshot'], draft: DraftV2): Promise<RebaseUiResult>
  destroy(): Promise<void>
}
export type ShareEditorHandleE1 = Omit<ShareEditorHandle, 'rebase'>
export interface ShareEditorModule {
  apiVersion: 1
  mount(container: HTMLElement, host: ShareEditorHost, opts: { path: string }): Promise<ShareEditorHandle>
}
