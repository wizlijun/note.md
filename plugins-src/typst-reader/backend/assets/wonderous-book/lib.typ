// wonderous-book 0.1.2, Copyright Typst GmbH, MIT-0.
// The upstream `book` function is kept intact below. `book-part` is a local
// extension for note.md's progressive chapter renderer.

#let book(
  title: [Book title],
  author: "Author",
  paper-size: "iso-b5",
  dedication: none,
  publishing-info: none,
  body,
) = {
  let detectable-pagebreak(to: "odd") = {
    [#metadata(none) <empty-page-start>]
    pagebreak(to: to)
    [#metadata(none) <empty-page-end>]
  }
  let is-page-empty() = {
    let page-num = here().page()
    query(<empty-page-start>)
      .zip(query(<empty-page-end>))
      .any(((start, end)) => {
        (start.location().page() < page-num
          and page-num < end.location().page())
      })
  }
  set document(title: title, author: author)
  set text(font: "TeX Gyre Pagella")
  set page(paper: paper-size, margin: (bottom: 1.75cm, top: 2.25cm))
  page(align(center + horizon)[
    #text(2em)[*#title*]
    #v(2em, weak: true)
    #text(1.6em, author)
  ])
  if publishing-info != none {
    align(center + bottom, text(0.8em, publishing-info))
  }
  pagebreak()
  if dedication != none {
    v(15%)
    align(center, strong(dedication))
  }
  pagebreak(to: "odd")
  set par(spacing: 0.78em, leading: 0.78em, first-line-indent: 12pt, justify: true)
  outline(title: [Chapters])
  pagebreak(to: "odd", weak: true)
  set page(
    header: context {
      if is-page-empty() { return }
      let i = here().page()
      if query(heading).any(it => it.location().page() == i) { return }
      let before = query(selector(heading).before(here()))
      if before != () {
        set text(0.95em)
        let header = smallcaps(before.last().body)
        let title = smallcaps(title)
        let author = text(style: "italic", author)
        grid(
          columns: (1fr, 10fr, 1fr),
          align: (left, center, right),
          if calc.even(i) [#i],
          if calc.even(i) { author } else { title },
          if calc.odd(i) [#i],
        )
      }
    },
  )
  show heading.where(level: 1): it => {
    detectable-pagebreak(to: "odd")
    let number = if it.numbering != none {
      counter(heading).display(it.numbering)
      h(7pt, weak: true)
    }
    v(5%)
    text(2em, weight: 700, block([#number #it.body]))
    v(1.25em)
  }
  show heading: set text(11pt, weight: 400)
  body
}

// Progressive variant: preserve wonderous-book's B5 page, Pagella serif,
// indented prose, running heads, and chapter treatment while allowing an
// initial preview and later continuation batches. The first part owns the
// title leaves; later parts continue the physical page numbers supplied by
// the host.
#let book-part(
  title: [Book title],
  author: "Author",
  paper-size: "iso-b5",
  first: false,
  chapter-start: false,
  page-offset: 0,
  body,
) = {
  set document(title: title, author: author)
  set text(font: ("TeX Gyre Pagella", "Songti SC", "STSong", "Noto Serif CJK SC"))
  set page(
    paper: paper-size,
    margin: (bottom: 1.75cm, top: 2.25cm),
    numbering: (number, _total) => str(number + page-offset),
  )
  if first {
    page(align(center + horizon)[
      #text(2em)[*#title*]
      #v(2em, weak: true)
      #text(1.6em, author)
    ])
    pagebreak()
    pagebreak(to: "odd")
  } else if chapter-start and calc.even(page-offset + 1) {
    pagebreak()
  }
  set par(spacing: 0.78em, leading: 0.78em, first-line-indent: 12pt, justify: false)
  set page(
    header: context {
      let local = here().page()
      let number = local + page-offset
      set text(0.95em)
      let book-title = smallcaps(title)
      grid(
        columns: (1fr, 10fr, 1fr),
        align: (left, center, right),
        if calc.even(number) [#number],
        if calc.even(number) { text(style: "italic", author) } else { book-title },
        if calc.odd(number) [#number],
      )
    },
  )
  show heading.where(level: 1): it => {
    pagebreak(weak: true)
    let number = if it.numbering != none {
      counter(heading).display(it.numbering)
      h(7pt, weak: true)
    }
    v(5%)
    text(2em, weight: 700, block([#number #it.body]))
    v(1.25em)
  }
  show heading: set text(11pt, weight: 400)
  body
}
