import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const publicDir = join(__dirname, '..', 'public')
const blogPath = 'blog/personal-ai-memory/index.html'
const locales = [
  { lang: 'en', prefix: '', home: 'index.html' },
  { lang: 'de', prefix: '/de', home: 'de/index.html' },
  { lang: 'ja', prefix: '/ja', home: 'ja/index.html' },
  { lang: 'zh', prefix: '/zh', home: 'zh/index.html' },
]

const readTextTree = (dir: string): string =>
  readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.name !== '__pycache__')
    .map((entry) => {
      const path = join(dir, entry.name)
      return entry.isDirectory() ? readTextTree(path) : readFileSync(path, 'utf8')
    })
    .join('\n')

describe('Memory product thesis content', () => {
  it.each(locales)('links the $lang homepage to its localized Memory essay', ({ prefix, home }) => {
    const html = readFileSync(join(publicDir, home), 'utf8')
    expect(html).toContain(`href="${prefix}/blog/personal-ai-memory/"`)
    expect(html).toMatch(/<span class="n">05<\/span>/)
  })

  it.each(locales)('publishes a complete $lang essay with language alternates', ({ lang, prefix }) => {
    const html = readFileSync(join(publicDir, prefix.slice(1), blogPath), 'utf8')
    expect(html).toContain(`<html lang="${lang}">`)
    expect(html).toContain('"@type": "BlogPosting"')
    expect(html).toContain('<main><article class="wrap">')
    expect(html.match(/<h2>/g)?.length).toBeGreaterThanOrEqual(10)
    expect(html.match(/<table>/g)?.length).toBeGreaterThanOrEqual(3)
    expect(html).toContain(`rel="canonical" href="https://notemd.net${prefix}/blog/personal-ai-memory/"`)
    for (const locale of locales) {
      expect(html).toContain(
        `hreflang="${locale.lang}" href="https://notemd.net${locale.prefix}/blog/personal-ai-memory/"`,
      )
    }
    expect(html).toContain('83')
    expect(html).toContain('27')
    expect(html).toContain('56')
  })

  it('lists every localized essay URL in the sitemap', () => {
    const sitemap = readFileSync(join(publicDir, 'sitemap.xml'), 'utf8')
    const urls = Array.from(sitemap.matchAll(/<loc>([^<]+)<\/loc>/g), (match) => match[1])
    expect(urls).toHaveLength(56)
    expect(new Set(urls).size).toBe(56)
    for (const url of urls) {
      const path = new URL(url).pathname
      const file = path === '/' ? 'index.html' : `${path.slice(1)}index.html`
      expect(existsSync(join(publicDir, file)), `${url} should have a generated page`).toBe(true)
    }
    for (const locale of locales) {
      expect(sitemap).toContain(`<loc>https://notemd.net${locale.prefix}/blog/personal-ai-memory/</loc>`)
    }
  })

  it('does not describe the shipped Memory system as roadmap work', () => {
    const readme = readFileSync(join(__dirname, '..', '..', 'README.md'), 'utf8')
    const readmeZh = readFileSync(join(__dirname, '..', '..', 'README.zh-CN.md'), 'utf8')
    expect(readme).not.toContain('A memory system is on the roadmap')
    expect(readmeZh).not.toContain('记忆系统在路上')
  })
})

