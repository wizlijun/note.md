import {TextSelection,type EditorState,type Transaction} from 'prosemirror-state'
import {Slice} from 'prosemirror-model'
import type {StructuralCommand} from './contract'
import type {FileState,FileFailure} from './file-contract'
import type {FileStructuralPort} from './file-controller'
export type MoveWitness={generation:number;rootOrdinal:number;id:string;slice:Slice;from:number;to:number;insertAt:number;target:number}
export type StructuralPreparation={ok:true;tr:Transaction;changed:boolean;move?:MoveWitness;insert?:{value:string;content:string;from:number;to:number;at:number;eol:string}}|FileFailure
export function prepareFileStructural(state:EditorState,file:FileState,command:StructuralCommand):StructuralPreparation{
 const row=file.bindings.find(r=>r.id===command.blockId),root=row&&file.session.roots[row.rootOrdinal]
 if(!row||!root)return {ok:false,reason:'unknown-file-block'}
 const tr=state.tr
 if(command.kind==='block.delete'){tr.delete(root.pmFrom,root.pmTo);return {ok:true,tr,changed:true}}
 if(command.kind==='block.insert-after'){
  if(!command.content){
   tr.insert(root.pmTo,state.schema.nodes.paragraph.create());tr.setSelection(TextSelection.near(tr.doc.resolve(root.pmTo+1)))
   return {ok:true,tr,changed:true}
  }
  const raw=file.session.source,at=root.sourceTo,left=raw.slice(0,at),right=raw.slice(at)
  const eol=(left.match(/\r\n|\n/g)?.at(-1)??right.match(/\r\n|\n/)?.[0])??'\n'
  const leading=(left.match(/(?:\r\n|\n)*$/)?.[0].match(/\r\n|\n/g)?.length??0)+(command.content.match(/^(?:\r\n|\n)*/)?.[0].match(/\r\n|\n/g)?.length??0)
  const trailing=(command.content.match(/(?:\r\n|\n)*$/)?.[0].match(/\r\n|\n/g)?.length??0)+(right.match(/^(?:\r\n|\n)*/)?.[0].match(/\r\n|\n/g)?.length??0)
  const prefix=eol.repeat(Math.max(0,2-leading)),suffix=eol.repeat(Math.max(0,2-trailing)),value=left+prefix+command.content+suffix+right
  return {ok:true,tr,changed:true,insert:{value,content:command.content,from:at+prefix.length,to:at+prefix.length+command.content.length,at,eol}}
 }
 const ordinal=row.rootOrdinal+(command.kind==='block.move-up'?-1:1),neighbor=file.session.roots[ordinal]
 if(!neighbor)return {ok:false,reason:'file-block-boundary'}
 const slice=state.doc.slice(root.pmFrom,root.pmTo),target=command.kind==='block.move-up'?neighbor.pmFrom:neighbor.pmTo
 tr.delete(root.pmFrom,root.pmTo)
 const insertAt=tr.mapping.map(target);tr.insert(insertAt,slice.content)
 return {ok:true,tr,changed:true,move:{generation:file.generation,rootOrdinal:row.rootOrdinal,id:row.id,slice,from:root.pmFrom,to:root.pmTo,insertAt,target}}
}
export function executeFileStructural(controller:FileStructuralPort,command:StructuralCommand,execute:boolean):boolean{
 const result=controller.prepareStructural(command)
 return result.ok&&(result.changed?(execute?controller.dispatch(result.tr):controller.probe(result.tr)):true)
}
