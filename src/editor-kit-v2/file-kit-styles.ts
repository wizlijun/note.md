export function injectKitCss(): void {
  const href = new URL(/* @vite-ignore */ './editor-kit-v1.css', import.meta.url).href
  if (!document.querySelector('link[href$="editor-kit-v1.css"]')) {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = href
    document.head.appendChild(link)
  }
  if (document.querySelector('style[data-editor-kit-v2]')) return
  const style = document.createElement('style')
  style.dataset.editorKitV2 = ''
  style.textContent = `
    .kit-host [data-cdr-block-id] { position: relative; }
    .kit-host [data-cdr-decoration]::after {
      content: attr(data-cdr-label); position: absolute; right: 6px; top: 2px;
      max-width: min(46%, 340px); padding: 2px 7px; overflow: hidden;
      border-radius: 999px; color: #0878d1;
      background: color-mix(in srgb, #0a84ff 12%, Canvas);
      font: 600 10px/1.5 -apple-system, BlinkMacSystemFont, sans-serif;
      text-overflow: ellipsis; white-space: nowrap; pointer-events: none;
    }
    .kit-host [data-cdr-kind="proposal"] { background: color-mix(in srgb, #ff9f0a 7%, transparent); }
    .kit-host [data-cdr-kind="assessment-outdated"] { background: color-mix(in srgb, #ff3b30 6%, transparent); }
  `
  document.head.appendChild(style)
}
