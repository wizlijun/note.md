import {expect,it} from 'vitest'
import {TextSelection,Plugin} from 'prosemirror-state'
import {undoDepth} from 'prosemirror-history'
import {open} from './file-test-utils'
it.each([['h1','# '],['task','- [ ] '],['code','```'],['mermaid','```mermaid'],['table','|'],['highlight','\\^'],['wikilink','\\[']] as const)('slash %s atomically combines actual producer steps and undo restores slash',async(id,prefix)=>{
 let calls=0;const c=open('/'+id,[],()=>{calls++})
 c.dispatch(c.state.tr.setSelection(TextSelection.create(c.state.doc,id.length+2)))
 const before=c.snapshot().raw
 const available=c.executeSlashCommand(id,false);expect(available,String(c.diagnostic)).toBe(true);expect(c.snapshot().raw).toBe(before)
 expect(c.executeSlashCommand(id,true)).toBe(true)
 expect(c.snapshot().raw.startsWith(prefix)).toBe(true);await Promise.resolve();expect(calls).toBe(1);expect(undoDepth(c.state)).toBe(1)
 expect(c.runHistory('undo',true)).toBe(true);expect(c.snapshot().raw).toBe(before)
})
it('slash keeps its bytes when a real late filter vetoes combined changes',()=>{
 const c=open('/task',[new Plugin({filterTransaction:tr=>!tr.docChanged})])
 c.dispatch(c.state.tr.setSelection(TextSelection.create(c.state.doc,6)))
 const before=c.state;expect(c.executeSlashCommand('task',true)).toBe(false);expect(c.state).toBe(before);expect(c.snapshot().raw).toBe('/task')
})
import {executeFileStructural} from './file-commands'
it('move transports the exact root identity across synthetic blanks and duplicate text',()=>{
 const c=open('A\n\n\nA\n\nC'),before=c.snapshot(),id=before.bindings[1].id
 expect(executeFileStructural(c,{kind:'block.move-up',blockId:id},false)).toBe(true)
 expect(c.snapshot()).toEqual(before)
 expect(executeFileStructural(c,{kind:'block.move-up',blockId:id},true)).toBe(true)
 expect(c.snapshot().bindings[0].id).toBe(id)
 expect(c.runHistory('undo',true)).toBe(true);expect(c.snapshot().bindings).toEqual(before.bindings);expect(c.snapshot().raw).toBe(before.raw)
})
it('insert-after preserves original roots and creates exactly one new natural root',()=>{
 const c=open('A\r\n\r\nB'),before=c.snapshot()
 expect(executeFileStructural(c,{kind:'block.insert-after',blockId:before.bindings[0].id,content:'新增'},true)).toBe(true)
 expect(c.snapshot().raw).toBe('A\r\n\r\n新增\r\n\r\nB')
 expect(c.snapshot().bindings.map(r=>r.id)).toEqual([before.bindings[0].id,expect.any(String),before.bindings[1].id])
 expect(c.runHistory('undo',true)).toBe(true);expect(c.snapshot().raw).toBe(before.raw)
})
it('empty insert is a real paragraph and last-root delete returns zero natural roots',()=>{
 const c=open('A'),id=c.snapshot().bindings[0].id
 expect(executeFileStructural(c,{kind:'block.insert-after',blockId:id,content:''},true)).toBe(true)
 expect(c.state.doc.childCount).toBe(2);expect(c.snapshot().bindings).toHaveLength(1)
 expect(c.runHistory('undo',true)).toBe(true)
 expect(executeFileStructural(c,{kind:'block.delete',blockId:id},true)).toBe(true)
 expect(c.snapshot().bindings).toEqual([]);expect(c.state.doc.firstChild!.type.name).toBe('paragraph')
})
it('block bounds, unknown ids, protected motion and multi-root inserts reject atomically',()=>{
 const c=open('A\n\n[id]: /u\n\nB'),before=c.state,ids=c.snapshot().bindings
 for(const command of [
  {kind:'block.move-up' as const,blockId:ids[0].id},{kind:'block.delete' as const,blockId:'unknown'},
  {kind:'block.insert-after' as const,blockId:ids[0].id,content:'X\n\nY'},
 ]){expect(executeFileStructural(c,command,true)).toBe(false);expect(c.state).toBe(before)}
})
it('slash selection, readonly, composition and final policy rejection keep slash bytes',()=>{
 const c=open('/h1',[],undefined,{acceptRawChange:(a,b)=>a===b})
 expect(c.executeSlashCommand('h1',true)).toBe(false)
 c.dispatch(c.state.tr.setSelection(TextSelection.create(c.state.doc,4)));const before=c.state
 expect(c.executeSlashCommand('h1',true)).toBe(false);expect(c.state).toBe(before)
 c.setReadOnly(true);expect(c.executeSlashCommand('h1',true)).toBe(false);c.setReadOnly(false);c.setComposing(true);expect(c.executeSlashCommand('h1',true)).toBe(false)
 expect(c.snapshot().raw).toBe('/h1')
})
it('moving identical adjacent natural roots still transports business IDs',()=>{
 const c=open('A\n\nA\n'),before=c.snapshot(),id=before.bindings[1].id
 expect(executeFileStructural(c,{kind:'block.move-up',blockId:id},true),String(c.diagnostic)).toBe(true)
 expect(c.snapshot().raw).toBe(before.raw);expect(c.snapshot().bindings.map(r=>r.id)).toEqual([id,before.bindings[0].id])
 expect(c.runHistory('undo',true)).toBe(true);expect(c.snapshot().bindings).toEqual(before.bindings)
})
it.each(['h2','h3','quote','math','bullet','ordered','hr'] as const)('remaining synchronous slash %s has one accepted event',id=>{
 const c=open('/'+id);c.dispatch(c.state.tr.setSelection(TextSelection.create(c.state.doc,id.length+2)))
 expect(c.executeSlashCommand(id,true),String(c.diagnostic)).toBe(true);expect(undoDepth(c.state)).toBe(1)
 expect(c.runHistory('undo',true)).toBe(true);expect(c.snapshot().raw).toBe('/'+id)
})
import {vi} from 'vitest'
import * as slashProducer from '../lib/slash-menu/slash-command'
it.each(['before','docs','metadata','unsupported','throw'] as const)('slash collector rejects a producer with invalid %s without publishing deletion',mode=>{
 const c=open('/h1');c.dispatch(c.state.tr.setSelection(TextSelection.create(c.state.doc,4)))
 const before=c.state,snapshot=c.snapshot()
 const spy=vi.spyOn(slashProducer,'runSlashCommand').mockImplementation(target=>{
  if(mode==='throw')throw Error('producer failure')
  if(mode==='before'){target.dispatch(before.tr);return true}
  const tr=mode==='unsupported'?target.state.tr.setDocAttribute('x','unknown'):target.state.tr.insertText('A',1).insertText('B',2)
  if(mode==='docs')tr.docs[1]=tr.docs[0]
  if(mode==='metadata')tr.setMeta('addToHistory',false)
  target.dispatch(tr);return true
 })
 try{expect(c.executeSlashCommand('h1',true)).toBe(false);expect(c.state).toBe(before);expect(c.snapshot()).toEqual(snapshot);expect(undoDepth(c.state)).toBe(0)}finally{spy.mockRestore()}
})

