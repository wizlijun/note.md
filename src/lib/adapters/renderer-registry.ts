import type { RendererRegistry, RendererPluginModule } from '@moraya/core'

type Loader = () => Promise<RendererPluginModule>

interface PluginEntry {
  version: string
  load: Loader
}

function escapeRenderError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  return msg.replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string),
  )
}

const dotPlugin: PluginEntry = {
  version: '1',
  load: async () => {
    const { instance } = await import('@viz-js/viz')
    let vizPromise: Promise<Awaited<ReturnType<typeof instance>>> | null = null
    const getViz = () => (vizPromise ??= instance())

    return {
      async render(source, container) {
        container.innerHTML = ''
        if (!source.trim()) {
          container.innerHTML = '<div class="renderer-empty">Empty graph</div>'
          return
        }
        const viz = await getViz()
        try {
          const svg = viz.renderSVGElement(source)
          container.appendChild(svg)
        } catch (e) {
          container.innerHTML = `<div class="renderer-error">${escapeRenderError(e)}</div>`
        }
      },
      destroy(container) {
        container.innerHTML = ''
      },
    }
  },
}

interface MermaidLike {
  initialize: (cfg: { startOnLoad?: boolean; securityLevel?: string }) => void
  render: (id: string, src: string) => Promise<{ svg: string }>
}

const mermaidPlugin: PluginEntry = {
  version: '1',
  load: async () => {
    const mod = (await import('mermaid')) as unknown as { default?: MermaidLike }
    const mermaid: MermaidLike =
      (mod.default as MermaidLike | undefined) ?? (mod as unknown as MermaidLike)
    let initialized = false
    const ensureInit = () => {
      if (initialized) return
      // `securityLevel: 'loose'` lets click/href in diagrams pass through.
      // For PDF export this doesn't matter (no interactivity); for in-app
      // RichEditor it does.
      mermaid.initialize({ startOnLoad: false, securityLevel: 'loose' })
      initialized = true
    }
    let counter = 0

    return {
      async render(source, container) {
        container.innerHTML = ''
        if (!source.trim()) {
          container.innerHTML = '<div class="renderer-empty">Empty diagram</div>'
          return
        }
        ensureInit()
        const id = `mermaid-${++counter}-${Date.now()}`
        try {
          const result = await mermaid.render(id, source)
          container.innerHTML = result.svg
        } catch (e) {
          container.innerHTML = `<div class="renderer-error">${escapeRenderError(e)}</div>`
        }
      },
      destroy(container) {
        container.innerHTML = ''
      },
    }
  },
}

/** Top-level loader for the dot/graphviz renderer. Used by both the
 *  RichEditor's `rendererRegistry` and the PDF export pipeline. */
export const loadDotRenderer = dotPlugin.load

/** Top-level loader for the mermaid renderer. */
export const loadMermaidRenderer = mermaidPlugin.load

const PLUGINS: Record<string, PluginEntry> = {
  dot: dotPlugin,
  graphviz: dotPlugin,
  mermaid: mermaidPlugin,
}

export class DefaultRendererRegistry implements RendererRegistry {
  readonly versions: Readonly<Record<string, string>> = Object.freeze(
    Object.fromEntries(Object.entries(PLUGINS).map(([id, p]) => [id, p.version])),
  )

  has(language: string): boolean {
    return language in PLUGINS
  }

  async load(language: string): Promise<RendererPluginModule> {
    const entry = PLUGINS[language]
    if (!entry) throw new Error(`[RendererRegistry] no renderer for "${language}"`)
    return entry.load()
  }
}

export const rendererRegistry = new DefaultRendererRegistry()
