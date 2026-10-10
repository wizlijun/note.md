// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { scanProject, resolveReference } from './references'
import type { ProjectFile } from './types'
const file = (path: string, markdown: string): ProjectFile => ({path, markdown, hash: path, bytes: markdown.length})

describe('project references', () => {
  it('decodes HTML entities like the browser and ignores HTML comments', async () => {
    const result = await scanProject('README.md', ['docs/a.md'], async path => {
      if(path === 'README.md') return file(path, '[a](docs/a&#46;md)\n<a href="docs/a&#46;md">b</a>\n<!-- <a href="ghost.md"> -->\n[x](&#47;Users/me/private.md)')
      if(path === 'docs/a.md') return file(path, 'ok')
      throw new Error('missing')
    })
    expect(result.files.map(f=>f.path)).toEqual(['README.md','docs/a.md'])
    expect(result.issues.map(i=>i.kind)).toEqual(['outside'])
  })
  it('collects recursive links, reference links, wiki links and images without following code or web URLs', async () => {
    const docs: Record<string, ProjectFile> = {
      'README.md': file('README.md', '[Plan](docs/plan.md#goal)\n![img][pic]\n\n[pic]: assets/a.png\n\n[[Research]]\n`[secret](hidden.md)`\n```\n[x](missing.md)\n```\n[web](https://example.org)'),
      'docs/plan.md': file('docs/plan.md', '[back](../README.md)'),
      'Research.md': file('Research.md', 'research'),
      'assets/a.png': {path:'assets/a.png', hash:'img', bytes:1, dataUrl:'data:image/png;base64,AA=='},
    }
    const result = await scanProject('README.md', Object.keys(docs), async path => {
      if (!docs[path]) throw new Error('not found')
      return docs[path]
    })
    expect(result.files.map(f=>f.path).sort()).toEqual(Object.keys(docs).sort())
    expect(result.issues).toEqual([])
  })
  it('reports ambiguous wiki targets, missing targets and root escape rather than guessing', async () => {
    const result = await scanProject('README.md', ['a/Plan.md','b/Plan.md'], async path => {
      if(path !== 'README.md') throw new Error('missing')
      return file(path, '[[Plan]]\n[x](../private.md)\n[y](gone.md)')
    })
    expect(result.issues.map(i=>i.kind).sort()).toEqual(['ambiguous','missing','outside'])
  })
  it('rejects absolute local paths including encoded traversal and ignores web/heading links', () => {
    expect(resolveReference('docs/a.md','%2e%2e/%2e%2e/private.md').kind).toBe('outside')
    for(const path of ['/Users/me/a.md','C:/secret.md','file:///secret.md','//host/path']) {
      expect(resolveReference('a.md',path).kind).toBe('outside')
    }
    expect(resolveReference('a.md','#heading').kind).toBe('skip')
    expect(resolveReference('a.md','https://example.org').kind).toBe('skip')
  })
  it('ignores code wiki links, refuses private notes and HTML local references', async () => {
    const result = await scanProject('a.md', ['secret.note.md'], async path => file(path, '`[[ghost]]`\n[x](secret.note.md)\n<img src="/Users/me/x.png">'))
    expect(result.files.map(f=>f.path)).toEqual(['a.md'])
    expect(result.issues.map(i=>i.kind).sort()).toEqual(['outside','private'])
  })
})
