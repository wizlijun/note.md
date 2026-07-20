import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { getRecord } from './records'
import { ShareError } from './types'

export interface CopyShareLinkOptions {
  /** Write the url to the system clipboard (default true — GUI/iOS behavior).
   *  The CLI passes false for --json / --no-clipboard runs, where stdout is
   *  the contract and a clipboard write would be a side effect. */
  clipboard?: boolean
}

export async function copyShareLink(path: string, opts?: CopyShareLinkOptions): Promise<string> {
  const rec = getRecord(path)
  if (!rec || !rec.url) throw new ShareError('corrupt_record', 'no url')
  if (opts?.clipboard !== false) await writeText(rec.url)
  return rec.url
}
