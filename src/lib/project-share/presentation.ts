import { invoke } from '@tauri-apps/api/core'
import type { TokenizerAndRendererExtension } from 'marked'
import { settings } from '../settings.svelte'
import { computeActiveThemeId } from '../theme-loader'
import { htmlEscape, renderTabBody, renderDiagramsToString } from '../plugins/host-render-html'
import { themedStyleHead } from '../plugins/share-baker'
import { splitFrontmatter, frontmatterDetailsHtml, FRONTMATTER_CSS } from '../frontmatter-html'
import katexCss from 'katex/dist/katex.min.css?raw'
import type { ProjectFile, ProjectSnapshot } from './types'
import { resolveReference } from './references'

export interface ProjectPresentation {
  themeId: string
  styleHead: string
  documents: Record<string, string>
  warnings: string[]
}

// These are build-time dependency assets, never paths chosen by document input.
const mathFonts = import.meta.glob<string>('../../../node_modules/katex/dist/fonts/*.woff2', {
  eager: true, query: '?inline', import: 'default',
})
const rasterData = /^data:image\/(?:png|jpeg|gif|webp|avif|bmp);base64,[a-z\d+/=\s]+$/i
const rawTags = new Set('p br hr h1 h2 h3 h4 h5 h6 b i em strong del s blockquote pre code ul ol li table thead tbody tfoot tr th td a img details summary sup sub div span mark input'.split(' '))
const generatedTags = new Set([...rawTags, ...'svg g defs marker path rect circle ellipse line polyline polygon text tspan textpath title desc style foreignobject clippath mask pattern lineargradient radialgradient stop filter feblend fecolormatrix fecomponenttransfer fecomposite feconvolvematrix fediffuselighting fedisplacementmap fedistantlight fedropshadow feflood fefunca fefuncb fefuncg fefuncr fegaussianblur femerge femergenode femorphology feoffset fepointlight fespecularlighting fespotlight fetile feturbulence symbol use switch math semantics annotation mrow mi mo mn ms mtext mspace mfrac msqrt mroot mstyle merror mpadded mphantom mfenced menclose msub msup msubsup munder mover munderover mmultiscripts mprescripts none mtable mtr mtd'.split(' ')])
const activeTags = new Set('script iframe object embed link meta base audio video source track canvas form button textarea select option template'.split(' '))
const rawAttrs = new Set('href src alt title type checked disabled colspan rowspan start align open'.split(' '))
const generatedAttrs = new Set([...rawAttrs, ...'class id style role tabindex download xmlns xmlns:xlink viewbox width height x y x1 x2 y1 y2 dx dy d points cx cy r rx ry fill fill-opacity fill-rule stroke stroke-width stroke-opacity stroke-linecap stroke-linejoin stroke-dasharray stroke-dashoffset opacity transform vector-effect text-anchor dominant-baseline alignment-baseline font-family font-size font-weight font-style textlength lengthadjust marker-start marker-mid marker-end markerwidth markerheight markerunits refx refy orient preserveaspectratio clip-path clip-rule clippathunits mask maskunits maskcontentunits filter filterunits primitiveunits color color-interpolation color-interpolation-filters offset stop-color stop-opacity gradientunits gradienttransform spreadmethod xlink:href patternunits patterncontentunits patterntransform overflow display visibility direction unicode-bidi focusable version encoding displaystyle scriptlevel stretchy fence separator mathvariant accent accentunder columnalign rowalign columnspacing rowspacing columnspan rowspacing frame framespacing equalrows equalcolumns linethickness notation lspace rspace voffset depth mathsize mathcolor mathbackground data-project-path data-project-resource'.split(' ')])

