import pdfCss from '../../md2pdf/assets/pdf.css?raw'

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Wrap an inline-body HTML fragment (from renderTabAsInlineBody) into a
 * self-contained A4 print document. Mirrors md2pdf's template.rs wrap_html so
 * printing and PDF export share the exact same stylesheet and structure.
 */
export function wrapPrintHtml(body: string, title: string): string {
  const t = htmlEscape(title)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${t}</title>
<style>${pdfCss}</style>
</head>
<body data-pdf-title="${t}">
${body}
</body>
</html>`
}
