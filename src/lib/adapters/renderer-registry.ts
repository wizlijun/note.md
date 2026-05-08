import type { RendererRegistry, RendererPluginModule } from '@moraya/core'

type Loader = () => Promise<RendererPluginModule>

interface PluginEntry {
  version: string
  load: Loader
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
          const msg = e instanceof Error ? e.message : String(e)
          const escaped = msg.replace(/[&<>"]/g, (c) =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string),
          )
          container.innerHTML = `<div class="renderer-error">${escaped}</div>`
        }
      },
      destroy(container) {
        container.innerHTML = ''
      },
    }
  },
}

const PLUGINS: Record<string, PluginEntry> = {
  dot: dotPlugin,
  graphviz: dotPlugin,
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
