import {expect,it} from 'vitest'
import {createSourceSession} from '@moraya/core'
import {scanTables,initialLayout,layoutDeltas} from './file-layout'
it('nested same-text tables have different session IDs and actual positions',()=>{
 const parsed=createSourceSession('| A | B |\n| --- | --- |\n\n> | A | B |\n> | --- | --- |');if(!parsed.ok)throw Error(parsed.reason)
 let n=0;const layout=initialLayout(parsed.session.doc,()=>`t${++n}`)
 expect(layout.size).toBe(2);expect([...layout.keys()]).toEqual(['t1','t2'])
 expect([...layout.values()].map(v=>v.columns)).toEqual([2,2]);expect([...layout.values()][1].position).toBeGreaterThan(0)
 const after=new Map(layout);after.set('t1',{...after.get('t1')!,widths:[60,null]})
 expect(layoutDeltas(layout,after)).toEqual([{id:'t1',before:layout.get('t1'),after:after.get('t1')}])
})
it('colwidth is not silently normalized into supported session tables',()=>{
 const parsed=createSourceSession('| A |\n| --- |');if(!parsed.ok)throw Error(parsed.reason)
 const table=parsed.session.doc.firstChild!,row=table.firstChild!,cell=row.firstChild!
 const changed=table.type.create(table.attrs,row.type.create(row.attrs,cell.type.create({...cell.attrs,colwidth:[80]},cell.content)))
 expect(scanTables(parsed.session.doc.copy(changed.content))).toEqual([])
})
import {TextSelection} from 'prosemirror-state'
import {gfmTableCommand} from '@moraya/core/commands'
import {open} from './file-test-utils'
import {undoDepth} from 'prosemirror-history'
it('actual whole table add/delete columns transports session widths and native undo',()=>{
 const c=open('| A | B |\n| --- | --- |\n| C | D |'),table=c.readTable(0)!
 expect(c.commitWidth({generation:0,tableId:table.id,beforeWidths:[null,null],afterWidths:[80,90]})).toBe(true)
 c.dispatch(c.state.tr.setSelection(TextSelection.create(c.state.doc,4)))
 expect(gfmTableCommand({kind:'add-column'})(c.state,tr=>{expect(c.dispatch(tr),String(c.diagnostic)).toBe(true)})).toBe(true)
 expect(c.readTable(0)?.id).toBe(table.id);expect(c.readTable(0)?.widths).toEqual([80,null,90])
 expect(c.runHistory('undo',true)).toBe(true);expect(c.readTable(0)?.widths).toEqual([80,90])
 expect(c.runHistory('undo',true)).toBe(true);expect(c.readTable(0)?.widths).toEqual([null,null])
})
it('forged table hint cannot preserve layout or authorize an unrelated change',()=>{
 const c=open('| A | B |\n| --- | --- |'),before=c.state
 const tr=c.state.tr.insertText('X',4).setMeta('moraya:gfm-table-operation',{v:1,kind:'add-column',tablePos:0,column:0})
 expect(c.dispatch(tr)).toBe(false);expect(c.state).toBe(before)
})
it('coarse source replacement invalidates nested changed table and undo restores its widths',()=>{
 const c=open('> | A | B |\n> | --- | --- |'),table=c.readTable(1)!,before=c.snapshot().raw
 c.commitWidth({generation:0,tableId:table.id,beforeWidths:[null,null],afterWidths:[80,90]})
 expect(c.replaceSource({expectedGeneration:c.snapshot().generation,value:'> | X | B |\n> | --- | --- |'}).ok).toBe(true)
 expect(c.readTable(1)?.id).not.toBe(table.id);expect(c.readTable(1)?.widths).toEqual([null,null])
 expect(c.runHistory('undo',true)).toBe(true);expect(c.snapshot().raw).toBe(before);expect(c.readTable(1)?.widths).toEqual([80,90])
})
it('width CAS, generation and no-op never create spurious events',()=>{
 const c=open('| A |\n| --- |'),table=c.readTable(0)!,before=c.state
 for(const input of [{generation:1,beforeWidths:[null],afterWidths:[80]},{generation:0,beforeWidths:[70],afterWidths:[80]},{generation:0,beforeWidths:[null],afterWidths:[null]}])expect(c.commitWidth({...input,tableId:table.id})).toBe(false)
 expect(c.state).toBe(before);expect(undoDepth(c.state)).toBe(0)
})
it('delete and reinsert a table at the same position cannot revive its old layout identity',()=>{
 const c=open('| A | B |\n| --- | --- |'),old=c.readTable(0)!,node=c.state.doc.firstChild!
 c.commitWidth({generation:0,tableId:old.id,beforeWidths:[null,null],afterWidths:[80,90]})
 const tr=c.state.tr.delete(0,node.nodeSize);tr.replaceWith(0,tr.doc.content.size,node)
 expect(c.dispatch(tr),String(c.diagnostic)).toBe(true)
 expect(c.readTable(0)?.id).not.toBe(old.id);expect(c.readTable(0)?.widths).toEqual([null,null])
 expect(c.runHistory('undo',true)).toBe(true);expect(c.readTable(0)?.id).toBe(old.id);expect(c.readTable(0)?.widths).toEqual([80,90])
})
it('layout readers cannot mutate the installed plugin registry',()=>{
 const c=open('| A |\n| --- |'),table=c.readTable(0)!,copy=c.readLayout() as Map<string,unknown>
 copy.delete(table.id);expect(c.readTable(0)?.id).toBe(table.id)
})
