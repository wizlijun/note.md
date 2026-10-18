import type { MermaidLoader } from '@moraya/core'
import type { ShareEditorHost, ShareMermaidAppearance } from './contract'

export function mermaidAppearance(root: HTMLElement, renderer: 'mermaid' | 'pele' = 'mermaid'): ShareMermaidAppearance {
  const style = getComputedStyle(root), mode = document.documentElement.dataset.theme
  const dark = mode === 'dark' || mode !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches
  const pele = renderer === 'pele'
  const color = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback
  return {
    theme: dark ? 'dark' : 'default',
    themeVariables: { primaryColor: color('--accent-color', pele ? (dark ? '#93c5fd' : '#2563eb') : '#4a90d9'), primaryTextColor: color('--text-primary', pele ? (dark ? '#eeeeee' : '#1f1f1f') : '#333'),
      primaryBorderColor: color('--border-color', pele ? (dark ? '#888888' : '#8a8a8a') : '#ccc'), lineColor: color('--text-secondary', pele ? (dark ? '#cccccc' : '#1f1f1f') : '#666'),
      secondaryColor: color('--bg-secondary', pele ? (dark ? '#303030' : '#f3f3f3') : '#f5f5f5'), tertiaryColor: color('--bg-hover', pele ? (dark ? '#404040' : '#e6e6e6') : '#eee') },
  }
}
export function shareMermaidLoader(host: ShareEditorHost, root: HTMLElement): MermaidLoader | undefined {
  if (!host.loadMermaid) return undefined
  return async () => {
    const module = await host.loadMermaid!()
    return {
      supportsResponsiveLayout: module.supportsResponsiveLayout,
      renderMermaid: async (code: string, options?: { maxWidth?: number }) => {
        try { return { svg: await (module.supportsResponsiveLayout
          ? module.render(code, mermaidAppearance(root, 'pele'), options)
          : module.render(code, mermaidAppearance(root))) } }
        catch { return { error: '图表加载失败，源码已保留；请重试预览' } }
      },
      // Every render reads the actual root again; CORE owns theme notifications.
      updateMermaidTheme() {},
    }
  }
}
