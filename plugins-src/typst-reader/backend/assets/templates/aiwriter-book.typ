// Reconstructed from the embedded `book` template in:
// /Applications/写匠.app/Contents/Resources/aiwriter
// AIWriter version: 0.4.13
// Binary SHA-256: dbb43cb1b884fa61737a0e0754109fb6620abe7a94eb4ced3ef5b38be92ff022
//
// The style declarations, colors, page dimensions, margins, font fallback
// chains, and heading rules below are recovered from the application binary.
// The wrapper function and title-page argument wiring are reconstructed because
// Rust stores those runtime-substituted values separately from the string data.

#let ACCENT = rgb("#d0483e")
#let ACCENT_DEEP = rgb("#a3362e")

#let SERIF = (
  "Source Han Serif SC",
  "思源宋体",
  "Songti SC",
  "STSong",
  "Noto Serif CJK SC",
  "PingFang SC",
  "New Computer Modern",
  "Libertinus Serif",
)

#let KAI = (
  "LXGW WenKai",
  "霞鹜文楷",
  "Kaiti SC",
  "STKaiti",
  "Source Han Serif SC",
  "Songti SC",
)

#let SANS = (
  "Source Han Sans SC",
  "思源黑体",
  "Heiti SC",
  "PingFang SC",
  "Noto Sans CJK SC",
  "sans-serif",
)

#let title-size(title) = if title.len() > 60 {
  16pt
} else if title.len() > 30 {
  22pt
} else {
  30pt
}

#let aiwriter-book(
  title: none,
  subtitle: none,
  author: none,
  toc: true,
  body,
) = {
  set text(
    font: SERIF,
    lang: "zh",
    region: "cn",
    size: 10.5pt,
    fill: rgb("#24221e"),
  )

  set page(
    width: 170mm,
    height: 240mm,
    margin: (
      inside: 2.4cm,
      outside: 1.9cm,
      top: 2.3cm,
      bottom: 2.0cm,
    ),
    fill: rgb("#fbf8f1"),
    numbering: "1",
  )

  set par(
    justify: true,
    first-line-indent: (amount: 2em, all: true),
    leading: 0.98em,
    spacing: 1.25em,
  )

  set heading(numbering: none)
  show heading: set par(first-line-indent: 0pt)

  show heading.where(level: 1): it => {
    pagebreak(weak: true)
    block(above: 0pt, below: 1.2em)[
      #box(width: 18%, height: 3pt, fill: ACCENT)
      #v(0.5em)
      #text(font: KAI, size: 22pt, weight: "bold", fill: ACCENT)[#it.body]
    ]
  }

  show heading.where(level: 2): it => block(above: 1.4em, below: 0.6em)[
    #text(font: KAI, size: 15pt, weight: "bold", fill: ACCENT)[#it.body]
  ]

  show heading.where(level: 3): it => block(above: 1.1em, below: 0.5em)[
    #text(font: SANS, size: 12.5pt, weight: "bold")[#it.body]
  ]

  show list: set par(first-line-indent: 0pt)
  show enum: set par(first-line-indent: 0pt)
  show strong: set text(fill: ACCENT_DEEP)
  show link: set text(fill: ACCENT_DEEP)
  set table(fill: (_, y) => if y == 0 { ACCENT.lighten(88%) })
  show table.cell.where(y: 0): set text(weight: "bold", fill: ACCENT_DEEP)

  if title != none {
    page(numbering: none, header: none, footer: none)[
      #set par(first-line-indent: 0pt)
      #align(center)[
        #v(6fr)
        #text(font: KAI, size: title-size(title), fill: ACCENT)[#title]
        #v(0.6em)
        #box(width: 18%, height: 1.5pt, fill: ACCENT)
        #if subtitle != none {
          v(1.0em)
          text(font: KAI, size: 14pt, fill: ACCENT_DEEP)[#subtitle]
        }
        #v(1fr)
        #if author != none {
          text(font: KAI, size: 12pt)[#author]
        }
        #v(7fr)
      ]
    ]
    counter(page).update(1)
  }

  if toc {
    outline(
      title: text(font: KAI, size: 15pt, fill: ACCENT_DEEP)[目录],
      depth: 2,
      indent: 1em,
    )
    pagebreak()
  }

  body
}

// Progressive adapter used by note.md. It preserves the supplied template's
// typography and chapter rules, while the host owns chunking and page offsets.
#let aiwriter-book-part(
  title: none,
  author: none,
  first: false,
  chapter-start: false,
  page-offset: 0,
  body,
) = {
  set text(
    font: SERIF,
    lang: "zh",
    region: "cn",
    size: 10.5pt,
    fill: rgb("#24221e"),
  )
  set page(
    width: 170mm,
    height: 240mm,
    margin: (
      inside: 2.4cm,
      outside: 1.9cm,
      top: 2.3cm,
      bottom: 2.0cm,
    ),
    fill: rgb("#fbf8f1"),
    numbering: (number, _total) => str(number + page-offset),
  )
  set par(
    justify: true,
    first-line-indent: (amount: 2em, all: true),
    leading: 0.98em,
    spacing: 1.25em,
  )
  set heading(numbering: none)
  show heading: set par(first-line-indent: 0pt)
  show heading.where(level: 1): it => {
    pagebreak(weak: true)
    block(above: 0pt, below: 1.2em)[
      #box(width: 18%, height: 3pt, fill: ACCENT)
      #v(0.5em)
      #text(font: KAI, size: 22pt, weight: "bold", fill: ACCENT)[#it.body]
    ]
  }
  show heading.where(level: 2): it => block(above: 1.4em, below: 0.6em)[
    #text(font: KAI, size: 15pt, weight: "bold", fill: ACCENT)[#it.body]
  ]
  show heading.where(level: 3): it => block(above: 1.1em, below: 0.5em)[
    #text(font: SANS, size: 12.5pt, weight: "bold")[#it.body]
  ]
  show list: set par(first-line-indent: 0pt)
  show enum: set par(first-line-indent: 0pt)
  show strong: set text(fill: ACCENT_DEEP)
  show raw.where(block: true): it => block(
    fill: ACCENT.lighten(93%),
    inset: 8pt,
    radius: 4pt,
    width: 100%,
    it,
  )
  show link: set text(fill: ACCENT_DEEP)
  set table(fill: (_, y) => if y == 0 { ACCENT.lighten(88%) })
  show table.cell.where(y: 0): set text(weight: "bold", fill: ACCENT_DEEP)

  if first {
    page(numbering: none, header: none, footer: none)[
      #set par(first-line-indent: 0pt)
      #align(center)[
        #v(6fr)
        #text(font: KAI, size: title-size(title), fill: ACCENT)[#title]
        #v(0.6em)
        #box(width: 18%, height: 1.5pt, fill: ACCENT)
        #v(1fr)
        #if author != none and author != "" {
          text(font: KAI, size: 12pt)[#author]
        }
        #v(7fr)
      ]
    ]
    counter(page).update(1)
  } else if chapter-start and calc.even(page-offset + 1) {
    pagebreak()
  }
  body
}
