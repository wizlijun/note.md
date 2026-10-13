// @vitest-environment happy-dom
import { afterEach, describe, it, expect } from 'vitest'
import { WIKILINK_RE, wikilinkPlugin } from './wikilink-plugin'

import { createEditorPlugins, createSchema, serializeMarkdown } from '@moraya/core'
import { EditorState, TextSelection } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'

/** Collect every wikilink target found in a string. */
function targets(text: string): string[] {
  WIKILINK_RE.lastIndex = 0
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = WIKILINK_RE.exec(text)) !== null) out.push(m[1])
  return out
}

describe('WIKILINK_RE', () => {
  it('matches a single wikilink', () => {
    expect(targets('see [[subagent-cwd-not-worktree]] here')).toEqual(['subagent-cwd-not-worktree'])
  })

  it('matches multiple wikilinks on one line', () => {
    expect(targets('[[a]] and [[b/c]]')).toEqual(['a', 'b/c'])
  })

  it('captures alias targets verbatim (split happens later)', () => {
    expect(targets('[[foo|Display]]')).toEqual(['foo|Display'])
  })

  it('does not match empty or nested brackets', () => {
    expect(targets('[[]]')).toEqual([])
    expect(targets('a [ [x] ] b')).toEqual([])
  })

  it('does not span across newlines', () => {
    expect(targets('[[a\nb]]')).toEqual([])
  })
})


const views: EditorView[] = []
afterEach(() => { views.splice(0).forEach(view => view.destroy()); document.body.innerHTML = '' })

async function inputEditor(text = '') {
  const mediaResolver = {
    loadLocalImage: async (path: string) => path,
    loadLocalMedia: async (path: string) => path,
    loadRemoteMedia: async (path: string) => path,
  }
  const schema = createSchema({ mediaResolver })
  const doc = schema.node('doc', null, schema.node('paragraph', null, text ? schema.text(text) : undefined))
  const view = new EditorView(document.body, { state: EditorState.create({ doc,
    selection: TextSelection.create(doc, text.length + 1),
    plugins: [...await createEditorPlugins({ container: document.body, initialContent: text, mediaResolver,
      enableInlineMarkInputRules: false, enableMath: false, enableMermaid: false }, schema), wikilinkPlugin()],
  }) })
  views.push(view)
  return view
}

function typeInput(view: EditorView, text: string) {
  const { from, to } = view.state.selection
  if (!view.someProp('handleTextInput', handler => handler(view, from, to, text))) {
    view.dispatch(view.state.tr.insertText(text, from, to))
  }
}

it.each(['', 'text', 'TypeScript'])('lets real typed fence %j reach the core Enter producer', async language => {
  const view = await inputEditor()
  for (const char of '```' + language) typeInput(view, char)
  expect(view.state.doc.textContent).toBe('```' + language)
  expect(view.someProp('handleKeyDown', handler => handler(view, new KeyboardEvent('keydown', { key: 'Enter' })))).toBe(true)
  expect(view.state.doc.firstChild!.type.name).toBe('code_block')
  expect(view.state.doc.firstChild!.attrs.language).toBe(language)
  expect(serializeMarkdown(view.state.doc)).toBe('```' + language + '\n```')
})

it.each(['code', '中文输入'])('keeps line-start inline code opening, continuation and closing for %j', async text => {
  const view = await inputEditor()
  typeInput(view, '`')
  expect(view.state.doc.textContent).toBe('`')
  typeInput(view, text)
  typeInput(view, '!')
  expect(view.state.doc.textContent).toBe('`' + text + '!')
  expect(view.state.doc.firstChild!.firstChild!.marks).toEqual([])
  typeInput(view, '`')
  typeInput(view, '.')
  expect(serializeMarkdown(view.state.doc)).toBe('`' + text + '!`.')
  expect(view.state.doc.firstChild!.lastChild!.marks).toEqual([])
})

it('preserves existing inline toggle behavior after a prefix and for selected text', async () => {
  const view = await inputEditor('prefix ')
  typeInput(view, '`')
  expect(view.state.storedMarks?.map(mark => mark.type.name)).toEqual(['code'])
  expect(view.state.doc.textContent).toBe('prefix ')
  typeInput(view, '`')
  expect(view.state.storedMarks).toEqual([])
  expect(view.state.doc.textContent).toBe('prefix ')
  const selected = await inputEditor('word')
  selected.dispatch(selected.state.tr.setSelection(TextSelection.create(selected.state.doc, 1, 5)))
  typeInput(selected, '`')
  expect(serializeMarkdown(selected.state.doc)).toBe('`word`')
  expect(selected.state.doc.textContent).toBe('word')
})

it('closes an already-active code mark in an empty paragraph without inserting a pending tick', async () => {
  const view = await inputEditor()
  view.dispatch(view.state.tr.addStoredMark(view.state.schema.marks.code.create()))
  typeInput(view, '`')
  expect(view.state.doc.textContent).toBe('')
  typeInput(view, 'plain')
  expect(view.state.doc.firstChild!.firstChild!.marks).toEqual([])
})

it('closes line-start code after text arrives without a textInput callback', async () => {
  const view = await inputEditor()
  typeInput(view, '`')
  // A document update need not have passed handleTextInput. This is a model
  // boundary check, not a claim of native composition/IME acceptance.
  view.dispatch(view.state.tr.insertText('中文'))
  typeInput(view, '`')
  expect(serializeMarkdown(view.state.doc)).toBe('`中文`')
  expect(view.state.doc.firstChild!.firstChild!.marks.map(mark => mark.type.name)).toEqual(['code'])
})

it.each(['hardbreak', 'image'])('does not treat a prefix containing %s as a plain inline-code delimiter pair', async kind => {
  const view = await inputEditor()
  typeInput(view, '`'); typeInput(view, 'a')
  const atom = kind === 'hardbreak' ? view.state.schema.nodes.hardbreak.create({ isInline: false })
    : view.state.schema.nodes.image.create({ src: '', alt: 'inline atom' })
  view.dispatch(view.state.tr.replaceSelectionWith(atom))
  typeInput(view, 'b')
  const before = view.state.doc
  typeInput(view, '`')
  expect(view.state.doc.eq(before)).toBe(true)
  expect(view.state.doc.firstChild!.firstChild!.text).toBe('`a')
})