describe('Agent-ready and token pricing copy', () => {
  const homepageClaims = [
    {
      home: 'index.html',
      headline: 'Agent-ready by design.<br>Use the AI you already have.',
      billing: 'note.md sells no tokens, adds no token markup, and charges no separate per-token fee.',
    },
    {
      home: 'de/index.html',
      headline: 'Von Grund auf Agent-ready.<br>Mit der KI, die du schon nutzt.',
      billing: 'note.md verkauft keine Tokens, schlägt nichts auf Tokenpreise auf und berechnet keine separate Tokengebühr.',
    },
    {
      home: 'ja/index.html',
      headline: 'AIエージェントを前提に設計。<br>いつものAIを、そのまま。',
      billing: 'note.md 独自のトークン販売、価格上乗せ、従量課金はありません。',
    },
    {
      home: 'zh/index.html',
      headline: '为 AI Agent 原生设计。<br>用你已经在用的 AI。',
      billing: 'note.md 不另售 Token，不对 Token 加价，也不另收一份按 Token 计费的使用费。',
    },
  ]

  it.each(homepageClaims)('states the Agent-ready promise accurately on $home', ({ home, headline, billing }) => {
    const html = readFileSync(join(publicDir, home), 'utf8')
    expect(html).toContain(headline)
    expect(html).toContain(billing)
  })

  it('explains the token boundary to agents without claiming zero model usage', () => {
    const llms = readFileSync(join(publicDir, 'llms.txt'), 'utf8')
    const full = readFileSync(join(publicDir, 'llms-full.txt'), 'utf8')
    for (const content of [llms, full]) {
      const normalized = content.replace(/\s+/g, ' ')
      expect(normalized).toContain('note.md includes agent-ready workflows, but it is not an AI model or token provider.')
      expect(normalized).toContain('Model usage may still consume the user\'s provider allowance')
    }
  })

  it('removes obsolete No-AI and zero-token claims from public copy and its generators', () => {
    const repositoryCopy = [
      'README.md',
      'README.zh-CN.md',
      'CLAUDE.md',
      'docs/FEATURES.md',
      'docs/FEATURES.zh-CN.md',
      'website/build_i18n.py',
      'website/build_pages.py',
      'website/i18n/pages_de.py',
      'website/i18n/pages_ja.py',
      'website/i18n/pages_zh.py',
    ]
      .map((path) => readFileSync(join(__dirname, '..', '..', path), 'utf8'))
      .join('\n')
    const copy = `${repositoryCopy}\n${readTextTree(publicDir)}`
    const obsoleteClaims = [
      'No AI inside',
      'ships no AI features of its own',
      'calls no model',
      'no API tokens, no rate limits',
      '不带 AI',
      '不连模型',
      '不会调用任何模型',
      '不要 API token，不限速',
      'Keine KI eingebaut',
      'Ruft kein Modell auf',
      'ruft selbst kein Modell auf',
      'keine API-Tokens, keine Rate-Limits',
      'AI は入っていない',
      'モデルを呼ばない',
      'モデルを呼び出したり',
      'API トークンなし、レートリミットなし',
    ]
    for (const claim of obsoleteClaims) expect(copy).not.toContain(claim)
  })
})

describe('current workspace content coverage', () => {
  const recentHeadings = [
    { home: 'index.html', heading: 'Explore the workspace', view: 'Knowledge Browser' },
    { home: 'de/index.html', heading: 'Den Arbeitsraum entdecken', view: 'Knowledge Browser' },
    { home: 'ja/index.html', heading: 'ワークスペースを探索', view: 'Knowledge Browser' },
    { home: 'zh/index.html', heading: '探索工作空间', view: '知识浏览器' },
  ]

  it.each(recentHeadings)('shows current shipped capabilities on $home', ({ home, heading, view }) => {
    const html = readFileSync(join(publicDir, home), 'utf8')
    expect(html).toContain(heading)
    for (const capability of ['Smart Lookup', 'JSON Canvas', view]) {
      expect(html).toContain(capability)
    }
  })

  it('documents the shipped local MCP and current share command', () => {
    const full = readFileSync(join(publicDir, 'llms-full.txt'), 'utf8')
    expect(full).toContain('notemd mcp')
    expect(full).toContain('read-only `search` and `vault_info`')
    expect(full).toContain('notemd share draft.md')
    expect(full).not.toContain('notemd -s')
    expect(full).not.toContain('Vault MCP server (`vault_search`')
  })

  it('removes reviewed stale website claims', () => {
    const websiteCopy = [
      readFileSync(join(__dirname, '..', 'build_i18n.py'), 'utf8'),
      readFileSync(join(__dirname, '..', 'build_pages.py'), 'utf8'),
      readTextTree(join(__dirname, '..', 'i18n')),
      readTextTree(publicDir),
    ].join('\n')
    for (const stale of [
      'notemd -s',
      'on the roadmap, converter available',
      'Famously quiet since ~2021',
      'every save is a commit',
      'Sync-to-Vault plugin',
      'structurally identical to a note.md vault',
      'Notion and Typora themes',
      '~15 MB',
    ]) {
      expect(websiteCopy).not.toContain(stale)
    }
  })
})

