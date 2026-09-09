export type IndexView = 'table' | 'list' | 'board' | 'gallery'

export interface IndexLink {
  text: string
  href: string
  /** UTF-16 offsets into the containing cell's text, with an exclusive end. */
  start: number
  end: number
}
export interface IndexImage { alt: string; href: string }
export interface IndexCell { text: string; links: IndexLink[]; images: IndexImage[] }
export interface IndexRow {
  id: string
  title: string
  href: string
  cells: IndexCell[]
  section: string
  cover?: IndexImage
}
export interface IndexDocument {
  uri: string
  title: string
  description: string[]
  columns: string[]
  rows: IndexRow[]
  view: IndexView
  groupBy: string
  laneBy: string
}
