import { htmlEscape } from './pdf-export'

/**
 * Walk a staged DOM root, find ```mermaid / ```dot / ```graphviz code blocks,
 * lazy-load the matching renderer plugin, and replace each `<pre>` with a
 * rendered SVG. Per-block errors become red placeholder text — one bad
 * diagram doesn't sink the whole render.
 *
 * Used by both pdf-export and share-baker so PDF / share visuals stay in
 * sync with M↓'s rich mode.
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
  const langCache = new Map<
    Lang,
    { render: (source: string, container: HTMLElement) => void | Promise<void> }
  >()
  const loaderFor = async (lang: Lang) => {
    if (langCache.has(lang)) return langCache.get(lang)!
    const plugin =
      lang === 'mermaid' ? await loadMermaidRenderer() : await loadDotRenderer()
    langCache.set(lang, plugin)
    return plugin
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
