/** One commit that touched a file. Mirrors Rust `git_history::GitCommit`. */
export interface GitCommit {
  hash: string
  short: string
  author: string
  /** Unix seconds (author date). */
  timestamp: number
  subject: string
}
