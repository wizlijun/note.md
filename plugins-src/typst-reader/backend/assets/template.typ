#import "wonderous-book/lib.typ": book-part
#import "templates/aiwriter-book.typ": aiwriter-book-part
#import "cmarker/lib.typ": render
#import sys: inputs

#let book-layout = if inputs.book_style == "aiwriter-book" {
  aiwriter-book-part.with(
    title: inputs.title,
    author: inputs.author,
    first: inputs.first,
    chapter-start: inputs.chapter_start,
    page-offset: inputs.page_offset,
  )
} else {
  book-part.with(
    title: inputs.title,
    author: inputs.author,
    paper-size: "iso-b5",
    first: inputs.first,
    chapter-start: inputs.chapter_start,
    page-offset: inputs.page_offset,
  )
}
#show: book-layout

#show raw.where(block: true): it => block(
  fill: if inputs.book_style == "aiwriter-book" { rgb("d0483e").lighten(93%) } else { rgb("f4f4f5") },
  inset: if inputs.book_style == "aiwriter-book" { 8pt } else { 9pt },
  radius: if inputs.book_style == "aiwriter-book" { 4pt } else { 3pt },
  width: 100%,
  it,
)
#show quote.where(block: true): it => block(
  stroke: (left: 2pt + rgb("9ca3af")),
  inset: (left: 10pt, y: 3pt),
  it,
)

#render(
  inputs.markdown,
  raw-typst: false,
  set-document-title: false,
  scope: (
    image: (source, alt: none, ..args) => image(source, alt: alt, ..args),
    // Calibre books can retain fragment links whose anchors were discarded.
    // SVG page navigation cannot follow them yet, so keep their visible text.
    link: (destination, body) => if type(destination) == label { body } else { link(destination, body) },
  ),
)
