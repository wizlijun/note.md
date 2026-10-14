import type { DraftV2 } from '../lib/project-share/types'
export type RebaseUiResult = { status: 'applied'; draft: DraftV2 } | { status: 'cancelled' }
export type ShareMermaidAppearance = {
  theme: 'default' | 'dark'
  themeVariables: { primaryColor: string; primaryTextColor: string; primaryBorderColor: string; lineColor: string; secondaryColor: string; tertiaryColor: string }
}
export interface ShareEditorHost {
  apiVersion: 1
  snapshot: { project_id: string; snapshotId: string; entry: string; files: { path: string; hash: string; markdown?: string; dataUrl?: string }[] }
  theme: { themeId: string; cssVars?: Record<string, string> }
  loadDraft(): Promise<DraftV2 | null>
  saveDraft(live: DraftV2): Promise<Readonly<DraftV2>>
  submit(body: string, submissionId: string): Promise<{ ok: true } | { ok: false; status: number; message: string }>
  openFile(path: string): void
  notify(text: string): void
  setFileBadges?(rows: readonly { path: string; changed: boolean; annotations: number }[]): void
  loadMermaid?(): Promise<{ render(code: string, appearance: ShareMermaidAppearance): Promise<string> }>
}
export interface ShareEditorHandle {
  switchFile(path: string): Promise<void>
  buildSubmission(input: { message?: string; name?: string; aiAssisted?: boolean }): Promise<{ body: string; submissionId: string; summary: { files: number; blocks: number; annotations: number } }>
  rebase(newSnapshot: ShareEditorHost['snapshot'], draft: DraftV2): Promise<RebaseUiResult>
  destroy(): Promise<void>
}
export type ShareEditorHandleE1 = Omit<ShareEditorHandle, 'rebase'>
/** E1 intentionally has no rebase method. Task 4 supplies the complete handle. */
export interface ShareEditorModule {
  apiVersion: 1
  mount(container: HTMLElement, host: ShareEditorHost, opts: { path: string }): Promise<ShareEditorHandleE1>
}
