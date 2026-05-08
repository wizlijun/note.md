# PDF Export — Design

**Status**: Brainstorm complete; pending implementation plan
**Date**: 2026-05-08
**Owner**: bruce@hemory.com

## Goal

Add a "File → Export to PDF…" menu item that produces a typographically
elegant PDF of the current Markdown or HTML tab. Output mirrors what the user
sees in rich mode (KaTeX math, Mermaid diagrams, syntax-highlighted code,
images), formatted for A4 reading.

## Behaviour

### What gets exported

- **Markdown tabs** (`tab.kind === 'markdown'`): `tab.currentContent` is
  re-rendered through the same Markdown → HTML pipeline rich mode uses
  (marked + KaTeX + highlight.js + mermaid). Result is exported.
- **HTML tabs** (`tab.kind === 'html'`): `tab.currentContent` is treated as a
  document body, wrapped in the print template, exported.
- **Code tabs** (`tab.kind === 'code'`): menu item disabled (greyed out).

### Source of truth

Always re-render from `tab.currentContent` (the in-memory buffer), regardless
of whether the user is in source or rich mode. A dirty tab exports its
unsaved buffer, not the on-disk file.

### Output destination

Native save dialog. Default filename: `<basename without extension>.pdf`
(e.g. `report.md` → `report.pdf`; `Dockerfile` → `Dockerfile.pdf`).
Default location: macOS chooses (typically the source file's directory or
the user's last-used location).

### Page layout

A4 portrait, 25 mm top/bottom, 20 mm left/right. Hard-coded — no UI for v1.

### Headers / footers

- **Top centre** (every page except first): document title in 9 pt sans-serif.
  Title comes from the first H1 in the markdown; falls back to the file's
  basename (without extension) if no H1.
- **Bottom right** (every page): `<page> / <total>` in 9 pt sans-serif.
- **First page**: top-centre suppressed (the H1 is already big at the top of
  page 1; repeating it in the header would be visually redundant).

## Architecture

### New files

- **`src/lib/pdf-export.ts`** — Frontend export orchestrator. Public API:
  ```ts
  export async function exportTabAsPdf(tab: Tab, outputPath: string): Promise<void>
  export function suggestedPdfFilename(filePath: string): string
  ```
  Plus internal helpers (pure, unit-testable):
  - `extractH1FromMarkdown(md: string): string | null`
  - `buildPdfTitle(tab: Tab): string`
  - `wrapInPrintTemplate(bodyHtml: string, title: string): string`
- **`src/lib/pdf-export.test.ts`** — vitest covering the pure helpers.
- **`src/styles/pdf.css`** — print stylesheet. Imported as a string into
  `wrapInPrintTemplate` and inlined into the exported HTML's `<style>`.
- **`src-tauri/src/pdf.rs`** — Rust module exporting one Tauri command:
  ```rust
  #[tauri::command]
  pub async fn export_pdf(html: String, output_path: String, base_url: String) -> Result<String, String>
  ```
  Returns the absolute output path on success; error string on failure.
  macOS-only; non-macOS targets stub-error.

### Modified files

- `src-tauri/src/lib.rs` — File submenu gains "Export to PDF…" with
  accelerator `Cmd+Shift+E`. `invoke_handler` registers `export_pdf`.
  `mod pdf;` declares the new module.
- `src-tauri/Cargo.toml` — adds `objc2 = "0.5"` and `objc2-web-kit = "0.2"`
  (or matching available versions) under the macOS-only target dependencies.
- `src/App.svelte` — `menu-event` listener gains an `'export-pdf'` branch
  that calls `cmdExportPdf()`.
- `src/lib/commands.ts` — new `cmdExportPdf()`: looks up the active tab,
  validates kind (markdown or html), shows the save dialog, calls
  `exportTabAsPdf`.
- `README.md` — smoke checklist gains items 31-38.

### Capabilities

No new Tauri capability needed; custom commands defined in `invoke_handler`
are accessible to the frontend by default.

## Data Flow

```
User clicks File → Export to PDF…    (or presses Cmd+Shift+E)
        ↓
cmdExportPdf() in src/lib/commands.ts
  1. activeTab() → bail if null
  2. Validate kind ∈ {'markdown', 'html'} → toast & bail otherwise
  3. pickSaveFile({
       defaultPath: suggestedPdfFilename(tab.filePath),
       filters: [{ name: 'PDF', extensions: ['pdf'] }],
     })
  4. User cancelled → silent return
        ↓
exportTabAsPdf(tab, outputPath) in src/lib/pdf-export.ts
  1. Mount hidden staging element:
       <div id="pdf-staging" style="position:absolute; left:-10000px;
                                    top:0; width:170mm;">
  2. Render content into staging:
       • markdown → reuse the existing rich-mode renderer pipeline
         (marked → KaTeX → hljs → mermaid SVG; renderer-registry plugins).
       • html     → set staging.innerHTML = tab.currentContent
  3. Await all async settle:
       await document.fonts.ready
       await Promise.all(images.map(img =>
           img.complete ? Promise.resolve() : new Promise(r => {
             img.onload = img.onerror = r
           })))
       (mermaid.run() returns a Promise — chain it before extraction)
  4. title = buildPdfTitle(tab)
  5. innerHtml = staging.innerHTML
  6. fullHtml = wrapInPrintTemplate(innerHtml, title)
  7. Detach + clean up staging element
        ↓
invoke('export_pdf', { html: fullHtml,
                       outputPath,
                       baseUrl: 'file:///' + dirname(tab.filePath) + '/' })
        ↓ (Rust)
export_pdf in src-tauri/src/pdf.rs:
  1. On the main thread (required for AppKit):
     - Create a hidden NSWindow with WKWebView (size 595x842 = A4 @ 72dpi)
     - webview.load_html_string(html, baseURL: NSURL(file: baseUrl))
  2. Implement WKNavigationDelegate.didFinish; resolve a oneshot Promise
  3. await navigation done (typical 100-300 ms; static HTML)
  4. webview.create_pdf(configuration: WKPDFConfiguration { rect: A4 })
     → returns NSData
  5. Write NSData bytes to output_path
  6. Drop the NSWindow / webview
  7. Return Ok(absolute_canonical_path)
        ↓
Frontend toast: "Exported to <path>"   (with action: "Show in Finder")
```

### Async settlement contract

The frontend is the single source of truth for "rendering finished". Rust's
WKWebView only needs to complete *layout* of static HTML — no JS waiting,
no settling timer. This decouples timing concerns and makes the Rust side
small and reliable.

## Self-Contained HTML

`wrapInPrintTemplate` produces a self-contained HTML document so Rust's
WKWebView doesn't need to fetch external CSS:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>{title}</title>
    <style>{pdf.css contents inlined}</style>
    <style>{KaTeX CSS contents inlined — already vendored via katex npm pkg}</style>
    <style>{highlight.js theme CSS inlined}</style>
  </head>
  <body data-pdf-title="{title}">
    {bodyHtml}
  </body>
</html>
```

`pdf.css`'s `@page` rules use `attr(data-pdf-title)` to pull the title into
the running header.

## Print Stylesheet (`src/styles/pdf.css`)

Reference: see Section 3 of the brainstorm conversation. Highlights:

- A4 + 25/20 mm margins, `@page`/`@page :first` rules
- Charter / Iowan Old Style / Georgia serif body, 11 pt, line-height 1.7
- Headings in `-apple-system` sans-serif with size ladder (22pt/16pt/13pt/11pt)
- Code blocks: SF Mono 9.5 pt, light grey background, `break-inside: avoid`,
  `overflow-wrap: anywhere`
- Tables: `font-size: 10pt`, `break-inside: avoid`, full-width
- Math: `.katex-display { break-inside: avoid }`
- Mermaid: `.mermaid svg { max-width: 100% }`
- Links: kept blue, no `(URL)` auto-append
- `orphans: 3; widows: 3;` on paragraphs

CJK fallback handled by WKWebView's font cascade (PingFang SC ships in macOS).

## Edge Cases

| Scenario | Handling |
|---|---|
| Empty / whitespace-only document | One blank page with header, no error |
| Very large document (10K+ lines) | Show "Rendering…" toast during render; no hard limit |
| User in source mode mid-edit | Re-render `tab.currentContent`; UI mode irrelevant |
| HTML tab with `<script>` | Staging div doesn't execute script (we set innerHTML on a detached/hidden node and immediately serialize); resulting PDF is a static layout snapshot |
| Markdown syntax error (unclosed fence, etc.) | marked is forgiving; best-effort output |
| KaTeX or Mermaid parse error | Inherits rich-mode behaviour: red inline error placeholder; PDF preserves the placeholder |
| File deleted externally (tab `deleted`) | baseURL points at the (now non-existent) parent dir; relative-path images may fail to resolve, but the rest of the PDF still produces |
| Long URLs / long code lines | `overflow-wrap: anywhere` on `pre`, `code`, `.katex` |
| Wide tables | `width: 100%` + `font-size: 10pt`; over-wide cells `word-break`; v1 accepts occasional overflow |
| CJK text | WKWebView's font cascade falls back to PingFang SC |
| User cancels save dialog | `pickSaveFile` returns null → silent return, no toast |
| Disk full / permission denied | Rust returns Err; toast: "Export failed: <reason>" |
| Output extension not `.pdf` | Save dialog filters to `.pdf`; if the user types another extension, append `.pdf` defensively in the frontend before invoking |

## Out of Scope (YAGNI)

- PDF preview before save — Preview.app handles this
- Multi-document concatenation / batch export
- Password / encryption
- Landscape orientation auto-switch
- Custom header/footer content
- User-customisable templates / theming
- Windows / Linux support — current M↓ only ships macOS;
  `objc2-web-kit` is macOS-only

## Testing

### Unit (vitest)

`src/lib/pdf-export.test.ts`:

- `extractH1FromMarkdown`:
  - first ATX H1 returned
  - returns `null` when no H1
  - skips leading whitespace lines
  - ATX only — `===` underline (setext) NOT recognised in v1
- `suggestedPdfFilename`:
  - `/tmp/foo.md` → `foo.pdf`
  - `/path/to/Dockerfile` → `Dockerfile.pdf`
  - `archive.tar.gz` → `archive.tar.pdf` (extension is the part after the
    last dot)
- `buildPdfTitle`:
  - returns H1 text when present
  - falls back to basename without extension
  - never returns empty string (basename always has at least one char)
- `wrapInPrintTemplate`:
  - emits valid HTML5 with `<meta charset="utf-8">`
  - inlines `pdf.css` into a `<style>` tag in `<head>`
  - sets `data-pdf-title` attr on `<body>`
  - HTML-escapes the title in `<title>` and `data-pdf-title`

### Rust

No unit tests for `export_pdf`. The function is a thin AppKit + WebKit FFI
wrapper; mocking WKWebView in Rust isn't worth the effort. Manual smoke
covers it.

### Manual smoke (extends README checklist)

```
31. Export small markdown: File → Export to PDF…; default filename =
    <basename>.pdf; PDF appears at chosen path within ~2 s.
32. Export markdown with $E=mc^2$ and $$\int_0^1 x dx$$ — math renders
    correctly in the PDF (not raw $...$).
33. Export markdown with a ```mermaid``` block — diagram appears as SVG,
    crisp at any zoom.
34. Export markdown with code blocks — monospace font, light-grey background,
    long lines wrap (no horizontal overflow).
35. Export HTML tab — content preserved; no script side-effects.
36. Export a dirty tab (buffer edited but not saved) — PDF reflects buffer,
    not on-disk content.
37. Export long markdown (>200 lines) — page breaks fall on safe boundaries:
    headings not orphaned, code blocks not split.
38. Export markdown with `![alt](./assets/foo.png)` — image appears in the
    PDF (baseURL resolved relative paths).
39. Try Export to PDF on a code tab (e.g., a `.py` file) — menu item is
    disabled / a toast says "PDF export only supports markdown and HTML".
```

## Open Questions

None at this time.
