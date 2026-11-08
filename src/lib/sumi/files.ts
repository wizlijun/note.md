import { frontmatterValues } from '../plugins/file-views'

/** Writing projections are managed as a document/metadata pair by the host. */
export function isSumiProjection(path: string): boolean {
  return /\.writing\.(?:md|meta\.json)$/i.test(path)
}

/** Last accepted frontmatter, never the user's uncommitted Source metadata. */
export function sumiPageIdentity(raw: string): { pageId: string; epoch: number } | undefined {
  const header = frontmatterValues(raw)
  const pageId = header?.get('page_id'), epoch = header?.get('write_epoch')
  if (header?.get('type') !== 'Writing Page' || typeof pageId !== 'string'
    || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(pageId)
    || typeof epoch !== 'number' || !Number.isSafeInteger(epoch) || epoch < 1) return
  return { pageId, epoch }
}
