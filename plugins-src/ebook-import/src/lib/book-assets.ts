/** Progress belongs to the book, independently of AI reading and classification. */
export interface BookAssetsState {
  status: 'running' | 'done' | 'failed'
  jobId?: number
  matched?: boolean
  cover?: boolean
  error?: string
  indexWarning?: string
  assetWarning?: string
}

export interface BookAssetsPush {
  type: 'book_assets'
  job_id: number
  book: string
  status: 'done' | 'failed'
  matched?: boolean
  cover?: boolean
  error?: string
  index_warning?: string
  asset_warning?: string
}
