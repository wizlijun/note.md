// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from 'vitest'
import * as pele from 'pele'
import { renderPeleSvg as render } from './pele-renderer'

vi.mock('pele', { spy: true })
// jsdom has no canvas; exercise Pele's own non-canvas text measurement fallback.
beforeAll(() => { vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null) })

const flow = 'flowchart LR\n A[中文开始] --> B[处理数据] --> C[完成]'
const dark = { theme: 'dark' as const, themeVariables: { primaryColor: '#123456', primaryTextColor: '#eeeeee', primaryBorderColor: '#abcdef', lineColor: '#fedcba', secondaryColor: '#234567', tertiaryColor: '#345678' } }
function svg(source: string) { return new DOMParser().parseFromString(source, 'image/svg+xml').documentElement }

describe('shared Pele renderer', () => {
  it.each([
    [flow, '中文开始'],
    ['quadrantChart\n title 中文象限\n x-axis 低 --> 高\n y-axis 少 --> 多\n quadrant-1 优先\n 项目: [0.7, 0.8]', '中文象限'],
    ['C4Context\n title 中文系统\n Person(user, "用户", "使用者")\n System(system, "笔记系统", "内容")\n Rel(user, system, "使用")', '笔记系统'],
  ])('renders real supported source %s', (code, label) => {
    const root = svg(render(code))
    expect(root.localName).toBe('svg')
    expect(root.getAttribute('viewBox')).toBeTruthy()
    expect(root.textContent).toContain(label)
  })
  it('uses available width for layout', () => {
    const wide = svg(render(flow, { maxWidth: 800 }))
    const narrow = svg(render(flow, { maxWidth: 180 }))
    expect(narrow.getAttribute('viewBox')).not.toBe(wide.getAttribute('viewBox'))
  })
  it('retains safe authored style', () => {
    expect(render('flowchart TD\n A[Styled]\n style A fill:#ff0000,stroke:#00ff00')).toContain('#ff0000')
  })
  it('throws syntax errors and default source and edge limits', () => {
    expect(() => render('this is not a diagram <script>')).toThrow()
    expect(() => render(`flowchart TD\n A[${'x'.repeat(50_000)}]`)).toThrow(/limit/i)
    expect(() => render('flowchart TD\n' + Array.from({length:5001}, (_, i) => `A-->B${i}`).join('\n'))).toThrow(/limit|edges/i)
  })
  it('freezes all theme colors and fonts for a detached dark SVG', () => {
    const root = svg(render(flow, { appearance: dark }))
    const style = root.getAttribute('style')!
    for (const color of Object.values(dark.themeVariables)) expect(style).toContain(color)
    expect(style).toMatch(/--pele-bg:\s*#(?:1e1e1e|18181b)/)
    expect(style).toContain('--pele-fg:')
    expect(style).toContain('--pele-font:')
    expect(style).toContain('sans-serif')
    expect(style).not.toMatch(/--pele-bg:\s*#123456/)
  })
  it.each([false, true])('separates chart series from neutral surfaces (dark=%s)', isDark => {
    const appearance = { ...dark, theme: isDark ? 'dark' as const : 'default' as const }
    const root = svg(render('pie title 分类\n "第一" : 60\n "第二" : 40', { appearance })) as unknown as SVGElement
    expect(root.style.getPropertyValue('--pele-surface')).toBe(dark.themeVariables.secondaryColor)
    expect(root.style.getPropertyValue('--pele-surface-alt')).toBe(dark.themeVariables.tertiaryColor)
    const series = Array.from({ length: 8 }, (_, i) => root.style.getPropertyValue(`--pele-series-${i + 1}`))
    expect(series[0]).toBe(dark.themeVariables.primaryColor)
    expect(new Set(series).size).toBe(8)
    expect(series).not.toContain(dark.themeVariables.secondaryColor)
    expect(series).not.toContain(dark.themeVariables.tertiaryColor)
  })
  it.each([
    ['sequence with frames', 'sequenceDiagram\n participant A as 客户\n participant B as 服务\n alt 已授权\n A->>B: 保存\n else 拒绝\n B-->>A: 提示\n end', '--_hw', '--pele-heading-weight'],
    ['class', 'classDiagram\n class Note {\n +String title\n +save()\n }', '--_hw', '--pele-heading-weight'],
    ['titled pie', 'pie title 资源分布\n "文档" : 60\n "附件" : 40', '--_tw', '--pele-title-weight'],
    ['titled C4', 'C4Context\n title 知识系统\n Person(user, "用户")\n System(app, "笔记")\n Rel(user, app, "编辑")', '--_tw', '--pele-title-weight'],
    ['bold label', 'flowchart LR\n A["`**强调**文本`"] --> B[完成]', '--_w', '--pele-bold-weight'],
  ])('preserves root theme aliases for %s in a detached dark SVG', (_name, code, alias, weight) => {
    const root = svg(render(code, { appearance: dark })) as unknown as SVGElement
    expect(root.style.getPropertyValue('--_fg')).toContain('--pele-fg')
    expect(root.style.getPropertyValue('--_s')).toContain('--pele-surface')
    expect(root.style.getPropertyValue(alias)).toContain(weight)
    expect(root.style.getPropertyValue(weight)).toBe('bold')
    expect(root.style.color).toBe('var(--_fg)')
    expect(root.style.fontFamily).toContain('--pele-font')
    expect(root.style.getPropertyValue('--pele-fg')).toBe('#eeeeee')
  })
  it.each(['title', 'heading', 'bold'])('prevents the %s weight from inheriting a resource paint', name => {
    const variable = `--pele-${name}-weight`
    const spy = vi.spyOn(pele, 'render').mockReturnValue({ type: 'flowchart', width: 10, height: 10, links: [],
      svg: `<svg xmlns="http://www.w3.org/2000/svg" style="${variable}:inherit!important"><rect width="10" height="10" fill="var(${variable})"/></svg>` })
    try {
      const root = svg(render(flow)) as unknown as SVGElement
      expect(root.style.getPropertyValue(variable)).toBe('bold')
      expect(root.style.getPropertyPriority(variable)).toBe('')
      expect(root.querySelector('rect:not([aria-hidden])')?.getAttribute('fill')).toBe(`var(${variable})`)
    } finally { spy.mockRestore() }
  })
  it.each([
    'var(--pele-title-weight,url(https://evil.test/paint))',
    'var(--pele-heading-weight,var(--hostile-paint))',
    'var(--pele-bold-weight-resource)',
  ])('rejects unsafe resources or unknown variables around weight paints: %s', fill => {
    const spy = vi.spyOn(pele, 'render').mockReturnValue({ type: 'flowchart', width: 10, height: 10, links: [],
      svg: `<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10" fill="${fill}"/></svg>` })
    try {
      const result = render(flow), root = svg(result)
      expect(root.querySelector('rect:not([aria-hidden])')?.hasAttribute('fill')).toBe(false)
      expect(result).not.toMatch(/evil\.test|hostile-paint|weight-resource/)
    } finally { spy.mockRestore() }
  })
  it('renders with unique IDs when Safari 15 has no randomUUID', () => {
    const original = Object.getOwnPropertyDescriptor(crypto, 'randomUUID')
    Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined })
    try {
      const code = flow + '\n accTitle: Accessible title'
      const one = svg(render(code)), two = svg(render(code))
      const ids = [...one.querySelectorAll('[id]')].map(el => el.id)
      expect(one.textContent).toContain('中文开始')
      expect(ids.length).toBeGreaterThan(0)
      expect([...two.querySelectorAll('[id]')].every(el => !ids.includes(el.id))).toBe(true)
    } finally {
      if (original) Object.defineProperty(crypto, 'randomUUID', original)
      else Reflect.deleteProperty(crypto, 'randomUUID')
    }
  })
  it('creates unique accessible IDs and preserves local references', () => {
    const code = flow + '\n accTitle: Accessible title\n accDescr: Diagram description'
    const one = svg(render(code)), two = svg(render(code))
    const ids = [...one.querySelectorAll('[id]')].map(el => el.id)
    expect(ids.length).toBeGreaterThan(0)
    expect(ids.some(id => [...two.querySelectorAll('[id]')].some(el => el.id === id))).toBe(false)
    for (const el of one.querySelectorAll('*')) for (const attr of el.attributes) {
      for (const match of attr.value.matchAll(/url\(#([^)]*)\)/g)) expect(ids).toContain(match[1])
    }
    expect(one.textContent).toContain('Accessible title')
    expect(ids).toContain(one.getAttribute('aria-labelledby'))
    expect(ids).toContain(one.getAttribute('aria-describedby'))
  })
  it('disables links by default and permits safe trusted opt-in', () => {
    const code = 'flowchart TD\n A[Site]\n click A "https://example.com" "Open"'
    expect(svg(render(code)).querySelector('a')).toBeNull()
    expect(svg(render(code, { links: true })).querySelector('a')?.getAttribute('href')).toBe('https://example.com/')
  })
  it('filters hostile generated output and preserves local SVG references', () => {
    const spy = vi.spyOn(pele, 'render').mockReturnValue({type:'flowchart', width:10, height:10, links:[], svg:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><style>@import 'https://evil.test/a'; .x {fill:url(https://evil.test/b)}</style><script>alert(1)</script><image href="https://evil.test/c"/><foreignObject>bad</foreignObject><defs><marker id="safe"><path d="M0 0"/></marker></defs><path marker-end="url(#safe)" style="fill:url(https://evil.test/d)"/><use href="https://evil.test/e#id"/><a href="javascript:alert(1)">bad</a></svg>`})
    try {
      const result = render(flow)
      const root = svg(result)
      expect(root.querySelector('style, script, image, foreignObject, a')).toBeNull()
      expect(result).not.toContain('evil.test')
      const marker = root.querySelector('marker')!
      expect(root.querySelector('[marker-end]')?.getAttribute('marker-end')).toBe(`url(#${marker.id})`)
      expect(spy.mock.calls[0][1]).toMatchObject({images:false, links:false, limit:50000, outputLimit:4000000, maxEdges:5000})
      expect(spy.mock.calls[0][1]?.icons).toBeUndefined()
    } finally { spy.mockRestore() }
  })
  it('rejects generated output above the output budget', () => {
    const spy = vi.spyOn(pele, 'render').mockReturnValue({type:'flowchart', width:10, height:10, links:[], svg:`<svg xmlns="http://www.w3.org/2000/svg"><text>${'x'.repeat(4_000_000)}</text></svg>`})
    try { expect(() => render(flow)).toThrow(/output.*limit/i) } finally { spy.mockRestore() }
  })
  it('rejects CSS resource functions even when they omit url()', () => {
    const spy = vi.spyOn(pele, 'render').mockReturnValue({type:'flowchart', width:10, height:10, links:[], svg:`<svg xmlns="http://www.w3.org/2000/svg"><rect style='background:image-set("relative.png" 1x)'/></svg>`})
    try { expect(render(flow)).not.toContain('relative.png') } finally { spy.mockRestore() }
  })
  it('prevents inherited CSS variables from supplying external resources', () => {
    const spy = vi.spyOn(pele, 'render').mockReturnValue({type:'flowchart', width:10, height:10, links:[], svg:`<svg xmlns="http://www.w3.org/2000/svg"><rect fill="var(--hostile-paint)"/></svg>`})
    try { expect(render(flow)).not.toContain('--hostile-paint') } finally { spy.mockRestore() }
  })
  it('suppresses external resources, images, scripts and unsafe style', () => {
    const result = render('flowchart TD\n A["<img src=https://evil.test/a onerror=alert(1)>"]\n B@{ img: "https://evil.test/b", label: "Photo" }\n A-->B\n click A "javascript:alert(1)"', {links:true})
    const root = svg(result)
    expect(root.querySelector('image, script, foreignObject, img')).toBeNull()
    expect(root.querySelector('[href^="javascript:"], [href^="https://evil.test"]')).toBeNull()
    expect(result).not.toMatch(/url\([^#)]|@import/i)
  })
})
