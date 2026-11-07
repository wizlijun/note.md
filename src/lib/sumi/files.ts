/** Writing projections are managed as a document/metadata pair by the host. */
export function isSumiProjection(path: string): boolean {
  return /\.writing\.(?:md|meta\.json)$/i.test(path)
}