describe('localized navigation and social metadata', () => {
  it.each(locales.filter(({ lang }) => lang !== 'en'))('keeps $lang internal page links localized', ({ prefix }) => {
    const html = readTextTree(join(publicDir, prefix.slice(1)))
      .replace(/<div class="lang-sw"[^>]*>[\s\S]*?<\/div>/g, '')
    for (const segment of ['compare', 'integrations', 'guides', 'blog', 'orchestrate-agents']) {
      expect(html).not.toContain(`href="/${segment}/`)
    }
  })

  it('adds Open Graph and Twitter metadata to every generated HTML page', () => {
    const visit = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name)
      return entry.isDirectory() ? visit(path) : entry.name.endsWith('.html') ? [path] : []
    })
    const pages = visit(publicDir)
    expect(pages).toHaveLength(56)
    for (const page of pages) {
      const html = readFileSync(page, 'utf8')
      expect(html, page).toContain('<meta property="og:title"')
      expect(html, page).toContain('<meta property="og:description"')
      expect(html, page).toContain('<meta property="og:url"')
      expect(html, page).toContain('<meta name="twitter:card" content="summary">')
      const route = page.slice(publicDir.length).replaceAll('\\', '/').replace(/index\.html$/, '')
      const baseRoute = route.replace(/^\/(de|ja|zh)(?=\/)/, '')
      const switcher = html.match(/<div class="lang-sw"[^>]*>([\s\S]*?)<\/div>/)?.[1]
      expect(switcher, page).toBeDefined()
      const languageLinks = Array.from(switcher!.matchAll(/href="([^"]+)"/g), (match) => match[1])
      expect(languageLinks, page).toEqual(locales.map((locale) => `${locale.prefix}${baseRoute}`))
      expect(html, page).toContain(`rel="canonical" href="https://notemd.net${route}"`)
      for (const locale of locales) {
        expect(html, page).toContain(`hreflang="${locale.lang}" href="https://notemd.net${locale.prefix}${baseRoute}"`)
      }
    }
  })
})

