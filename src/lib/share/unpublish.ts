import { del } from './client'
import { getRecord, deleteRecord } from './records'
import { ShareError } from './types'

export interface UnpublishInput {
  path: string
  baseUrl: string
}

export async function unpublish(input: UnpublishInput): Promise<void> {
  const rec = getRecord(input.path)
  if (!rec) throw new ShareError('corrupt_record', 'no record for this path')
  if (!rec.edit_token) throw new ShareError('corrupt_record', 'missing edit_token')

  const path = rec.kind === 'image'
    ? `/f/${rec.id}.${rec.ext}`
    : `/${rec.slug}`

  await del(path, { edit_token: rec.edit_token })
  await deleteRecord(input.path)
}
