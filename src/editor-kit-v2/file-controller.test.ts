import {expect,it} from 'vitest'
import {Plugin} from 'prosemirror-state'
import {undoDepth,redoDepth,history} from 'prosemirror-history'
import {ReplaceStep} from 'prosemirror-transform'
import {open} from './file-test-utils'
it('同 doc raw 编辑和原生 undo redo 保留字节与 lineage',()=>{
 const c=open('_甲_'),before=c.snapshot(),doc=c.state.doc
 expect(c.replaceSource({expectedGeneration:before.generation,value:'*甲*'}).ok).toBe(true)
 expect(c.state.doc.eq(doc)).toBe(true);expect(undoDepth(c.state)).toBe(1)
 expect(c.runHistory('undo',true)).toBe(true);expect(c.snapshot().raw).toBe('_甲_')
 expect(c.snapshot().sourceLineage).toBe(before.sourceLineage)
 expect(c.snapshot().sourceRevision).toBeGreaterThan(before.sourceRevision)
 expect(c.runHistory('redo',true)).toBe(true);expect(c.snapshot().raw).toBe('*甲*')
})
it('Source 真正语义 ReplaceStep 和 definition-only 恢复',()=>{
 let steps:unknown[]=[]
 const c=open('[id]: /u\n',[new Plugin({filterTransaction:tr=>{steps=tr.steps;return true}})])
 expect(c.snapshot().bindings).toEqual([])
 expect(c.replaceSource({expectedGeneration:c.snapshot().generation,value:'[id]: /u\n\n甲。'}).ok).toBe(true)
 expect(steps.some(s=>s instanceof ReplaceStep)).toBe(true)
 expect(c.state.doc.textContent).toBe('甲。');expect(c.snapshot().bindings).toHaveLength(1)
 expect(c.runHistory('undo',true)).toBe(true);expect(c.snapshot().raw).toBe('[id]: /u\n');expect(c.snapshot().bindings).toEqual([])
})
it('真实 rich 原 steps 完整准入并原生撤销',()=>{
 const c=open('甲。'),tr=c.state.tr.insertText('乙',1,2),step=tr.steps[0]
 expect(c.dispatch(tr)).toBe(true);expect(tr.steps[0]).toBe(step);expect(c.snapshot().raw).toBe('乙。')
 expect(c.runHistory('undo',true)).toBe(true);expect(c.snapshot().raw).toBe('甲。')
})
it('后 filter 拒绝不安装 source 或 history',()=>{
 const c=open('甲。',[new Plugin({filterTransaction:tr=>!tr.docChanged})]),before=c.state,raw=c.snapshot().raw
 expect(c.dispatch(c.state.tr.insertText('乙',1,2))).toBe(false)
 expect(c.state).toBe(before);expect(c.snapshot().raw).toBe(raw);expect(undoDepth(c.state)).toBe(0);expect(redoDepth(c.state)).toBe(0)
})
it('append 非法来源使整链回滚且 observer 为零',async()=>{
 const plugin=new Plugin({appendTransaction(ts,_old,next){if(ts.some(t=>t.getMeta('test-append'))||!ts.some(t=>t.docChanged))return null;return next.tr.setDocAttribute('unapproved','x').setMeta('test-append',true)}})
 let calls=0;const c=open('甲。',[plugin],()=>{calls++}),before=c.state
 expect(c.dispatch(c.state.tr.insertText('乙',1,2))).toBe(false);expect(c.state).toBe(before);await Promise.resolve();expect(calls).toBe(0)
})
it('最终 policy 只看整个合法 append chain 并且 probe 不安装',()=>{
 const seen:string[][]=[]
 const plugin=new Plugin({appendTransaction(ts,_old,next){if(ts.some(t=>t.getMeta('tail'))||!ts.some(t=>t.docChanged))return null;return next.tr.insertText('甲',1,2).setMeta('tail',true)}})
 const c=open('甲。',[plugin],undefined,{acceptRawChange:(a,b)=>{seen.push([a,b]);return true}}),before=c.state
 expect(c.probe(c.state.tr.insertText('乙',1,2))).toBe(true);expect(c.state).toBe(before);expect(seen).toEqual([['甲。','甲。']])
 expect(c.dispatch(c.state.tr.insertText('乙',1,2))).toBe(true);expect(seen).toEqual([['甲。','甲。'],['甲。','甲。']]);expect(c.snapshot().sourceLineage).not.toBe('s2')
})
it.each([false,'throw'])('最终 veto %s 完整原子性',mode=>{
 let calls=0;const c=open('甲。',[],()=>{calls++},{acceptRawChange:()=>{if(mode==='throw')throw Error('veto');return false}}),before=c.state,snapshot=c.snapshot()
 expect(c.replaceSource({expectedGeneration:0,value:'乙。'}).ok).toBe(false);expect(c.state).toBe(before);expect(c.snapshot()).toEqual(snapshot);expect(calls).toBe(0)
})
it('stale/noop/readonly/composing 不消耗代数或事件',()=>{
 const c=open('甲。'),before=c.snapshot()
 expect(c.replaceSource({expectedGeneration:0,value:'甲。'})).toEqual({ok:true,changed:false,snapshot:before})
 expect(c.replaceSource({expectedGeneration:99,value:'乙'})).toEqual({ok:false,reason:'stale-source'})
 c.setReadOnly(true);expect(c.replaceSource({expectedGeneration:0,value:'乙'}).ok).toBe(false)
 c.setReadOnly(false);c.setComposing(true);expect(c.restoreContent('乙').ok).toBe(false);expect(undoDepth(c.state)).toBe(0)
})
import {SourceHistoryStep} from '@moraya/core/source-history'
import {TextSelection} from 'prosemirror-state'
it.each([
 ['A😀B\r\n\r\nC','A😃B\r\n\r\nC'],
 ['A\r\n\r\nB','A\n\nB'],
 ['[go][id]\n\nuntouched\n\n[id]: /a\n','[go][id]\n\nuntouched\n\n[id]: /b\n'],
])('Source safe UTF16 CRLF and remote reference semantics %s',(before,after)=>{
 const c=open(before),doc=c.state.doc,ids=c.snapshot().bindings
 expect(c.replaceSource({expectedGeneration:0,value:after}).ok).toBe(true);expect(c.snapshot().raw).toBe(after)
 expect(c.runHistory('undo',true)).toBe(true);expect(c.snapshot().raw).toBe(before);expect(c.state.doc.eq(doc)).toBe(true);expect(c.snapshot().bindings).toEqual(ids)
 expect(c.runHistory('redo',true)).toBe(true);expect(c.snapshot().raw).toBe(after)
})
it.each(['steps','addToHistory','history'] as const)('late filter %s mutation atomically rejects',kind=>{
 const plugin=new Plugin({filterTransaction(tr,state){if(tr.steps.length){if(kind==='steps')tr.insertText('Z',1);else if(kind==='addToHistory')tr.setMeta(kind,false);else{const h=state.plugins.find(p=>p.spec.key===history().spec.key)!;tr.setMeta(h,{redo:false,historyState:{}})}}return true}})
 let notified=0;const c=open('A',[plugin],()=>{notified++}),before=c.state,snapshot=c.snapshot()
 expect(c.dispatch(c.state.tr.insertText('B',1,2))).toBe(false);expect(c.state).toBe(before);expect(c.snapshot()).toEqual(snapshot);expect(notified).toBe(0)
})
it('PM overwrites a late transient append reference with the actual root',()=>{
 const append=new Plugin({appendTransaction(ts,_old,next){if(ts.some(t=>t.getMeta('tail'))||!ts.some(t=>t.docChanged))return null;return next.tr.insertText('C',2).setMeta('tail',true)}})
 const late=new Plugin({filterTransaction(tr){if(tr.getMeta('tail'))tr.setMeta('appendedTransaction',{forged:true});return true}})
 const c=open('A',[append,late]);expect(c.dispatch(c.state.tr.insertText('B',1,2))).toBe(true);expect(c.snapshot().raw).toBe('BC')
})
it('caller metadata cannot claim source, correspondence, or append authority',()=>{
 const c=open('A'),before=c.state
 const tr=c.state.tr.setDocAttribute('x','unsupported').setMeta('file-source',{raw:'B'}).setMeta('correspondence',[{kind:'retained',beforeRoots:[0],afterRoots:[0]}])
 expect(c.dispatch(tr)).toBe(false);expect(c.state).toBe(before)
 expect(c.dispatch(c.state.tr.insertText('B',1,2).setMeta('appendedTransaction',c.state.tr))).toBe(false)
})
it('a valid content append rejected by a later filter rolls back the accepted root',()=>{
 const append=new Plugin({appendTransaction(ts,_old,next){if(ts.some(t=>t.getMeta('tail'))||!ts.some(t=>t.docChanged))return null;return next.tr.insertText('C',2).setMeta('tail',true)}})
 const c=open('A',[append,new Plugin({filterTransaction:tr=>!tr.getMeta('tail')})]),before=c.state
 expect(c.dispatch(c.state.tr.insertText('B',1,2))).toBe(false);expect(c.state).toBe(before);expect(undoDepth(c.state)).toBe(0)
})
it('selection and stored marks pass without creating a raw event; false flag never bypasses source guard',()=>{
 const c=open('ABC'),before=c.snapshot()
 expect(c.dispatch(c.state.tr.setSelection(TextSelection.create(c.state.doc,2)).setStoredMarks([c.state.schema.marks.strong.create()]))).toBe(true)
 expect(c.snapshot()).toEqual(before);expect(c.state.storedMarks?.[0].type.name).toBe('strong')
 expect(c.dispatch(c.state.tr.insertText('X').setMeta('addToHistory',false))).toBe(false)
 expect(c.dispatch(c.state.tr.insertText('X'))).toBe(true);expect(c.snapshot().raw).toContain('**X**')
})
it('subscriber exceptions cannot roll back an already installed successful edit',async()=>{
 const c=open('A');c.observe(()=>{throw Error('subscriber')})
 expect(c.dispatch(c.state.tr.insertText('B',1,2))).toBe(true);expect(c.snapshot().raw).toBe('B');expect(undoDepth(c.state)).toBe(1);await Promise.resolve();expect(String(c.diagnostic)).toContain('subscriber')
})
import {StepMap} from 'prosemirror-transform'
it.each(['docs','mapping'] as const)('late %s mutation cannot corrupt native inverse history',kind=>{
 const plugin=new Plugin({filterTransaction(tr){if(tr.steps.length>1){if(kind==='docs')tr.docs[1]=tr.docs[0];else (tr.mapping.maps as StepMap[])[0]=StepMap.empty}return true}})
 const c=open('ABC',[plugin]),before=c.state
 expect(c.dispatch(c.state.tr.insertText('X',2).insertText('Y',3))).toBe(false)
 expect(c.state).toBe(before);expect(undoDepth(c.state)).toBe(0)
})
it('publish queues each accepted snapshot in order and callback edits use the latest state',async()=>{
 const c=open('A'),received:string[]=[],deltas:number[]=[]
 c.observe(value=>{received.push(value.raw);if(value.raw==='B')c.dispatch(c.state.tr.insertText('D',1,2))})
 c.dispatch(c.state.tr.insertText('B',1,2));c.dispatch(c.state.tr.insertText('C',1,2))
 expect(received).toEqual([]);expect(c.snapshot().raw).toBe('C')
 await Promise.resolve();await Promise.resolve()
 expect(received).toEqual(['B','C','D']);expect(c.snapshot().raw).toBe('D')
 const dispose=c.observe(value=>deltas.push(value.generation));c.dispatch(c.state.tr.insertText('E',1,2));dispose();await Promise.resolve();expect(deltas).toEqual([])
})

