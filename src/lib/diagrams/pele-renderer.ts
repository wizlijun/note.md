import DOMPurify from 'dompurify'
import { render } from 'pele'

export interface PeleRenderOptions {
  maxWidth?: number
  appearance?: {
    theme: 'default' | 'dark'
    themeVariables: {
      background?: string
      primaryColor: string
      primaryTextColor: string
      primaryBorderColor: string
      lineColor: string
      secondaryColor: string
      tertiaryColor: string
    }
  }
  links?: boolean
}

const fontFamily = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
const sourceLimit = 50_000
const outputLimit = 4_000_000

// CSS escapes/comments can hide resource URLs. Authored local fragment paints
// remain useful for SVG markers and gradients; all other URL paints are removed.
function safePaint(value: string): boolean {
  const variables = [...value.matchAll(/var\(\s*(--[\w-]+)/g)]
  if (variables.some(([, name]) => !/^--(?:_(?:a|b|bg|c|fg|fm|hw|l|m|r|s|tw|w)|pele-(?:bg|fg|muted|line|surface|surface-alt|border|accent|critical|error|font|font-mono|(?:title|heading|bold)-weight|radius|series-[1-8]))$/.test(name))) return false
  return !/[\\]|\/\*|@import|(?:image-set|image|src)\s*\(/i.test(value)
    && !/url\s*\(/i.test(value.replace(/url\(\s*["']?#[\w:.-]+["']?\s*\)/gi, ''))
}

/** Browser-only, synchronous rendering; callers own insertion and error UI. */
export function renderPeleSvg(code: string, options: PeleRenderOptions = {}): string {
  const prefix = `pele-${Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')}`
  const result = render(code, {
    idPrefix: prefix,
    maxWidth: Number.isFinite(options.maxWidth) && options.maxWidth! > 0 ? options.maxWidth : undefined,
    fontFamily,
    fontFamilyMono: 'ui-monospace, SFMono-Regular, Consolas, monospace',
    limit: sourceLimit,
    outputLimit,
    maxEdges: 5_000,
    images: false,
    links: options.links === true,
    linkSchemes: ['https', 'http', 'mailto'],
  })
  const clean = DOMPurify.sanitize(result.svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ['foreignObject', 'image', 'script', 'style', 'animate', 'animateMotion', 'animateTransform', 'set', ...(options.links === true ? [] : ['a'])],
  })
  const document = new DOMParser().parseFromString(clean, 'image/svg+xml')
  const root = document.documentElement
  if (root.localName !== 'svg' || document.querySelector('parsererror')) throw new Error('Invalid Pele SVG output')

  const ids = new Map<string, string>()
  for (const node of [root, ...root.querySelectorAll('[id]')]) {
    const id = node.getAttribute('id')
    if (id) {
      const replacement = `${prefix}-${ids.size}`
      ids.set(id, replacement)
      node.setAttribute('id', replacement)
    }
  }
  for (const node of [root, ...root.querySelectorAll('*')]) {
    for (const attribute of [...node.attributes]) {
      const name = attribute.localName.toLowerCase()
      let value = attribute.value
      if (!safePaint(value)) {
        node.removeAttributeNode(attribute)
        continue
      }
      if (name === 'href') {
        if (value.startsWith('#') && ids.has(value.slice(1))) value = `#${ids.get(value.slice(1))}`
        else if (!(options.links === true && node.localName === 'a' && /^(https?:|mailto:)/i.test(value))) {
          node.removeAttributeNode(attribute)
          continue
        }
      }
      if (name === 'aria-labelledby' || name === 'aria-describedby') {
        value = value.split(/\s+/).map(id => ids.get(id)).filter(Boolean).join(' ')
      }
      value = value.replace(/url\(\s*["']?#([\w:.-]+)["']?\s*\)/gi, (_, id: string) => ids.has(id) ? `url(#${ids.get(id)})` : 'none')
      attribute.value = value
    }
  }

  const dark = options.appearance?.theme === 'dark'
  const colors = options.appearance?.themeVariables
  const defaultBackground = dark ? '#1e1e1e' : '#ffffff'
  const palette: Record<string, string> = {
    bg: colors?.background ?? defaultBackground,
    fg: colors?.primaryTextColor ?? (dark ? '#eeeeee' : '#1f1f1f'),
    muted: dark ? '#aaaaaa' : '#6e6e6e',
    line: colors?.lineColor ?? (dark ? '#cccccc' : '#1f1f1f'),
    surface: colors?.secondaryColor ?? (dark ? '#303030' : '#f3f3f3'),
    'surface-alt': colors?.tertiaryColor ?? (dark ? '#404040' : '#e6e6e6'),
    border: colors?.primaryBorderColor ?? (dark ? '#888888' : '#8a8a8a'),
    accent: colors?.primaryColor ?? (dark ? '#93c5fd' : '#2563eb'),
    critical: '#e45756',
    error: '#e45756',
  }
  const series = [palette.accent, ...(dark
    ? ['#2dd4bf', '#fbbf24', '#a78bfa', '#fb7185', '#22d3ee', '#a3e635', '#fb923c']
    : ['#0f766e', '#b45309', '#7c3aed', '#be123c', '#0e7490', '#4d7c0f', '#c2410c'])]
  series.forEach((color, index) => { palette[`series-${index + 1}`] = color })
  // Use the CSS parser as a color validator; caller-supplied values cannot
  // introduce declarations or inherited custom-property resource loads.
  const probe = document.createElementNS('http://www.w3.org/2000/svg', 'rect') as SVGElement
  for (const [name, color] of Object.entries(palette)) {
    probe.style.color = ''
    if (!/[;{}]|var\(|url\(/i.test(color) && !/^(?:inherit|initial|unset|revert(?:-layer)?)$/i.test(color.trim()) && safePaint(color)) probe.style.color = color
    const fallback = name === 'fg' ? (dark ? '#eeeeee' : '#1f1f1f') : defaultBackground
    ;(root as unknown as SVGElement).style.setProperty(`--pele-${name}`, probe.style.color ? color : fallback)
  }
  const style = (root as unknown as SVGElement).style
  style.setProperty('--pele-font', fontFamily)
  style.setProperty('--pele-font-mono', 'ui-monospace, SFMono-Regular, Consolas, monospace')
  // Keep typography self-contained; these allowed variables cannot inherit resource paints.
  for (const role of ['title', 'heading', 'bold']) style.setProperty(`--pele-${role}-weight`, 'bold')
  style.setProperty('--pele-radius', '4px')
  style.setProperty('background-color', 'var(--pele-bg)')
  const background = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
  background.setAttribute('width', '100%')
  background.setAttribute('height', '100%')
  background.setAttribute('fill', 'var(--pele-bg)')
  background.setAttribute('aria-hidden', 'true')
  root.prepend(background)
  const serialized = new XMLSerializer().serializeToString(root)
  if (serialized.length > outputLimit) throw new Error(`Diagram output exceeds limit of ${outputLimit} characters`)
  return serialized
}
