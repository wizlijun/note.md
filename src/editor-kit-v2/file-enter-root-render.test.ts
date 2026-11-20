import {expect,it} from 'vitest'
import {Selection,TextSelection} from 'prosemirror-state'
import {splitBlock} from 'prosemirror-commands'
import {splitListItem} from 'prosemirror-schema-list'
import {SourceHistoryStep} from '@moraya/core/source-history'
import {open} from './file-test-utils'
import {sourceHistoryEdits} from './file-controller'

// Regression: Enter at the end of a root followed by a newline made Moraya's
// root renderer re-emit the unchanged root (`hello→hello`) beside the inserted
// blank line. SourceHistoryStep rejects identity edits, so filterTransaction
// silently refused every such Enter — most visibly the first Enter of a note.

it('drops identity edits before building the source-history payload',()=>{
 const real={from:6,to:6,removed:'',text:'\n'}
 expect(()=>SourceHistoryStep.canonicalEdits([{from:0,to:5,removed:'hello',text:'hello'},real])).toThrow()
 expect(sourceHistoryEdits([{from:0,to:5,removed:'hello',text:'hello'},real])).toEqual([real])
 expect(sourceHistoryEdits([{from:0,to:1,removed:'a',text:'a'}])).toEqual([])
})

function end(c:ReturnType<typeof open>,text:string){
 let pos=-1
 c.state.doc.descendants((node,at)=>{if(node.isTextblock&&node.textContent===text)pos=at+1+node.content.size})
 expect(pos,`textblock ${text}`).toBeGreaterThan(0)
 c.dispatch(c.state.tr.setSelection(TextSelection.create(c.state.doc,pos)))
}
function enter(c:ReturnType<typeof open>){
 let tr:import('prosemirror-state').Transaction|undefined
 const item=c.state.schema.nodes.list_item
 const run=(state:typeof c.state)=>(item&&splitListItem(item)(state,t=>{tr=t}))||splitBlock(state,t=>{tr=t})
 expect(run(c.state)).toBe(true)
 const accepted=c.dispatch(tr!)
 expect(accepted,String(c.diagnostic)).toBe(true)
}

it.each([
 ['last paragraph','hello\n','hello','hello\n\n'],
 ['last paragraph without newline','hello','hello','hello\n\n'],
 ['non-last paragraph','hello\n\nworld\n','hello','hello\n\n\nworld\n'],
 ['paragraph after frontmatter','---\ntype: Note\n---\n\nhello\n','hello','---\ntype: Note\n---\n\nhello\n\n'],
 ['last heading','# Title\n','Title',null],
 ['non-last heading','# Title\n\nbody\n','Title',null],
 ['blockquote','> quoted\n','quoted',null],
 ['bullet list item','- one\n','one',null],
 ['ordered list item','1. one\n\nafter\n','one',null],
])('Enter at the end of a %s is admitted, persists to source and undoes',(_name,raw,text,expected)=>{
 const c=open(raw)
 end(c,text)
 enter(c)
 const after=c.snapshot().raw
 expect(after).not.toBe(raw)
 if(expected!==null)expect(after).toBe(expected)
 // The caret sits in the new empty textblock; typing there lands in source.
 c.dispatch(c.state.tr.insertText('next'))
 expect(c.snapshot().raw,String(c.diagnostic)).toContain('next')
 // Undo the whole sequence back to the original bytes.
 for(let i=0;i<10&&c.snapshot().raw!==raw;i++)expect(c.runHistory('undo',true),String(c.diagnostic)).toBe(true)
 expect(c.snapshot().raw).toBe(raw)
})

it('repeated Enter at the end of the last paragraph keeps adding lines',()=>{
 const c=open('hello\n')
 c.dispatch(c.state.tr.setSelection(Selection.atEnd(c.state.doc)))
 enter(c);c.dispatch(c.state.tr.insertText('a'))
 enter(c);c.dispatch(c.state.tr.insertText('b'))
 expect(c.snapshot().raw,String(c.diagnostic)).toBe('hello\n\na\n\nb\n')
})
