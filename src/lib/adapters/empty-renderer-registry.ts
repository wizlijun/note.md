import type { RendererRegistry, RendererPluginModule } from '@moraya/core'

export class EmptyRendererRegistry implements RendererRegistry {
  readonly versions: Readonly<Record<string, string>> = Object.freeze({})

  has(_language: string): boolean {
    return false
  }

  async load(language: string): Promise<RendererPluginModule> {
    throw new Error(`[EmptyRendererRegistry] no custom renderer for "${language}"`)
  }
}

export const emptyRendererRegistry = new EmptyRendererRegistry()
