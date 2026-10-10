/** @vitest-environment jsdom */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectSnapshot } from './types'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  theme: { light: 'effie', dark: 'default', followSystem: false },
  readFile: vi.fn(),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@tauri-apps/plugin-fs', () => ({ readFile: mocks.readFile }))
vi.mock('../settings.svelte', () => ({ settings: { theme: mocks.theme } }))
import { captureProjectTheme, renderProjectPresentation } from './presentation'
import * as sharedRenderer from '../plugins/host-render-html'
import { buildProjectBundle } from './bundle'

function snapshot(markdown: string): ProjectSnapshot {
  return { schemaVersion: 1, project_id: 'project', snapshotId: 'snapshot', entry: 'README.md', files: [
    { path: 'README.md', hash: 'a', bytes: markdown.length, markdown },
    { path: 'guide/next.md', hash: 'b', bytes: 8, markdown: '# 重复\n\n# 重复' },
    { path: 'img.png', hash: 'c', bytes: 1, dataUrl: 'data:image/png;base64,AA==' },
    { path: 'manual.pdf', hash: 'd', bytes: 1, dataUrl: 'data:application/pdf;base64,AA==' },
  ] }
}
beforeAll(() => {
  Object.defineProperty(SVGElement.prototype, 'getBBox', { configurable: true, value() { return { x: 0, y: 0, width: Math.max(40, (this.textContent ?? '').length * 8), height: 20 } } })
  Object.defineProperty(SVGElement.prototype, 'getComputedTextLength', { configurable: true, value() { return 80 } })
})
beforeEach(() => {
  mocks.invoke.mockReset().mockResolvedValue('[data-theme="effie"] .moraya-editor { color: teal; }')
  mocks.readFile.mockReset()
  mocks.theme.light = 'effie'
  mocks.theme.followSystem = false
})
describe('frozen project presentation', () => {
  it('freezes actual compiled CSS across entry and complete publication', async () => {
    const frozenTheme=await captureProjectTheme()
    mocks.theme.light='default'
    mocks.invoke.mockResolvedValue('different later CSS')
    mocks.invoke.mockClear()
    const result=await renderProjectPresentation(snapshot('# frozen'),{frozenTheme})
    expect(result.themeId).toBe('effie')
    expect(result.styleHead).toContain('color: teal')
    expect(result.styleHead).not.toContain('different later CSS')
    expect(mocks.invoke).not.toHaveBeenCalled()
  })
  it('uses the built-in default theme when the current-theme option is disabled', async () => {
    mocks.theme.light = 'effie'
    const result = await renderProjectPresentation(snapshot('# default'), { useCurrentTheme: false })
    expect(result.themeId).toBe('default')
    expect(mocks.invoke).toHaveBeenCalledWith('theme_load_compiled', { id: 'default' })
    expect(mocks.theme.light).toBe('effie')
  })
  it('embeds actual dependency fonts when Vite root is outside the project', async () => {
    const { execFile } = await import('node:child_process')
    const { resolve } = await import('node:path')
    const entry = resolve('src/lib/project-share/presentation.ts')
    // Run in Node's own realm: jsdom's Uint8Array breaks esbuild's invariant.
    // This executes real Vite glob/asset plugins without a mocked font map.
    const script = `
      import { build } from 'vite';
      import { mkdtemp, rm } from 'node:fs/promises';
      import { tmpdir } from 'node:os';
      const entry = process.argv[1];
      const root = await mkdtemp(tmpdir() + '/project-presentation-fonts-');
      try {
        const result = await build({ configFile: false, root, logLevel: 'silent', build: {
          write: false, minify: false, lib: { entry, formats: ['es'] },
          rollupOptions: { external: id => id !== entry && !id.includes('katex/dist/fonts/') }
        } });
        const output = Array.isArray(result) ? result.flatMap(bundle => bundle.output) : result.output;
        const code = output.filter(item => item.type === 'chunk').map(item => item.code).join('\\n');
        process.stdout.write(JSON.stringify({ ams: code.includes('../../../node_modules/katex/dist/fonts/KaTeX_AMS-Regular.woff2'), fonts: code.split('data:font/woff2;base64,').length - 1 }));
      } finally { await rm(root, { recursive: true, force: true }); }
    `
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(process.execPath, ['--input-type=module', '-e', script, entry], (error, stdout) => error ? reject(error) : resolve(stdout))
    })
    expect(JSON.parse(stdout)).toEqual({ ams: true, fonts: 20 })
  }, 30000)
  it('uses current compiled theme and shared GFM, math, highlight and frontmatter rendering', async () => {
    const result = await renderProjectPresentation(snapshot('---\ntitle: 元数据\n---\n# 正文\n\nfirst\nsecond\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n- [x] 完成\n\n$x^2$\n\n```js\nconst answer = 42\n```\n\n{==重点==}{>>说明<<}'))
    expect(result.themeId).toBe('effie')
    expect(mocks.invoke).toHaveBeenCalledWith('theme_load_compiled', { id: 'effie' })
    expect(result.styleHead).toContain('color: teal')
    const html = result.documents['README.md']
    for (const marker of ['frontmatter-details', '<table>', 'checkbox', 'first<br>second', 'katex', '<math', 'hljs-keyword', 'crit-badge']) expect(html).toContain(marker)
    expect(result.styleHead).toContain('data:font/woff2;base64,')
    expect(result.styleHead).not.toContain('url(fonts/')
    expect(result.documents['guide/next.md']).toContain('id="重复-1"')
    mocks.theme.light = 'default'
    expect((await renderProjectPresentation(snapshot('# next'))).themeId).toBe('default')
  })
  it('sanitizes raw HTML before it can impersonate generated structures or load resources', async () => {
    const result = await renderProjectPresentation(snapshot('<script>alert(1)</script><svg><image href="http://localhost:9999/canary"/></svg>\n<div class="katex" style="position:fixed" id="forged" onclick="evil()">保留文字</div>\n<img src="/Users/bruce/private.png" onerror="evil()">\n<a href="javascript:evil()">bad</a>'))
    const html = result.documents['README.md']
    expect(html).toContain('保留文字')
    for (const bad of ['<script', '<svg', 'onerror=', 'onclick=', 'position:fixed', 'id="forged"', 'class="katex"', '/Users/', 'localhost', 'javascript:']) expect(html).not.toContain(bad)
    expect(mocks.readFile).not.toHaveBeenCalled()
  })
  it('also sanitizes raw HTML in frontmatter prose before preserving generated metadata classes', async () => {
    const result = await renderProjectPresentation(snapshot('---\ntitle: 安全\n\n<div class="katex" id="forged" style="position:fixed">元数据文字</div>\n<img src="http://example.test/safe.png" onerror="evil()">\n---\n# 正文'))
    const html = result.documents['README.md']
    expect(html).toContain('frontmatter-details')
    expect(html).toContain('元数据文字')
    expect(html).not.toContain('class="katex"')
    expect(html).not.toContain('id="forged"')
    expect(html).not.toContain('onerror=')
    expect(html).not.toContain('position:fixed')
  })
  it('preserves safe inline raw HTML boundaries after stripping unsafe attributes', async () => {
    const result = await renderProjectPresentation(snapshot('<b class="forged" onclick="evil()">加粗</b> 和 <a href="guide/next.md" style="position:fixed">下一篇</a>'))
    const root = document.createElement('div'); root.innerHTML = result.documents['README.md']
    expect(root.querySelector('b')?.textContent).toBe('加粗')
    expect(root.querySelector('a[data-project-path="guide/next.md"]')?.textContent).toBe('下一篇')
    expect(root.innerHTML).not.toMatch(/forged|onclick|position:fixed/)
  })
  it('retains approved references without duplicating their bytes and marks missing references', async () => {
    const result = await renderProjectPresentation(snapshot('![批准](img.png)\n\n![缺图](../private.png)\n\n[下一篇](guide/next.md#重复) [[next]] [附件](manual.pdf) [未分享](hidden.md)'))
    const html = result.documents['README.md']
    expect(html).toContain('data-project-resource="img.png"')
    expect(html).toContain('data-project-path="guide/next.md#重复"')
    expect(html).toContain('data-project-path="guide/next.md"')
    expect(html).toContain('data-project-resource="manual.pdf"')
    expect(html).toContain('download="manual.pdf"')
    expect(html).toContain('未共享引用')
    expect(html).not.toContain('base64,AA==')
    expect(mocks.readFile).not.toHaveBeenCalled()
  })
  it('renders real diagrams with namespaced SVG markers and preserves errors with source', async () => {
    const result = await renderProjectPresentation(snapshot('```mermaid\nflowchart LR\n A[开始] --> B[结束]\n```\n\n```dot\ndigraph G { a -> b [label="标签"] }\n```\n\n```mermaid\nnot valid mermaid\n```'))
    const root = document.createElement('div'); root.innerHTML = result.documents['README.md']
    expect(root.querySelectorAll('svg')).toHaveLength(2)
    expect(root.querySelector('path[marker-end]')).not.toBeNull()
    expect(root.textContent).toContain('开始')
    expect(root.textContent).toContain('标签')
    expect(root.textContent).toContain('not valid mermaid')
    expect(result.warnings.some(w => w.includes('图表'))).toBe(true)
    const ids = Array.from(root.querySelectorAll('[id]')).map(n => n.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.every(id => id.startsWith('project-d0-'))).toBe(true)
  }, 30000)
  it('blocks renderer resource declarations before any renderer can fetch them', async () => {
    const image = vi.fn()
    vi.stubGlobal('Image', image)
    try {
      const result = await renderProjectPresentation(snapshot('```mermaid\nflowchart LR\n A@{ img: "http://localhost:9999/canary.png" }\n```\n\n```dot\ndigraph G { a [image="https://example.test/private.png"] }\n```'))
      expect(image).not.toHaveBeenCalled()
      expect(result.documents['README.md']).not.toContain('<svg')
      expect(result.documents['README.md']).toContain('图表资源')
      expect(result.documents['README.md']).not.toContain('/Users/bruce')
      expect(mocks.readFile).not.toHaveBeenCalled()
    } finally { vi.unstubAllGlobals() }
  })
  it('refuses publication before the bundle can expose absolute host paths in original diagram Markdown', async () => {
    for (const source of ['digraph G { a [image="/Users/bruce/private.png"] }', 'digraph G { a [image="/secret/project.png"] }', 'digraph G { a [image="file:///private/project.png"] }', 'digraph G { a [image="C:\\private\\project.png"] }']) {
      const frozen = snapshot('```dot\n' + source + '\n```')
      const before = JSON.stringify(frozen)
      let bundle: string | undefined
      await expect((async () => {
        const presentation = await renderProjectPresentation(frozen)
        bundle = buildProjectBundle(frozen, 'https://example.test/feedback', { presentation })
      })()).rejects.toThrow(/图表.*本机绝对路径/)
      expect(bundle).toBeUndefined()
      expect(JSON.stringify(frozen)).toBe(before)
      expect(mocks.readFile).not.toHaveBeenCalled()
    }
    for (const source of ['A@{ img: "file:///Users/bruce/private.png" }', 'A["<img src=\'/Users/bruce/private.png\'/>"]', 'A --> B\nclassDef default fill:url("/Users/bruce/private.png")', 'A["<b style=\'background:url(/Users/bruce/private.png)\'>test</b>"]']) {
      await expect(renderProjectPresentation(snapshot('```mermaid\nflowchart LR\n' + source + '\n```'))).rejects.toThrow(/图表.*本机绝对路径/)
    }
  })
  it('renders safe Mermaid HTML labels and plain shape declarations', async () => {
    const result = await renderProjectPresentation(snapshot('```mermaid\nflowchart LR\n A["<b>开始</b><br/>第二行"] --> B@{ shape: rect }\n```'))
    expect(result.documents['README.md']).toContain('<svg')
    expect(result.documents['README.md']).toContain('开始')
    expect(result.documents['README.md']).toContain('第二行')
    expect(result.warnings.filter(w => w.includes('图表'))).toHaveLength(0)
  })
  it('allows URLs and resource-like words used only as diagram label text', async () => {
    const result = await renderProjectPresentation(snapshot('```mermaid\nsequenceDiagram\n A->>B: GET https://example.com /Users/example\n```\n\n```mermaid\nflowchart LR\n A["image: recognition"] --> B[done]\n```\n\n```dot\ndigraph G { a [label="https://example.com /Users/example"]; a -> b }\n```'))
    const root = document.createElement('div'); root.innerHTML = result.documents['README.md']
    expect(root.querySelectorAll('svg')).toHaveLength(3)
    expect(result.warnings.filter(w => w.includes('图表'))).toHaveLength(0)
  })
  it('cleans generated SVG active content and external resources while retaining local definitions', async () => {
    const renderer = vi.spyOn(sharedRenderer, 'renderDiagramsToString').mockResolvedValue('<svg viewBox="0 0 100 50" aria-labelledby="label"><title id="label">安全图</title><defs><marker id="arrow"><path d="M0 0L1 1"/></marker></defs><style>#label { fill: red; } @import "https://canary.test/style";</style><path marker-end="url(#arrow)" d="M0 0L90 40" onclick="evil()"/><use href="https://canary.test/image.svg#x"/><image href="file:///Users/bruce/private.png"/><foreignObject><div><img src="https://canary.test/img.png" onerror="evil()"><iframe src="https://canary.test/frame"></iframe>标签</div></foreignObject><script>evil()</script></svg>')
    try {
      const result = await renderProjectPresentation(snapshot('```mermaid\nflowchart LR\n A --> B\n```'))
      const html = result.documents['README.md']
      expect(html).toContain('<marker')
      expect(html).toContain('url(#project-d0-g0-')
      expect(html).toContain('aria-labelledby="project-d0-g0-')
      expect(html).toContain('标签')
      for (const bad of ['canary.test', 'onerror=', 'onclick=', '<script', '<iframe', '/Users/', '<image']) expect(html).not.toContain(bad)
    } finally { renderer.mockRestore() }
  })
  it('removes unsafe CSS dependencies and closure boundaries, and reports font fallback', async () => {
    mocks.invoke.mockResolvedValue('@import url("https://font.example/style.css"); @font-face { font-family: Custom; src: local("PrivateFont"); } [data-theme="effie"] .moraya-editor { background:url(file:///Users/bruce/private.png); border-image: image-set("https://canary.test/image.png" 1x); color:teal; } /* </style><script>evil()</script> */')
    const result = await renderProjectPresentation(snapshot('# safe'))
    for (const bad of ['@import', 'file://', '/Users/', 'font.example', 'canary.test', '<script>', 'local(']) expect(result.styleHead).not.toContain(bad)
    expect(result.styleHead).toContain('color:teal')
    expect(result.warnings.some(w => /字体/.test(w))).toBe(true)
  })
  it('fails if the selected compiled template cannot be loaded', async () => {
    mocks.invoke.mockRejectedValue(new Error('missing theme'))
    await expect(renderProjectPresentation(snapshot('# test'))).rejects.toThrow(/主题/)
  })
})
