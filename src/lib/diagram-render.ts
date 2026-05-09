import { htmlEscape } from './plugins/host-render-html'

/**
 * Walk a staged DOM root, find ```mermaid / ```dot / ```graphviz code blocks,
 * lazy-load the matching renderer plugin, and replace each `<pre>` with a
 * rendered SVG. Per-block errors become red placeholder text — one bad
 * diagram doesn't sink the whole render.
 *
 * Used by host-render-html (the shared renderer.html pipeline) so the
 * share, md2pdf, and any future plugins stay in sync with M↓'s rich mode.
 */
export async function renderDiagrams(staging: HTMLElement): Promise<void> {
  type Lang = 'mermaid' | 'dot' | 'graphviz'
  const blocks: Array<{ lang: Lang; pre: HTMLElement; source: string }> = []
  const candidates = staging.querySelectorAll<HTMLElement>(
    'pre code.language-mermaid, pre code.language-dot, pre code.language-graphviz',
  )
  for (const code of Array.from(candidates)) {
    const pre = code.parentElement as HTMLElement | null
    if (!pre || pre.tagName !== 'PRE') continue
    const langClass = Array.from(code.classList).find((c) =>
      c === 'language-mermaid' || c === 'language-dot' || c === 'language-graphviz',
    )
    if (!langClass) continue
    const lang = langClass.slice('language-'.length) as Lang
    blocks.push({ lang, pre, source: code.textContent ?? '' })
  }
  if (blocks.length === 0) return

  const { loadDotRenderer, loadMermaidRenderer } = await import(
    './adapters/renderer-registry'
  )
  // Cache the in-flight load *promise*, not the resolved plugin. Otherwise
  // the first batch of parallel callers all see cache-miss before the first
  // load resolves, each spin up their own plugin instance, and per-instance
  // state (e.g. mermaid id counters) collides.
  const langCache = new Map<
    Lang,
    Promise<{ render: (source: string, container: HTMLElement) => void | Promise<void> }>
  >()
  const loaderFor = (lang: Lang) => {
    const cached = langCache.get(lang)
    if (cached) return cached
    const promise = lang === 'mermaid' ? loadMermaidRenderer() : loadDotRenderer()
    langCache.set(lang, promise)
    return promise
  }

  await Promise.all(
    blocks.map(async ({ lang, pre, source }) => {
      const container = document.createElement('div')
      container.className = lang === 'mermaid' ? 'mermaid' : 'dot'
      pre.parentNode?.replaceChild(container, pre)
      try {
        const plugin = await loaderFor(lang)
        await plugin.render(source, container)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        container.innerHTML = `<div class="renderer-error">${htmlEscape(`${lang} render failed: ${msg}`)}</div>`
      }
    }),
  )
}
