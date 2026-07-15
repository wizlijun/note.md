/** Obsidian-compatible .base data model (v1 subset). */

export type SortDirection = 'ASC' | 'DESC'

export interface BaseSort {
  property: string
  direction: SortDirection
}

/** A filter node: structured and/or/not, or a leaf statement string. */
export type BaseFilter =
  | { and: BaseFilter[] }
  | { or: BaseFilter[] }
  | { not: BaseFilter[] }
  | string

export interface BaseView {
  type: string // v1 只渲染 'table'
  name: string
  order?: string[]
  groupBy?: BaseSort
  sort?: BaseSort[]
  filters?: BaseFilter
  limit?: number
}

export interface BaseConfig {
  filters?: BaseFilter
  properties: Record<string, { displayName?: string }>
  views: BaseView[]
  /** 非空表示解析失败,原始 YAML 无法结构化。 */
  error?: string
  /** 原始解析对象(未来写回/保留未支持字段用)。 */
  raw?: unknown
}

/** One markdown file's scanned metadata. */
export interface FileRecord {
  path: string
  name: string // 含扩展名
  folder: string // 父目录
  ext: string // 不含点
  mtime: number // ms
  ctime: number // ms
  size: number // bytes
  tags: string[] // v1:仅 frontmatter tags
  frontmatter: Record<string, unknown>
}

/** A table row: the source record plus resolved cell values by property id. */
export interface BaseRow {
  record: FileRecord
  cells: Record<string, unknown>
}

/** A column-header menu action emitted by BaseColumnMenu → handled by BaseView. */
export type ColumnMenuAction =
  | { kind: 'rename'; name: string }
  | { kind: 'sort'; direction: SortDirection }
  | { kind: 'clearSort' }
  | { kind: 'group'; direction: SortDirection }
  | { kind: 'ungroup' }
  | { kind: 'move'; delta: -1 | 1 }
  | { kind: 'remove' }
