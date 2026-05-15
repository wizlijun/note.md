import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { getRecord } from './records'
import { ShareError } from './types'

export async function copyShareLink(path: string): Promise<string> {
  const rec = getRecord(path)
  if (!rec || !rec.url) throw new ShareError('corrupt_record', 'no url')
  await writeText(rec.url)
  return rec.url
}