import {Slice} from 'prosemirror-model'
it.each(['replacement','invert','apply','map','getMap','merge','toJSON','ranges','mapping-from','mapping-mirror','map-method'] as const)('late %s execution-chain mutation rejects before native history',async(mode)=>{
 class Foreign extends ReplaceStep {invert(){return new ReplaceStep(0,0,Slice.empty)}}
 const late=new Plugin({filterTransaction(tr){
  const step=tr.steps[0];if(!(step instanceof ReplaceStep))return true
  if(mode==='replacement')tr.steps[0]=new Foreign(step.from,step.to,step.slice)
  else if(mode==='ranges')(tr.mapping.maps[0] as unknown as {ranges:number[]}).ranges[0]++
  else if(mode==='mapping-from')tr.mapping.from++
  else if(mode==='mapping-mirror')Object.assign(tr.mapping,{mirror:[0,1]})
  else if(mode==='map-method')tr.mapping.maps[0].invert=()=>StepMap.empty
  else if(mode==='invert')step.invert=()=>new ReplaceStep(0,0,Slice.empty)
  else Object.defineProperty(step,mode,{value:step[mode].bind(step),configurable:true})
  return true
 }})
 let notifications=0;const c=open('A',[late],()=>{notifications++}),before=c.state,snapshot=c.snapshot()
 expect(c.dispatch(c.state.tr.insertText('B',1,2))).toBe(false)
 expect(c.state).toBe(before);expect(c.snapshot()).toEqual(snapshot);expect(undoDepth(c.state)).toBe(0);expect(redoDepth(c.state)).toBe(0)
 await Promise.resolve();expect(notifications).toBe(0)
})
it.each(['map','docs','step','invert','mapping-to','mirror'] as const)('private insert intent rejects pre-filter %s mutation',(mode)=>{
 const c=open('A\n\nC'),before=c.state,snapshot=c.snapshot()
 const p=c.prepareStructural({kind:'block.insert-after',blockId:snapshot.bindings[0].id,content:'B'});if(!p.ok)throw Error(p.reason)
 const step=p.tr.steps[0] as ReplaceStep
 if(mode==='map')(p.tr.mapping.maps as StepMap[])[0]=StepMap.empty
 else if(mode==='docs')p.tr.docs[1]=p.tr.docs[1].type.create(p.tr.docs[1].attrs,p.tr.docs[1].content,p.tr.docs[1].marks)
 else if(mode==='step')p.tr.steps[0]=new ReplaceStep(step.from,step.to,step.slice)
 else if(mode==='invert')step.invert=()=>new ReplaceStep(0,0,Slice.empty)
 else if(mode==='mapping-to')p.tr.mapping.to--
 else Object.assign(p.tr.mapping,{mirror:[0,1]})
 expect(c.dispatch(p.tr)).toBe(false);expect(c.state).toBe(before);expect(c.snapshot()).toEqual(snapshot);expect(undoDepth(c.state)).toBe(0)
})

it('ordinary Rich cannot register a preexisting own invert override as native execution',()=>{
 const c=open('A'),before=c.state,snapshot=c.snapshot(),tr=c.state.tr.insertText('B',1,2)
 tr.steps[0].invert=()=>new ReplaceStep(0,0,Slice.empty)
 expect(c.dispatch(tr)).toBe(false);expect(c.state).toBe(before);expect(c.snapshot()).toEqual(snapshot);expect(undoDepth(c.state)).toBe(0)
})