it('unsupported spreadsheet producer preserves slash and the desktop registry stays available',()=>{
 const c=open('/spreadsheet');c.dispatch(c.state.tr.setSelection(TextSelection.create(c.state.doc,13)))
 const before=c.state;expect(c.executeSlashCommand('spreadsheet',false)).toBe(false);expect(c.executeSlashCommand('spreadsheet',true)).toBe(false);expect(c.state).toBe(before);expect(c.snapshot().raw).toBe('/spreadsheet')
})
it('same-content move probe, both directions, redo and subsequent typing keep separate events',()=>{
 const c=open('A\n\nA'),before=c.snapshot(),ids=before.bindings.map(r=>r.id)
 expect(executeFileStructural(c,{kind:'block.move-down',blockId:ids[0]},false)).toBe(true);expect(c.snapshot()).toEqual(before)
 expect(executeFileStructural(c,{kind:'block.move-down',blockId:ids[0]},true)).toBe(true)
 expect(c.snapshot().bindings.map(r=>r.id)).toEqual([ids[1],ids[0]]);expect(c.snapshot().sourceLineage,c.snapshot().raw).toBe(before.sourceLineage)
 expect(c.dispatch(c.state.tr.insertText('B',1,2))).toBe(true);expect(undoDepth(c.state)).toBe(2)
 expect(c.runHistory('undo',true)).toBe(true);expect(c.snapshot().bindings.map(r=>r.id)).toEqual([ids[1],ids[0]])
 expect(c.runHistory('undo',true)).toBe(true);expect(c.snapshot().bindings).toEqual(before.bindings)
 expect(c.runHistory('redo',true)).toBe(true);expect(c.snapshot().bindings.map(r=>r.id)).toEqual([ids[1],ids[0]])
 expect(c.runHistory('redo',true)).toBe(true);expect(c.snapshot().raw).toBe('B\n\nA')
})
it('typing around two consecutive moves keeps four native undo/redo events',()=>{
 const c=open('A\n\nA\n\nC'),ids=c.snapshot().bindings.map(r=>r.id)
 expect(c.dispatch(c.state.tr.insertText('X',8))).toBe(true)
 expect(executeFileStructural(c,{kind:'block.move-up',blockId:ids[1]},true)).toBe(true)
 expect(executeFileStructural(c,{kind:'block.move-down',blockId:ids[1]},true)).toBe(true)
 expect(c.dispatch(c.state.tr.insertText('Y',9))).toBe(true);expect(undoDepth(c.state)).toBe(4)
 const expectState=(raw:string,order:string[])=>{expect(c.snapshot().raw).toBe(raw);expect(c.snapshot().bindings.map(r=>r.id)).toEqual(order)}
 for(const [raw,order] of [['A\n\nA\n\nCX',ids],['A\n\nA\n\nCX',[ids[1],ids[0],ids[2]]],['A\n\nA\n\nCX',ids],['A\n\nA\n\nC',ids]] as const){expect(c.runHistory('undo',true)).toBe(true);expectState(raw,[...order])}
 for(let i=0;i<4;i++)expect(c.runHistory('redo',true)).toBe(true)
 expectState('A\n\nA\n\nCXY',ids)
})

