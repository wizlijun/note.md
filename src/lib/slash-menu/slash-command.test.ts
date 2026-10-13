import {expect,it} from 'vitest'
import {EditorState,type Transaction} from 'prosemirror-state'
import {defaultSchema} from '@moraya/core/schema'
import {runSlashCommand} from './slash-command'
it.each([['h1','heading',1],['task','bullet_list',2],['table','table',1],['mermaid','code_block',1],['highlight','paragraph',1]] as const)('actual synchronous %s producer keeps the real sequential state', (id,type,count)=>{
 let state=EditorState.create({schema:defaultSchema}),focus=0;const transactions:Transaction[]=[]
 expect(runSlashCommand({get state(){return state},dispatch(tr){expect(tr.before).toBe(state.doc);transactions.push(tr);state=state.apply(tr)},focus(){focus++}},id)).toBe(true)
 expect(state.doc.firstChild!.type.name).toBe(type);expect(transactions).toHaveLength(count);expect(focus).toBe(1)
 if(id==='task')expect(state.doc.firstChild!.firstChild!.attrs.checked).toBe(false)
 if(id==='highlight')expect(state.doc.textContent).toBe('^^^^')
})