/** Parse in an inert template: raw HTML never reaches the live host document. */
function sanitize(html: string, generated: boolean): string {
  const template = document.createElement('template')
  template.innerHTML = html
  for (const node of Array.from(template.content.querySelectorAll('*'))) {
    const tag = node.localName.toLowerCase()
    if (activeTags.has(tag) || (!generated && ['svg', 'math', 'style'].includes(tag))) {
      node.remove()
      continue
    }
    if (!(generated ? generatedTags : rawTags).has(tag)) {
      node.replaceWith(...Array.from(node.childNodes))
      continue
    }
    for (const attr of Array.from(node.attributes)) {
      const key = attr.name.toLowerCase()
      const allowed = (generated ? generatedAttrs : rawAttrs).has(key) || (generated && /^aria-[a-z-]+$/.test(key))
      if (!allowed || key.startsWith('on') || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(attr.value)) node.removeAttribute(attr.name)
      else if (key === 'style') node.setAttribute('style', sanitizeCss(attr.value, [], undefined, true))
      else if (['href', 'xlink:href'].includes(key) && tag !== 'a' && !/^#[\w.-]+$/.test(attr.value)) node.removeAttribute(attr.name)
      else if (['fill', 'stroke', 'filter', 'clip-path', 'mask', 'marker-start', 'marker-mid', 'marker-end'].includes(key) && /url\s*\(/i.test(attr.value) && !/^url\(\s*['"]?#[\w.-]+['"]?\s*\)$/i.test(attr.value)) node.removeAttribute(attr.name)
    }
    if (tag === 'input') { node.setAttribute('type', 'checkbox'); node.setAttribute('disabled', '') }
    if (tag === 'style') node.textContent = sanitizeCss(node.textContent ?? '', [], undefined, true)
  }
  return template.innerHTML
}

/** Marked emits inline opening/closing tags separately; do not auto-close them. */
function sanitizeRawToken(html: string): string {
  const closing = /^<\/([a-z][a-z\d]*)\s*>$/i.exec(html)
  if (closing) return rawTags.has(closing[1].toLowerCase()) ? `</${closing[1].toLowerCase()}>` : ''
  const opening = /^<([a-z][a-z\d]*)\b/i.exec(html)
  if (opening) {
    let quote = ''
    for (let i = opening[0].length; i < html.length; i++) {
      const char = html[i]
      if (quote) { if (char === quote) quote = '' }
      else if (char === '"' || char === "'") quote = char
      else if (char === '>') {
        if (i === html.length - 1) {
          const tag = opening[1].toLowerCase()
          const safe = sanitize(html, false)
          return safe.endsWith(`</${tag}>`) ? safe.slice(0, -tag.length - 3) : safe
        }
        break
      }
    }
  }
  return sanitize(html, false)
}

function decodedCss(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\\([\da-f]{1,6})\s?|\\([^\r\n])/gi, (_, code, escaped) => code ? String.fromCodePoint(parseInt(code, 16) || 0xfffd) : escaped)
}

/** Never attach dependency-bearing template CSS to the host while examining it. */
function sanitizeCss(css: string, warnings: string[], files?: Map<string, ProjectFile>, svg = false): string {
  let cleaned = decodedCss(css)
  if (/@import\b/i.test(cleaned)) warnings.push('主题的远程 CSS/字体导入未打包，访客使用模板字体的替代字体。')
  cleaned = cleaned.replace(/@import\b[^;{}]*(?:;|$)/gi, '')
  if (/\blocal\s*\(/i.test(cleaned)) warnings.push('主题使用本机字体，访客可能使用替代字体。')
  cleaned = cleaned.replace(/\blocal\s*\([^)]*\)/gi, 'url("")')
  // CSS image-set accepts quoted URLs without url(), so do not leave it as a
  // second dependency channel after ordinary URL declarations are removed.
  cleaned = cleaned.replace(/(?:-webkit-)?(?:image-set|image|cross-fade)\s*\((?:[^()]|\([^()]*\))*\)/gi, () => {
    warnings.push('主题的复合图片依赖已移除。')
    return 'none'
  })
  cleaned = cleaned.replace(/url\s*\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi, (_, double, single, bare) => {
    const target = String(double ?? single ?? bare ?? '').trim()
    if (/^#[\w.-]+$/.test(target)) return `url(${target})`
    if (!svg && files && target) {
      const resolved = resolveReference('README.md', target)
      const approved = resolved.kind === 'path' ? files.get(resolved.path)?.dataUrl : undefined
      if (approved && rasterData.test(approved)) return `url("${approved}")`
    }
    if (target) warnings.push('主题的未批准资源依赖已移除；背景或字体可能使用替代显示。')
    return 'none'
  })
  // Block old active CSS and HTML embedding boundaries, including escaped forms.
  if (/(?:expression\s*\(|-moz-binding\s*:|behavior\s*:|<\s*\/\s*style|<\s*script)/i.test(cleaned)) {
    warnings.push('主题中的不安全样式已移除。')
    return ''
  }
  return cleaned.replace(/</g, '\\3c ')
}

function inlineMathCss(): string {
  return katexCss.replace(/src:[^;}]+/g, source => {
    const name = /fonts\/(KaTeX_[^)'"\s]+)\.woff2/.exec(source)?.[1]
    if (!name) throw new Error('KaTeX 字体声明无法打包')
    const asset = Object.entries(mathFonts).find(([path]) => path.endsWith(`/${name}.woff2`))?.[1]
    if (!asset?.startsWith('data:')) throw new Error(`KaTeX 字体无法内嵌：${name}`)
    return `src:url(${asset.replace(/^data:application\/octet-stream/, 'data:font/woff2')}) format("woff2")`
  })
}

function wikiExtension(from: string, files: Map<string, ProjectFile>): TokenizerAndRendererExtension {
  return {
    name: 'projectWiki', level: 'inline',
    start: src => src.indexOf('[['),
    tokenizer(src) {
      const match = /^!?\[\[([^\]\n]+)\]\]/.exec(src)
      if (!match) return undefined
      return { type: 'projectWiki', raw: match[0], target: match[1].split('|')[0].trim(), label: match[1].split('|')[1] ?? match[1], image: match[0].startsWith('!') }
    },
    renderer(token) {
      const result = resolveReference(from, token.target)
      if (result.kind !== 'path') return `<span class="unshared">${htmlEscape(token.label)}（未共享引用）</span>`
      let path = result.path
      if (!files.has(path) && files.has(path + '.md')) path += '.md'
      if (!files.has(path) && !token.target.split('#')[0].includes('/')) {
        const name = token.target.split('#')[0].replace(/\.(md|markdown|mdown|mkd|mdx)$/i, '')
        const matches = Array.from(files.values()).filter(file => file.markdown !== undefined && file.path.split('/').pop()!.replace(/\.(md|markdown|mdown|mkd|mdx)$/i, '') === name)
        if (matches.length === 1) path = matches[0].path
      }
      if (!files.has(path)) return `<span class="unshared">${htmlEscape(token.label)}（未共享引用）</span>`
      // The subsequent resolver accepts ordinary relative URLs, so account for this document's depth.
      const relative = '../'.repeat(from.split('/').length - 1) + path + (result.fragment ? '#' + result.fragment : '')
      return token.image && files.get(path)?.dataUrl
        ? `<img src="${htmlEscape(relative)}" alt="${htmlEscape(token.label)}">`
        : `<a href="${htmlEscape(relative)}">${htmlEscape(token.label)}</a>`
    },
  }
}

function rewriteReferences(root: HTMLElement, from: string, files: Map<string, ProjectFile>): void {
  for (const element of Array.from(root.querySelectorAll('a, img'))) {
    const image = element.localName === 'img'
    const key = image ? 'src' : 'href'
    const target = element.getAttribute(key) ?? ''
    element.removeAttribute(key)
    element.removeAttribute('xlink:href')
    if ((/^https?:\/\//i.test(target) && !(image && element.closest('svg'))) || (!image && /^(mailto:|tel:)/i.test(target))) {
      element.setAttribute(key, target)
      if (!image) { element.setAttribute('target', '_blank'); element.setAttribute('rel', 'noopener noreferrer') }
      continue
    }
    if (image && rasterData.test(target)) { element.setAttribute('src', target); continue }
    if (!image && target.startsWith('#')) { element.setAttribute('href', target); continue }
    const resolved = resolveReference(from, target)
    const file = resolved.kind === 'path' ? files.get(resolved.path) : undefined
    if (file && resolved.kind === 'path') {
      let fragment = resolved.fragment
      try { fragment = decodeURIComponent(fragment) } catch { /* Preserve literal malformed IDs. */ }
      if (!image && file.markdown !== undefined) {
        element.setAttribute('data-project-path', file.path + (fragment ? '#' + fragment : ''))
        element.setAttribute('href', '#doc=' + encodeURIComponent(file.path) + (fragment ? '&heading=' + encodeURIComponent(fragment) : ''))
        continue
      }
      if (file.dataUrl && (!image || /^data:image\//i.test(file.dataUrl))) {
        element.setAttribute('data-project-resource', file.path)
        if (!image) element.setAttribute('download', file.path.split('/').pop()!)
        continue
      }
    }
    if (image) element.setAttribute('alt', (element.getAttribute('alt') || '图片') + '（未共享图片）')
    else { element.classList.add('unshared'); element.append('（未共享引用）') }
  }
}

/** Fail closed before Mermaid's image-shape code or Graphviz can inspect any external resource. */
function diagramResourceIssue(source: string, dot: boolean): boolean {
  const decoded = document.createElement('textarea')
  decoded.innerHTML = source
  const value = decoded.value.replace(/\\[\r\n]+/g, '')
    // Plain formatting tags cannot load resources. All attributed/other HTML
    // remains blocked before the renderer's loose HTML-label path runs.
    .replace(/<\/?(?:br|b|strong|i|em)\s*\/?>/gi, '')
    // New Mermaid shapes with no additional properties are also resource-free.
    .replace(/@\s*\{\s*shape\s*:\s*(?:[a-z][\w-]*|"[a-z][\w-]*"|'[a-z][\w-]*')\s*\}/gi, '')
  if (/%%\s*\{|@\s*\{|^\s*---|<\s*[a-z!/?]/im.test(value)) return true
  const joined = value.replace(/["']\s*\+\s*["']/g, '')
  // Quoted label text cannot declare a resource. Preserve quoted DOT attribute
  // names before '=' so image="..." and "image"="..." share the same gate.
  const syntax = joined.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, (text, offset: number) =>
    /^\s*=/.test(joined.slice(offset + text.length)) ? text.slice(1, -1) : '""')
  return dot
    ? /\b(?:image|href|url|src|stylesheet|shapefile|fontpath|imagepath)\s*=/i.test(syntax)
    : /(?:^|;)\s*click\s+|@import|(?:url|image|image-set|cross-fade)\s*\(/im.test(syntax)
}

function diagramHasAbsoluteResource(source: string): boolean {
  const decoded = document.createElement('textarea')
  decoded.innerHTML = source
  const value = decoded.value.replace(/["']\s*\+\s*["']/g, '')
  const absolute = (target: string) => {
    let path = target.trim().replace(/^["']\s*/, '')
    try { path = decodeURIComponent(path) } catch { /* The resource gate still rejects malformed references. */ }
    return /^(?:file:|\/|[a-z]:[\\/])/i.test(path)
  }
  // Mask label/string values without changing offsets. Quoted attribute names
  // remain visible, so ordinary label="/Users/example" is not a resource.
  const syntax = value.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, (text, offset: number) =>
    /^\s*[:=]/.test(value.slice(offset + text.length)) ? ' ' + text.slice(1, -1) + ' ' : ' '.repeat(text.length))
  for (const match of syntax.matchAll(/\b(?:img|image|icon|href|url|src|stylesheet|shapefile|fontpath|imagepath)\s*[:=]/gi)) {
    if (absolute(value.slice(match.index! + match[0].length))) return true
  }
  for (const match of syntax.matchAll(/\b(?:url|image-set|image|cross-fade)\s*\(/gi)) {
    if (absolute(value.slice(match.index! + match[0].length))) return true
  }
  // HTML image labels are quoted strings in Mermaid, but contain actual src
  // declarations. Inspect those tags in an inert template before rendering.
  for (const tag of value.matchAll(/<[a-z][^>]*>/gi)) {
    const template = document.createElement('template'); template.innerHTML = tag[0]
    for (const element of Array.from(template.content.querySelectorAll('*'))) {
      if (['src', 'href', 'xlink:href'].some(key => absolute(element.getAttribute(key) ?? ''))) return true
      for (const match of (element.getAttribute('style') ?? '').matchAll(/\b(?:url|image-set|image|cross-fade)\s*\(([^)]*)/gi)) {
        if (absolute(match[1])) return true
      }
    }
  }
  return false
}

function namespaceSvg(root: HTMLElement, prefix: string): void {
  const ids = new Map<string, string>()
  let counter = 0
  for (const element of Array.from(root.querySelectorAll('[id]'))) {
    const old = element.id
    const next = prefix + counter++
    if (!ids.has(old)) ids.set(old, next)
    element.id = next
  }
  const replace = (value: string) => {
    for (const [old, next] of ids) value = value.replace(new RegExp('#' + old.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=[^\\w-]|$)', 'g'), '#' + next)
    return value
  }
  for (const element of Array.from(root.querySelectorAll('*'))) {
    for (const attr of Array.from(element.attributes)) {
      if (['aria-labelledby', 'aria-describedby'].includes(attr.name)) element.setAttribute(attr.name, attr.value.split(/\s+/).map(id => ids.get(id) ?? id).join(' '))
      else if (attr.name !== 'id') element.setAttribute(attr.name, replace(attr.value))
    }
    if (element.localName === 'style') element.textContent = replace(element.textContent ?? '')
  }
}

async function renderApprovedDocument(file: ProjectFile, files: Map<string, ProjectFile>, index: number, warnings: string[]): Promise<string> {
  const { frontmatter, body } = splitFrontmatter(file.markdown!)
  const html = await renderTabBody({ kind: /\.mdx$/i.test(file.path) ? 'mdx' : 'markdown', currentContent: body }, {
    sanitizeHtml: sanitizeRawToken, extensions: [wikiExtension(file.path, files)],
  })
  const root = document.createElement('div')
  // Frontmatter scalar values are escaped by the shared renderer. Prose regions
  // can contain HTML, so sanitize the complete generated metadata fragment too.
  root.innerHTML = (frontmatter === null ? '' : sanitize(frontmatterDetailsHtml(frontmatter, { sanitizeHtml: sanitizeRawToken }), true)) + sanitize(html, true)
  rewriteReferences(root, file.path, files)
  const blocks = Array.from(root.querySelectorAll<HTMLElement>('pre code.language-mermaid, pre code.language-dot, pre code.language-graphviz'))
  for (const [diagramIndex, code] of blocks.entries()) {
    const source = code.textContent ?? ''
    const pre = code.parentElement!
    const container = document.createElement('div')
    // Original Markdown is also bundled as the immutable feedback baseline.
    // Reject instead of redacting derived HTML while leaking the original path.
    if (diagramHasAbsoluteResource(source)) throw new Error(`${file.path}：图表 ${diagramIndex + 1} 包含本机绝对路径资源，请移除后分享。`)
    if (diagramResourceIssue(source, !code.classList.contains('language-mermaid'))) {
      const error = document.createElement('p'); error.className = 'renderer-error'; error.textContent = '图表资源未批准，未执行渲染。'
      pre.after(error)
      warnings.push(`${file.path}：图表 ${diagramIndex + 1} 含未批准资源，保留代码。`)
      continue
    }
    // Only the resource-checked code block enters the live shared diagram staging.
    container.innerHTML = sanitize(await renderDiagramsToString(pre.outerHTML), true)
    if (container.querySelector('.renderer-error') || !container.querySelector('svg')) {
      const error = document.createElement('p'); error.className = 'renderer-error'; error.textContent = '图表渲染失败，请检查以下源代码。'
      pre.before(error)
      warnings.push(`${file.path}：图表 ${diagramIndex + 1} 渲染失败，保留代码。`)
      continue
    }
    namespaceSvg(container, `project-d${index}-g${diagramIndex}-`)
    rewriteReferences(container, file.path, files)
    pre.replaceWith(...Array.from(container.childNodes))
  }
  const headings = new Map<string, number>()
  for (const heading of Array.from(root.querySelectorAll('h1,h2,h3,h4,h5,h6'))) {
    const base = (heading.textContent ?? '').trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s+/g, '-') || 'heading'
    const count = headings.get(base) ?? 0
    heading.id = base + (count ? '-' + count : '')
    headings.set(base, count + 1)
  }
  return sanitize(root.innerHTML, true)
}

export async function renderProjectPresentation(snapshot: ProjectSnapshot): Promise<ProjectPresentation> {
  const themeId = computeActiveThemeId(settings.theme, typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  let themeCss: string
  try { themeCss = await invoke<string>('theme_load_compiled', { id: themeId }) }
  catch { throw new Error(`无法加载当前主题「${themeId}」，项目分享未更新。`) }
  if (typeof themeCss !== 'string' || !themeCss.trim()) throw new Error(`当前主题「${themeId}」没有可用样式，项目分享未更新。`)
  const warnings: string[] = []
  const files = new Map(snapshot.files.map(file => [file.path, file]))
  const safeTheme = sanitizeCss(themeCss, warnings, files)
  // Local-only font families remain in the template's fallback chain; no host font is read.
  if (/font-family\s*:/i.test(safeTheme)) warnings.push('主题字体未随分享打包；访客缺少相应字体时使用模板的替代字体。')
  const styleHead = themedStyleHead(safeTheme, inlineMathCss()) + `<style>${FRONTMATTER_CSS}</style>`
  const documents: Record<string, string> = Object.create(null)
  for (const [index, file] of snapshot.files.entries()) {
    if (file.markdown !== undefined) documents[file.path] = await renderApprovedDocument(file, files, index, warnings)
  }
  return { themeId, styleHead, documents, warnings: [...new Set(warnings)] }
}
