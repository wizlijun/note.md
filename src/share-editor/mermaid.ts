import mermaid from 'mermaid-mini'
import DOMPurify from 'dompurify'
import { ensureMermaidCssStyleSheetCompatibility } from '../lib/mermaid-cssom'
import type { ShareMermaidAppearance } from './contract'

let queue: Promise<unknown> = Promise.resolve(), sequence = 0
export const shareMermaid = {
  render(code: string, appearance: ShareMermaidAppearance): Promise<string> {
    const job = queue.then(async () => {
      ensureMermaidCssStyleSheetCompatibility()
      // Resource loads can occur while Mermaid measures its temporary DOM,
      // before final SVG sanitization. Check decoded CSS/HTML and the actual
      // parser's image fields before allowing the renderer to create that DOM.
      const text = document.createElement('textarea'); text.innerHTML = code
      const decoded = text.value.replace(/\\([0-9a-f]{1,6})\s?|\\([^\r\n])/gi, (_all, hex: string, char: string) => hex ? String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff)) : char)
      if (/@import|\burl\s*\(|<\s*(?:img|image|iframe|object|embed|link)\b/i.test(decoded)) throw Error('图表中的外部资源不自动加载，请保留源码')
      // Only the six approved colours cross this boundary; caller cannot
      // override strict security, font loading or diagram directives.
      const v = appearance.themeVariables
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: appearance.theme === 'dark' ? 'dark' : 'default',
        fontFamily: 'sans-serif', htmlLabels: false, suppressErrorRendering: true,
        secure: ['secure', 'securityLevel', 'startOnLoad', 'fontFamily', 'themeCSS', 'themeVariables', 'htmlLabels', 'flowchart', 'dompurifyConfig'],
        dompurifyConfig: { FORBID_TAGS: ['img', 'image', 'iframe', 'object', 'embed', 'link'] },
        themeVariables: { primaryColor: v.primaryColor, primaryTextColor: v.primaryTextColor, primaryBorderColor: v.primaryBorderColor,
          lineColor: v.lineColor, secondaryColor: v.secondaryColor, tertiaryColor: v.tertiaryColor,
          mainBkg: v.primaryColor, nodeBorder: v.primaryBorderColor, textColor: v.primaryTextColor, nodeTextColor: v.primaryTextColor,
          clusterBkg: v.secondaryColor, clusterBorder: v.primaryBorderColor, edgeLabelBackground: v.tertiaryColor },
      })
      const diagram = await mermaid.mermaidAPI.getDiagramFromText(code)
      const db = diagram.db as Record<string, unknown>, seen = new WeakSet<object>()
      function inspect(value: unknown) {
        if (!value || typeof value !== 'object' || seen.has(value)) return
        seen.add(value)
        if (value instanceof Map) { for (const row of value.values()) inspect(row); return }
        for (const [key, child] of Object.entries(value)) {
          if (/^(?:img|image|imageUrl)$/i.test(key) && child) throw Error('图表中的图片不自动加载，请保留源码')
          inspect(child)
        }
      }
      for (const getter of ['getData', 'getNodes', 'getActors']) if (typeof db[getter] === 'function') inspect((db[getter] as () => unknown).call(db))
      const result = await mermaid.render(`share-mermaid-${++sequence}`, code)
      const clean = DOMPurify.sanitize(result.svg, { USE_PROFILES: { svg: true, svgFilters: true }, FORBID_TAGS: ['foreignObject', 'image', 'a', 'script'] })
      const template = document.createElement('template'); template.innerHTML = clean
      const externalCss = (value: string) => /@import/i.test(value) || [...value.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)].some(match => !match[2].trim().startsWith('#'))
      for (const element of template.content.querySelectorAll('*')) {
        if (element.tagName.toLowerCase() === 'style' && externalCss(element.textContent ?? '')) element.remove()
        for (const attr of Array.from(element.attributes)) if (/href$/i.test(attr.name) && !attr.value.startsWith('#') || externalCss(attr.value)) element.removeAttribute(attr.name)
      }
      return template.innerHTML
    })
    queue = job.catch(() => {}); return job
  },
}
if (typeof window !== 'undefined') Object.assign(window, { NotemdShareMermaid: shareMermaid })
