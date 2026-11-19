import { FileInputBlockedError } from '../editor-kit-v2/file-input-error'
import { t } from './i18n/runtime.svelte'
import { pushToast, toasts } from './toast.svelte'

const reported = new WeakSet<FileInputBlockedError>()

/** Only log the input phase, never source text, annotation drafts or file paths. */
export function reportFileInputBlocked(error: unknown): boolean {
  if (!(error instanceof FileInputBlockedError)) return false
  if (reported.has(error)) return true
  reported.add(error)
  const keys = {
    'rich-composing': 'editorInput.richComposing',
    'source-composing': 'editorInput.sourceComposing',
    'source-pending': 'editorInput.sourcePending',
    'annotation-pending': 'editorInput.annotationPending',
  } as const
  const message = t(keys[error.reason])
  console.warn('[file-input] operation blocked:', error.reason)
  if (!toasts.list.some(item => item.message === message)) {
    pushToast({ level: 'warn', message, autoDismissMs: 0 })
  }
  return true
}
