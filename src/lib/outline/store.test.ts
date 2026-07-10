// src/lib/outline/store.test.ts
import { describe, it, expect } from 'vitest'
import { outline, companionPathFor, persistIdsFor, attachDoc, serializeDoc, setChangeSink, markDirty, detach } from './store.svelte'
import { createTree, addNode } from './model'

describe('companionPathFor', () => {
  it('maps main file to sibling .note.md', () => {
    expect(companionPathFor('/d/foo.md')).toBe('/d/foo.note.md')
    expect(companionPathFor('/d/bar.markdown')).toBe('/d/bar.note.md')
  })
  it('null for companion files themselves (new and legacy suffix) and non-md', () => {
    expect(companionPathFor('/d/foo.note.md')).toBeNull()
    expect(companionPathFor('/d/foo.notes.md')).toBeNull()
    expect(companionPathFor('/d/FOO.NOTE.MD')).toBeNull()
    expect(companionPathFor('/d/x.png')).toBeNull()
  })
})

describe('persistIdsFor', () => {
  it('collects block-ref targets and auto nodes with manual children', () => {
    const t = createTree()
    addNode(t, { id: 'toc1', parentId: null, order: 0, content: 'T', collapsed: false, source: 'toc', anchorLine: 1 })
    addNode(t, { id: 'm1', parentId: 'toc1', order: 0, content: 'child', collapsed: false, source: 'manual' })
    addNode(t, { id: 'm2', parentId: null, order: 100, content: 'see ((m1))', collapsed: false, source: 'manual' })
    const ids = persistIdsFor(t)
    expect(ids.has('toc1')).toBe(true)   // auto 带手写子节点 → 保 id
    expect(ids.has('m1')).toBe(true)     // 被 ((m1)) 引用
    expect(ids.has('m2')).toBe(false)
  })
})

describe('attachDoc / serializeDoc', () => {
  it('parses text (front-matter carried) and serializeDoc stamps title/updated', async () => {
    await attachDoc('/v/foo.note.md', '- hello\n', null)
    expect(outline.docPath).toBe('/v/foo.note.md')
    const out = serializeDoc()
    expect(out).toContain('title: foo')
    expect(out).toContain('updated:')
    expect(out).toContain('- hello')
    detach()
  })
  it('derives auto items from main content when provided', async () => {
    // deriveAutoItems only emits headings lazily when highlights appear beneath them;
    // '# Heading One\n\ntext\n' produces zero auto items. Use content with an H2 + highlight.
    await attachDoc('/v/doc.note.md', '- manual\n', '## Section\n^^important^^\n')
    const contents = [...outline.tree.nodes.values()].map(n => n.content)
    expect(contents).toContain('manual')
    expect(contents.length).toBeGreaterThan(1) // 至少派生出一个 auto 节点
    detach()
  })
  it('markDirty invokes the registered change sink', async () => {
    await attachDoc('/v/foo.note.md', '- x\n', null)
    let called = 0
    setChangeSink(() => { called++ })
    markDirty()
    expect(called).toBe(1)
    setChangeSink(null)
    detach()
  })
  it('serializeDoc(false) does not stamp updated (attach-compare must be side-effect-free)', async () => {
    await attachDoc('/v/bare.note.md', '- x\n', null)
    expect(serializeDoc(false)).toBe('- x\n')
    detach()
  })
})
