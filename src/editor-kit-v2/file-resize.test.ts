// @vitest-environment happy-dom
import {expect,it} from 'vitest'
import {EditorView} from 'prosemirror-view'
import {history,undoDepth} from 'prosemirror-history'
import {defaultSchema} from '@moraya/core/schema'
import {withBlockIdentitySchema} from './identity'
import {createFileController,type FileController} from './file-controller'
import {testIds} from './file-test-utils'
import {createFileResize} from './file-resize'
function mount(){
 let controller:FileController;const resize=createFileResize(()=>controller)
 controller=createFileController({raw:'| A | B |\n| --- | --- |\n| C | D |',authority:'a',schema:withBlockIdentitySchema(defaultSchema),ids:testIds(),plugins:[resize.plugin,history()]})
 const element=document.createElement('div');document.body.append(element)
 const view=new EditorView(element,{state:controller.state,nodeViews:{table:resize.nodeView},dispatchTransaction:tr=>{controller.dispatch(tr)}});controller.bindView(view)
 return {controller,view,close(){controller.bindView(null);view.destroy();element.remove()}}
}
it('installed width paints the real col DOM without a document step',()=>{
 const {controller:c,view,close}=mount();try{
  const table=c.readTable(0)!,doc=c.state.doc,raw=c.snapshot().raw
  expect(view.dom.querySelectorAll('.column-resize-handle')).toHaveLength(4)
  expect(c.commitWidth({generation:0,tableId:table.id,beforeWidths:[null,null],afterWidths:[80,null]})).toBe(true)
  expect(view.dom.querySelector('col')!.style.width).toBe('80px');expect(c.state.doc).toBe(doc);expect(c.snapshot().raw).toBe(raw);expect(undoDepth(c.state)).toBe(1)
  expect(c.runHistory('undo',true)).toBe(true);expect(view.dom.querySelector('col')!.style.width).toBe('')
 }finally{close()}
})
it('readonly and composing refresh handles without changing document/history',()=>{
 const {controller:c,view,close}=mount();try{
  c.setReadOnly(true);expect(view.dom.querySelectorAll('.column-resize-handle')).toHaveLength(0)
  c.setReadOnly(false);expect(view.dom.querySelectorAll('.column-resize-handle')).toHaveLength(4)
  c.setComposing(true);expect(view.dom.querySelectorAll('.column-resize-handle')).toHaveLength(0)
  expect(undoDepth(c.state)).toBe(0)
 }finally{close()}
})
import {vi} from 'vitest'
it('view paint exceptions cannot report an installed source/history edit as rejected',()=>{
 const {controller:c,view,close}=mount()
 try{
  const before=c.state,spy=vi.spyOn(view,'updateState').mockImplementationOnce(()=>{throw Error('view-paint')})
  expect(c.dispatch(c.state.tr.insertText('X',4))).toBe(true)
  expect(c.state).not.toBe(before);expect(c.snapshot().raw).toContain('XA');expect(undoDepth(c.state)).toBe(1);expect(String(c.diagnostic)).toContain('view-paint')
  spy.mockRestore()
 }finally{close()}
})
it('pointer nonprimary/right button and handle exterior leave source/history untouched',()=>{
 const {controller:c,view,close}=mount();try{
  const before=c.state,handle=view.dom.querySelector('.column-resize-handle')!
  for(const options of [{isPrimary:false,button:0},{isPrimary:true,button:2}])handle.dispatchEvent(new PointerEvent('pointerdown',{...options,bubbles:true,pointerId:1,clientX:20}))
  view.dom.querySelector('th')!.dispatchEvent(new PointerEvent('pointerdown',{isPrimary:true,button:0,bubbles:true,pointerId:1}))
  expect(c.state).toBe(before);expect(undoDepth(c.state)).toBe(0);expect(view.dom.classList.contains('resize-cursor')).toBe(false)
 }finally{close()}
})

import {open} from './file-test-utils'
import {TextSelection} from 'prosemirror-state'
it('focus exceptions preserve the accepted slash result and native history',()=>{
 const c=open('/h1'),element=document.createElement('div');document.body.append(element)
 c.dispatch(c.state.tr.setSelection(TextSelection.create(c.state.doc,4)))
 const view=new EditorView(element,{state:c.state,dispatchTransaction:tr=>{c.dispatch(tr)}});c.bindView(view)
 const spy=vi.spyOn(view,'focus').mockImplementationOnce(()=>{throw Error('view-focus')})
 try{
  expect(c.executeSlashCommand('h1',true)).toBe(true)
  expect(c.snapshot().raw).toBe('# ');expect(undoDepth(c.state)).toBe(1);expect(String(c.diagnostic)).toContain('view-focus')
  expect(c.runHistory('undo',true)).toBe(true);expect(c.snapshot().raw).toBe('/h1')
 }finally{spy.mockRestore();c.bindView(null);view.destroy();element.remove()}
})
