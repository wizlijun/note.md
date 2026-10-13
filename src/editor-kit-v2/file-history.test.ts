import {expect,it} from 'vitest'
import {closeHistory,undoDepth,redoDepth,undo} from 'prosemirror-history'
import {Plugin,type Transaction} from 'prosemirror-state'
import {SourceHistoryStep} from '@moraya/core/source-history'
import {open} from './file-test-utils'
it('ABA keeps distinct causal events and ordered inverse deltas',()=>{
 const c=open('A'),first=c.snapshot()
 expect(c.replaceSource({expectedGeneration:0,value:'B'}).ok).toBe(true)
 c.dispatch(closeHistory(c.state.tr))
 expect(c.replaceSource({expectedGeneration:c.snapshot().generation,value:'A'}).ok).toBe(true)
 expect(c.snapshot().sourceLineage).not.toBe(first.sourceLineage);expect(undoDepth(c.state)).toBe(2)
 expect(c.runHistory('undo',false)).toBe(true);expect(undoDepth(c.state)).toBe(2)
 expect(c.runHistory('undo',true)).toBe(true);expect(c.snapshot().raw).toBe('B')
 expect(c.runHistory('undo',true)).toBe(true);expect(c.snapshot().raw).toBe('A');expect(c.snapshot().sourceLineage).toBe(first.sourceLineage)
 expect(redoDepth(c.state)).toBe(2)
})
it('multiple raw deltas grouped by native history undo in reverse order',()=>{
 const c=open('ABC')
 c.dispatch(c.state.tr.insertText('X',2));c.dispatch(c.state.tr.insertText('Y',3))
 expect(undoDepth(c.state)).toBe(1);expect(c.snapshot().raw).toBe('AXYBC')
 expect(c.runHistory('undo',true)).toBe(true);expect(c.snapshot().raw).toBe('ABC')
 expect(c.runHistory('redo',true)).toBe(true);expect(c.snapshot().raw).toBe('AXYBC')
})
it('caller-captured native history or JSON payload never grants history origin',()=>{
 const c=open('A');c.dispatch(c.state.tr.insertText('B',1,2));const before=c.state
 let candidate:Transaction|undefined;undo(c.state,tr=>{candidate=tr})
 expect(c.dispatch(candidate!)).toBe(false);expect(c.state).toBe(before)
 const payload=candidate!.steps.find(s=>s instanceof SourceHistoryStep)!
 expect(c.dispatch(c.state.tr.step(SourceHistoryStep.fromJSON(c.state.schema,payload.toJSON())))).toBe(false)
 expect(c.snapshot().raw).toBe('B');expect(c.runHistory('undo',true)).toBe(true)
})
it('history final veto and late filter mutations preserve the real event',()=>{
 let reject=false
 const c=open('A',[new Plugin({filterTransaction:tr=>{if(reject)tr.setMeta('addToHistory',false);return true}})])
 c.dispatch(c.state.tr.insertText('B',1,2));const before=c.state,snapshot=c.snapshot();reject=true
 expect(c.runHistory('undo',true)).toBe(false);expect(c.state).toBe(before);expect(c.snapshot()).toEqual(snapshot);expect(undoDepth(c.state)).toBe(1)
 reject=false;expect(c.runHistory('undo',true)).toBe(true)
})
it('restore creates its own event with both history boundaries',()=>{
 const c=open('A');c.dispatch(c.state.tr.insertText('B',2))
 expect(c.restoreContent('C').ok).toBe(true);c.dispatch(c.state.tr.insertText('D',2))
 expect(undoDepth(c.state)).toBe(3)
 for(const raw of ['C','AB','A']){expect(c.runHistory('undo',true)).toBe(true);expect(c.snapshot().raw).toBe(raw)}
})

it('late in-place native inverse mutation rejects undo without consuming its event',()=>{
 let tamper=false
 const c=open('A',[new Plugin({filterTransaction(tr){const step=tr.steps.find(s=>s instanceof ReplaceStep);if(tamper&&step)step.invert=()=>step;return true}})])
 expect(c.dispatch(c.state.tr.insertText('B',1,2))).toBe(true)
 const before=c.state,snapshot=c.snapshot();tamper=true
 expect(c.runHistory('undo',true)).toBe(false);expect(c.state).toBe(before);expect(c.snapshot()).toEqual(snapshot);expect(undoDepth(c.state)).toBe(1)
 tamper=false;expect(c.runHistory('undo',true)).toBe(true);expect(c.snapshot().raw).toBe('A')
 expect(c.runHistory('redo',true)).toBe(true);expect(c.snapshot().raw).toBe('B')
})

import {ReplaceStep} from 'prosemirror-transform'