describe('Linux beta download links', () => {
  it.each(locales)('offers explicit native package choices on the $lang homepage', ({ home }) => {
    const html = readFileSync(join(publicDir, home), 'utf8')
    expect(html).toContain('href="/download?os=linux&amp;format=deb&amp;arch=x86_64"')
    expect(html).toContain('href="/download?os=linux&amp;format=deb&amp;arch=aarch64"')
    expect(html).toContain('href="/download?os=linux&amp;format=arch&amp;arch=x86_64"')
    expect(html).toContain('href="/download?os=linux&amp;format=arch&amp;arch=aarch64"')
    expect(html).not.toContain('Debian 12 / Omarchy')
    expect(html).not.toMatch(/href="[^"]*releases\/latest\/download\/[^"]*\.deb/)
  })
})

describe('external agent file collaboration', () => {
  it.each(locales)('keeps $lang file collaboration without advertising the removed chat plugin', ({ prefix }) => {
    const html = readFileSync(join(publicDir, prefix.slice(1), 'integrations/openclaw/index.html'), 'utf8')
    expect(html).toContain('AGENTS.md')
    expect(html).toContain('research/topic.md')
    expect(html).not.toMatch(/OpenClaw[ -]Chat/i)
  })

  it('keeps generators free of the removed plugin installation copy', () => {
    const generators = [
      readFileSync(join(__dirname, '..', 'build_pages.py'), 'utf8'),
      readTextTree(join(__dirname, '..', 'i18n')),
    ].join('\n')
    expect(generators).not.toMatch(/OpenClaw[ -]Chat/i)
  })
})

describe('maintained public copy', () => {
  it.each([
    { prefix: '', scope: 'dependencies have their own licenses' },
    { prefix: 'zh', scope: '依赖项遵循各自许可证' },
    { prefix: 'de', scope: 'Abhängigkeiten haben eigene Lizenzen' },
    { prefix: 'ja', scope: '依存関係にはそれぞれのライセンスが適用されます' },
  ])('scopes Apache-2.0 to repository sources in $prefix public copy', ({ prefix, scope }) => {
    for (const page of ['index.html', 'compare/roam-research/index.html']) {
      const html = readFileSync(join(publicDir, prefix, page), 'utf8')
      expect(html).toContain('Apache-2.0')
      expect(html).toContain(scope)
    }
  })

  it('does not pin stale release, package-size or platform claims in current documentation', () => {
    const readmes = ['README.md', 'README.zh-CN.md'].map((file) =>
      readFileSync(join(__dirname, '..', '..', file), 'utf8')).join('\n')
    const copy = `${readmes}\n${readTextTree(publicDir)}\n${readTextTree(join(__dirname, '..', 'i18n'))}`
    for (const stale of ['v6.904–v6.921', 'v6.1027.2', 'v6.1030.1 for Apple Silicon', '12 MB', '~19 MB', 'Debian 12 / Omarchy', 'No orchestration database, no hidden state']) {
      expect(copy).not.toContain(stale)
    }
    for (const file of ['llms.txt', 'llms-full.txt']) {
      const text = readFileSync(join(publicDir, file), 'utf8')
      expect(text).toContain('.pkg.tar.zst')
      expect(text).toContain('.deb')
    }
  })

  it('reproduces all checked-in pages from the English homepage and translated generators', () => {
    const temp = mkdtempSync(join(tmpdir(), 'notemd-site-content-'))
    const website = join(__dirname, '..')
    try {
      for (const file of ['build_i18n.py', 'build_pages.py', 'i18n', 'public/index.html']) {
        cpSync(join(website, file), join(temp, file), { recursive: true })
      }
      for (const script of ['build_i18n.py', 'build_pages.py']) {
        execFileSync('python3', [script], { cwd: temp, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } })
      }
      const compare = (relative = '') => {
        for (const entry of readdirSync(join(temp, 'public', relative), { withFileTypes: true })) {
          const path = join(relative, entry.name)
          if (entry.isDirectory()) compare(path)
          else expect(readFileSync(join(temp, 'public', path), 'utf8'), path)
            .toBe(readFileSync(join(publicDir, path), 'utf8'))
        }
      }
      compare()
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })
})

describe('Grokbot integration navigation', () => {
  it.each(locales)('features Grokbot on the $lang homepage', ({ home }) => {
    const html = readFileSync(join(publicDir, home), 'utf8')
    const beat = html.match(/<p class="beat">([\s\S]*?)<\/p>/)?.[1]
    expect(beat).toContain('Grokbot')
    expect(beat).not.toContain('OpenClaw')
  })

  it.each(locales)('publishes the $lang Grokbot guide and ordered integration links', ({ lang, prefix }) => {
    const sitemap = readFileSync(join(publicDir, 'sitemap.xml'), 'utf8')
    const routes = Array.from(sitemap.matchAll(/<loc>https:\/\/notemd.net([^<]+)<\/loc>/g), (match) => match[1])
    const guide = readFileSync(join(publicDir, prefix.slice(1), 'integrations/grokbot/index.html'), 'utf8')
    expect(guide).toContain(`<html lang="${lang}">`)
    expect(guide).toContain('<h1>note.md + Grokbot</h1>')
    expect(guide).toContain('AGENTS.md')
    expect(guide).toContain('research/topic.note.md')
    expect(guide).toContain('https://docs.x.ai/grok-bot/computer-and-apps')
    expect(guide).toContain('https://docs.x.ai/grok-bot/approvals-security-and-privacy')
    expect(routes).toContain(`${prefix}/integrations/grokbot/`)
    for (const route of routes.filter((route) => prefix ? route.startsWith(`${prefix}/`) : !/^\/(de|ja|zh)\//.test(route))) {
      const html = readFileSync(join(publicDir, route.slice(1), 'index.html'), 'utf8')
      const footer = html.match(/<footer>[\s\S]*?<\/footer>/)?.[0] ?? ''
      const links = Array.from(footer.matchAll(/href="([^"]*\/integrations\/[^"]+)"[^>]*>([^<]+)<\/a>/g), (match) => [match[1], match[2]])
      expect(links, route).toEqual([
        [`${prefix}/integrations/cowork/`, 'Claude'],
        [`${prefix}/integrations/codex/`, 'Codex'],
        [`${prefix}/integrations/grokbot/`, 'Grokbot'],
        [`${prefix}/integrations/openclaw/`, 'OpenClaw'],
        [`${prefix}/integrations/hermes/`, 'Hermes'],
      ])
      for (const [href] of links) expect(existsSync(join(publicDir, href.slice(1), 'index.html')), href).toBe(true)
    }
  })
})
