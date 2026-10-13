import {undo,redo} from 'prosemirror-history'
import {Plugin} from 'prosemirror-state'
import type {EditorState,Transaction} from 'prosemirror-state'
import type {EditorView} from 'prosemirror-view'
import {withSourceHistoryAttempt} from '@moraya/core/source-history'
export interface FileHistoryPort {
 readonly state:EditorState
 readonly view:EditorView|null
 prepareHistory(tr:Transaction):boolean
 admit(tr:Transaction,execute:boolean):boolean
 writable():boolean
}
export function createFileHistory(port:FileHistoryPort){
 const run=(direction:'undo'|'redo',execute:boolean):boolean=>{
  if(!port.writable())return false
  const result=withSourceHistoryAttempt(()=>{
   let candidate:Transaction|undefined
   if(!(direction==='undo'?undo:redo)(port.state,tr=>{candidate=tr},port.view??undefined)||!candidate?.steps.length||!port.prepareHistory(candidate))return false
   return port.admit(candidate,execute)
  })
  return !result.failed&&result.value
 }
 return {run,plugin:new Plugin({props:{handleKeyDown(_view,event){
  if(!(event.metaKey||event.ctrlKey)||event.altKey)return false
  const key=event.key.toLowerCase()
  if(key!=='z'&&key!=='y')return false
  return run(key==='y'||event.shiftKey?'redo':'undo',true)
 }}})}
}
