import type { MermaidLoader } from '@moraya/core'
import type { ShareEditorHost, ShareMermaidAppearance } from './contract'

type Rgba = [number, number, number, number]
function rgb(value: string): Rgba | null {
  const match = value.match(/^rgba?\(([^)]+)\)$/)
  if (!match) return null
  const parts = match[1].trim().split(/[\s,/]+/)
  if (parts.length !== 3 && parts.length !== 4) return null
  const values = parts.map((part, index) => parseFloat(part) * (part.endsWith('%') ? (index === 3 ? .01 : 2.55) : 1))
  if (values.some(value => !Number.isFinite(value))) return null
  return [values[0], values[1], values[2], values[3] ?? 1]
}
function luminance(value: Rgba): number {
  const channels = value.slice(0, 3).map(channel => {
    const c = channel / 255
    return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4
  })
  return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722
}
/** Resolve ordinary RGB backgrounds, compositing translucent layers only over a known opaque ancestor. */
function previewBackground(root: HTMLElement): { color: string; rgba: Rgba } | null {
  const layers: Rgba[] = []
  for (let element: HTMLElement | null = root; element; element = element.parentElement) {
    const color = getComputedStyle(element).backgroundColor
    if (!color || color === 'transparent') continue
    const value = rgb(color)
    if (!value) return null
    if (value[3] === 0) continue
    if (value[3] < 1) { layers.push(value); continue }
    const rgba: Rgba = [...value]
    for (const layer of layers.reverse()) {
      for (let channel = 0; channel < 3; channel++) rgba[channel] = layer[channel] * layer[3] + rgba[channel] * (1 - layer[3])
    }
    return { color: layers.length ? `rgb(${rgba.slice(0, 3).map(Math.round).join(', ')})` : color, rgba }
  }
  return null
}

export function mermaidAppearance(root: HTMLElement, renderer: 'mermaid' | 'pele' = 'mermaid'): ShareMermaidAppearance {
  const style = getComputedStyle(root), mode = document.documentElement.dataset.theme
  const pele = renderer === 'pele'
  const background = pele ? previewBackground(root) : null
  const dark = background ? luminance(background.rgba) < .179
    : mode === 'dark' || mode !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches
  const foreground = background ? rgb(style.color) : null
  const contrast = foreground && background ? (Math.max(luminance(foreground), luminance(background.rgba)) + .05)
    / (Math.min(luminance(foreground), luminance(background.rgba)) + .05) : 0
  const bodyText = foreground?.[3] === 1 && contrast >= 4.5 ? style.color : undefined
  const color = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback
  return {
    theme: dark ? 'dark' : 'default',
    themeVariables: { primaryColor: color('--accent-color', pele ? (dark ? '#93c5fd' : '#2563eb') : '#4a90d9'), primaryTextColor: color('--text-primary', pele ? (bodyText ?? (dark ? '#eeeeee' : '#1f1f1f')) : '#333'),
      primaryBorderColor: color('--border-color', pele ? (dark ? '#888888' : '#8a8a8a') : '#ccc'), lineColor: color('--text-secondary', pele ? (bodyText ?? (dark ? '#cccccc' : '#1f1f1f')) : '#666'),
      secondaryColor: color('--bg-secondary', pele ? (dark ? '#303030' : '#f3f3f3') : '#f5f5f5'), tertiaryColor: color('--bg-hover', pele ? (dark ? '#404040' : '#e6e6e6') : '#eee'),
      ...(background ? { background: background.color } : {}) },
  }
}
export function shareMermaidLoader(host: ShareEditorHost, root: HTMLElement): MermaidLoader | undefined {
  if (!host.loadMermaid) return undefined
  return async () => {
    const module = await host.loadMermaid!()
    return {
      supportsResponsiveLayout: module.supportsResponsiveLayout,
      renderMermaid: async (code: string, options?: { maxWidth?: number; container?: HTMLElement }) => {
        try { return { svg: await (module.supportsResponsiveLayout
          ? module.render(code, mermaidAppearance(options?.container ?? root, 'pele'), options?.maxWidth === undefined ? undefined : { maxWidth: options.maxWidth })
          : module.render(code, mermaidAppearance(root))) } }
        catch { return { error: '图表加载失败，源码已保留；请重试预览' } }
      },
      // Every render reads the actual preview (or root) again; CORE owns theme notifications.
      updateMermaidTheme() {},
    }
  }
}
