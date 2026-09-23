This is `typst-svg` 0.15.1 from the [Typst repository](https://github.com/typst/typst/tree/v0.15.1/crates/typst-svg), licensed Apache-2.0.

Typeset Reader only renders Markdown with local images to SVG pages. Its input validator rejects PDF images by extension or detected content. This copy removes SVG export's PDF-image conversion, its Hayro dependencies, and the 14 standard PDF font blobs pulled in by that conversion. All other image and SVG rendering code remains upstream 0.15.1.

When updating Typst, rebase this small change against the matching `typst-svg` release and verify that the final binary contains no PDF standard font data.