it.each([['A','\n'],['A\n\nC','\n'],['A\r\n\r\nC','\r\n'],['\uFEFFA','\n'],['\uFEFFA\r\n\r\nC','\r\n']] as const)('EOF insertion keeps exact old bytes and identities: %j', (raw,eol)=>{
 const c=open(raw),before=c.state,snapshot=c.snapshot(),id=snapshot.bindings.at(-1)!.id
 const command={kind:'block.insert-after' as const,blockId:id,content:'B'}
 expect(executeFileStructural(c,command,false),String(c.diagnostic)).toBe(true);expect(c.state).toBe(before);expect(undoDepth(c.state)).toBe(0)
 expect(executeFileStructural(c,command,true),String(c.diagnostic)).toBe(true)
 expect(c.snapshot().raw).toBe(raw+eol+eol+'B'+eol+eol)
 expect(c.snapshot().bindings.slice(0,-1)).toEqual(snapshot.bindings)
 expect(c.runHistory('undo',true)).toBe(true);expect(c.snapshot().raw).toBe(raw);expect(c.snapshot().bindings).toEqual(snapshot.bindings)
 expect(c.runHistory('redo',true)).toBe(true);expect(c.snapshot().raw).toBe(raw+eol+eol+'B'+eol+eol)
})
it.each(['B\n\nC','[id]: /new\n\nB'])('EOF exception rejects multiple births or remote reference effects: %j',(content)=>{
 const c=open('[x][id]\n\nA'),before=c.state,snapshot=c.snapshot()
 expect(executeFileStructural(c,{kind:'block.insert-after',blockId:snapshot.bindings.at(-1)!.id,content},true)).toBe(false)
 expect(c.state).toBe(before);expect(c.snapshot()).toEqual(snapshot);expect(undoDepth(c.state)).toBe(0)
})
