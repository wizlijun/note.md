#import "wonderous-book/lib.typ": book-part
#import "templates/cjk-book.typ": cjk-book-part
#import "cmarker/lib.typ": render
#import sys: inputs

#let book-layout = if inputs.book_style == "aiwriter-book" {
  cjk-book-part.with(
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

#show raw: set text(font: ("DejaVu Sans Mono", "Menlo", "Consolas", "Liberation Mono"))

#let english-blocks(body) = {
  show raw.where(block: true): it => block(
    fill: rgb("f4f4f5"), inset: 9pt, radius: 3pt, width: 100%, it,
  )
  show quote.where(block: true): it => block(
    stroke: (left: 2pt + rgb("9ca3af")), inset: (left: 10pt, y: 3pt), it,
  )
  body
}
#show: if inputs.book_style == "aiwriter-book" {
  body => {
    show super: set text(font: ("Libertinus Serif", "Times New Roman", "New Computer Modern"))
    show footnote.entry: set par(first-line-indent: 0pt)
    body
  }
} else { english-blocks }

#render(
  inputs.markdown,
  raw-typst: false,
  set-document-title: false,
  scope: (
    divider: () => if inputs.book_style == "aiwriter-book" {
      line(length: 100%)
    } else { divider() },
    image: (source, alt: none, ..args) => image(source, alt: alt, ..args),
    // Calibre books can retain fragment links whose anchors were discarded.
    // SVG page navigation cannot follow them yet, so keep their visible text.
    link: (destination, body) => if type(destination) == label { body } else { link(destination, body) },
  ),
)
