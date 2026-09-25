// The CN and Lite faces are compatible system-installed subset fallbacks.
#let ACCENT = rgb("#d0483e")
#let ACCENT_DEEP = rgb("#a3362e")

#let SERIF = (
  "Source Han Serif SC",
  "Source Han Serif CN",
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
  "LXGW WenKai Lite",
  "霞鹜文楷",
  "Kaiti SC",
  "STKaiti",
  "Source Han Serif SC",
  "Songti SC",
)

#let SANS = (
  "Source Han Sans SC",
  "Source Han Sans CN",
  "思源黑体",
  "Heiti SC",
  "PingFang SC",
  "Noto Sans CJK SC",
  "sans-serif",
)

#let cjk-book(
  title: none,
  subtitle: none,
  author: none,
  toc: true,
  page-offset: 0,
  body,
) = {
  set text(font: SERIF, lang: "zh", region: "cn", size: 10.5pt, fill: rgb("#24221e"))
  set page(
    width: 170mm, height: 240mm,
    margin: (inside: 2.4cm, outside: 1.9cm, top: 2.3cm, bottom: 2.0cm),
    fill: rgb("#fbf8f1"),
    numbering: (number, _total) => str(number + page-offset),
  )
  set par(justify: true, first-line-indent: (amount: 2em, all: true), leading: 0.98em, spacing: 1.25em)
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
  show heading.where(level: 2): it => block(above: 1.4em, below: 0.6em)[#text(font: KAI, size: 15pt, weight: "bold", fill: ACCENT)[#it.body]]
  show heading.where(level: 3): it => block(above: 1.1em, below: 0.5em)[#text(font: SANS, size: 12.5pt, weight: "bold")[#it.body]]
  show list: set par(first-line-indent: 0pt)
  show enum: set par(first-line-indent: 0pt)
  show strong: set text(fill: ACCENT_DEEP)
  show raw.where(block: true): it => block(fill: ACCENT.lighten(93%), inset: 8pt, radius: 4pt, width: 100%, it)
  show link: set text(fill: ACCENT_DEEP)
  set table(fill: (_, y) => if y == 0 { ACCENT.lighten(88%) })
  show table.cell.where(y: 0): set text(weight: "bold", fill: ACCENT_DEEP)

  if title != none {
    page(fill: ACCENT.darken(12%), margin: 2.2cm, numbering: none, header: none, footer: none,
      background: place(top + left, dx: 0.6cm, dy: 0.6cm, rect(width: 100% - 1.2cm, height: 100% - 1.2cm, stroke: 0.6pt + rgb("#e8e0cf"))))[
      #set par(first-line-indent: 0pt)
      #set text(fill: rgb("#f4efe3"))
      #align(center)[
        #v(7fr)
        #text(font: KAI, size: 34pt, weight: "bold")[#title]
        #if subtitle != none and subtitle != "" {
          v(0.7em)
          text(font: KAI, size: 16pt, fill: rgb("#f4efe3"))[#subtitle]
        }
        #v(0.9em)
        #box(width: 26%, height: 2pt, fill: rgb("#f4efe3"))
        #v(8fr)
        #if author != none and author != "" {
          text(size: 12pt, tracking: 2pt, fill: rgb("#f4efe3"))[#author]
        }
        #v(1.2fr)
      ]
    ]
    counter(page).update(1)
  }

  if toc {
    outline(title: text(font: KAI, size: 16pt, fill: ACCENT_DEEP)[目录], depth: 2, indent: 1.2em)
    pagebreak()
  }
  body
}

// Progressive batches share the same style; the reader supplies page offsets.
#let cjk-book-part(
  title: none,
  author: none,
  first: false,
  chapter-start: false,
  page-offset: 0,
  body,
) = cjk-book(
  title: if first { title } else { none },
  author: author,
  toc: false,
  page-offset: page-offset,
  body,
)
