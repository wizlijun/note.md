// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { scanProject, resolveReference, isBlockingReferenceIssue } from './references'
import type { ProjectFile } from './types'
const file = (path: string, markdown: string): ProjectFile => ({path, markdown, hash: path, bytes: markdown.length})

describe('project references', () => {
  it('shares the readable strategy entry when its five report images are explicitly missing', async () => {
    const targets = ['1-pipeline.png','2-funnel.png','3-cost-pie.png','4-cost-bar.png','5-sequence.png'].map(name => `report-img/${name}`)
    const readPaths: string[] = []
    const result = await scanProject('strategy.md', [], async path => {
      readPaths.push(path)
      if(path === 'strategy.md') return file(path, targets.map((target,index) => `![图 ${index+1}](${target})`).join('\n'))
      throw new Error(`NOT_FOUND: ${path}`)
    })
    expect(readPaths).toEqual(['strategy.md', ...targets])
    expect(result.files.map(f=>f.path)).toEqual(['strategy.md'])
    expect(result.issues).toEqual(targets.map(target => ({from:'strategy.md',target,kind:'missing',severity:'warning',message:`Error: NOT_FOUND: ${target}`})))
    expect(result.issues.some(isBlockingReferenceIssue)).toBe(false)
  })
  it.each(['NOT_FOUND: entry.md','UNREADABLE: entry.md','unknown read failure'])('blocks an unreadable entry: %s', async message => {
    const result = await scanProject('entry.md', [], async () => { throw new Error(message) })
    expect(result.files).toEqual([])
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0].severity).toBe('error')
    expect(isBlockingReferenceIssue(result.issues[0])).toBe(true)
  })
  it.each(['UNSAFE_PATH: symlink escape','UNREADABLE: permission denied','TOO_LARGE: resource','not found','missing','wrapped NOT_FOUND: image.png'])('does not downgrade a referenced read failure: %s', async message => {
    const result = await scanProject('entry.md', [], async path => {
      if(path === 'entry.md') return file(path, '![image](image.png)')
      throw new Error(message)
    })
    expect(result.issues[0].severity).toBe('error')
    expect(isBlockingReferenceIssue(result.issues[0])).toBe(true)
  })
  it('accepts the stable host NOT_FOUND string for referenced documents', async () => {
    const result = await scanProject('entry.md', [], async path => {
      if(path === 'entry.md') return file(path, '[[Missing]]')
      throw `NOT_FOUND: ${path}`
    })
    expect(result.issues[0]).toMatchObject({kind:'missing',severity:'warning',target:'Missing'})
    expect(isBlockingReferenceIssue(result.issues[0])).toBe(false)
  })
  it('warns on relative escape, ambiguity and private references without reading those targets', async () => {
    const readPaths: string[] = []
    const result = await scanProject('entry.md', ['a/Plan.md','b/Plan.md'], async path => {
      readPaths.push(path)
      return file(path, '[outside](%2e%2e/private.md)\n[[Plan]]\n[private](.notemd/config.json)\n[note](secret.note.md)')
    })
    expect(readPaths).toEqual(['entry.md'])
    expect(result.issues.map(i=>i.kind)).toEqual(['outside','ambiguous','private','private'])
    expect(result.issues.every(i=>i.severity === 'warning')).toBe(true)
    expect(result.issues.some(isBlockingReferenceIssue)).toBe(false)
  })
  it.each(['/Users/me/private.md','%2FUsers/me/private.md','C:/private.md','file:///private.md','//host/private.md','%5CUsers%5Cprivate.md','bad%zz.md','a%00.md'])('blocks an unsafe or absolute local reference: %s', async target => {
    const result = await scanProject('entry.md', [], async path => file(path, `[local](${target})`))
    expect(result.files.map(f=>f.path)).toEqual(['entry.md'])
    expect(result.issues[0]).toMatchObject({kind:'outside',severity:'error'})
    expect(isBlockingReferenceIssue(result.issues[0])).toBe(true)
  })
  it('blocks a private entry instead of silently sharing an empty project', async () => {
    let reads = 0
    const result = await scanProject('secret.note.md', [], async path => { reads++; return file(path, 'private') })
    expect(reads).toBe(0)
    expect(result.issues[0]).toMatchObject({kind:'private',severity:'error'})
    expect(isBlockingReferenceIssue(result.issues[0])).toBe(true)
  })
  it('keeps conservative gates for legacy issues that have no severity', () => {
    const issue = {from:'entry.md',target:'target.md',message:'legacy'}
    expect(isBlockingReferenceIssue({...issue,kind:'missing'})).toBe(true)
    expect(isBlockingReferenceIssue({...issue,kind:'outside'})).toBe(true)
    expect(isBlockingReferenceIssue({...issue,kind:'ambiguous'})).toBe(false)
    expect(isBlockingReferenceIssue({...issue,kind:'private'})).toBe(false)
  })
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
