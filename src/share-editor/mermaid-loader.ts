import type { MermaidLoader } from '@moraya/core'
import type { ShareEditorHost, ShareMermaidAppearance } from './contract'

export function mermaidAppearance(root: HTMLElement): ShareMermaidAppearance {
  const style = getComputedStyle(root), mode = document.documentElement.dataset.theme
  const color = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback
  return {
    theme: mode === 'dark' || mode !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'default',
    themeVariables: { primaryColor: color('--accent-color', '#4a90d9'), primaryTextColor: color('--text-primary', '#333'),
      primaryBorderColor: color('--border-color', '#ccc'), lineColor: color('--text-secondary', '#666'),
      secondaryColor: color('--bg-secondary', '#f5f5f5'), tertiaryColor: color('--bg-hover', '#eee') },
  }
}
export function shareMermaidLoader(host: ShareEditorHost, root: HTMLElement): MermaidLoader | undefined {
  if (!host.loadMermaid) return undefined
  return async () => {
    const module = await host.loadMermaid!()
    return {
      renderMermaid: async (code: string) => {
        try { return { svg: await module.render(code, mermaidAppearance(root)) } }
        catch { return { error: '图表加载失败，源码已保留；请重试预览' } }
      },
      // Every render reads the actual root again; CORE owns theme notifications.
      updateMermaidTheme() {},
    }
  }
}
