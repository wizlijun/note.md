import type {SourceSession,FileRootCorrespondence,SyntheticEmission} from '@moraya/core'
import type {BindingImage} from '@moraya/core/source-history'
import {Fragment,type Node} from 'prosemirror-model'
import type {FileBinding,FileFailure,FileState,FileRecovery} from './file-contract'
import {BLOCK_ID_ATTR} from './identity'
import {sha256Sync} from '../lib/share-merge/hash'

export type BindingsResult = {ok:true;bindings:readonly FileBinding[]}|FileFailure
const fail=():never=>{throw Error('invalid-file-bindings')}
const integer=(n:number)=>Number.isSafeInteger(n)&&n>=0
function ownership(session:SourceSession):(number|null)[] {
 const offsets=[0],owners:(number|null|undefined)[]=new Array(session.doc.childCount)
 session.doc.forEach(node=>offsets.push(offsets[offsets.length-1]+node.nodeSize))
 const assign=(e:SyntheticEmission,id:number|null)=>{
  if(!integer(e.childFrom)||!integer(e.childTo)||e.childFrom>=e.childTo||e.childTo>session.doc.childCount
   ||offsets[e.childFrom]!==e.pmFrom||offsets[e.childTo]!==e.pmTo)fail()
  for(let i=e.childFrom;i<e.childTo;i++){if(owners[i]!==undefined&&!(id===null&&owners[i]===null))fail();owners[i]=id}
 }
 let end=0
 session.roots.forEach((root,ordinal)=>{
  if(root.id!==ordinal||!integer(root.sourceFrom)||!integer(root.sourceTo)||root.sourceFrom<end||root.sourceTo<root.sourceFrom||root.sourceTo>session.source.length)fail()
  end=root.sourceTo;assign(root,ordinal)
 })
 for(const gap of session.gaps)for(const e of gap.synthetic)assign(e,null)
 for(const blank of session.layout.blankLines)if(blank.role==='empty-paragraph')assign(blank.emission,null)
 if(session.layout.fallback)assign(session.layout.fallback.emission,null)
 for(let i=0;i<owners.length;i++)if(owners[i]===undefined)fail()
 return owners as (number|null)[]
}
function checked(session:SourceSession,rows:readonly FileBinding[]):(number|null)[] {
 if(!Array.isArray(rows)||rows.length!==session.roots.length)fail()
 const ids=new Set<string>()
 for(let i=0;i<rows.length;i++){
  const row=rows[i]
  if(!row||row.rootOrdinal!==i||typeof row.id!=='string'||!row.id||ids.has(row.id)||Object.keys(row).some(k=>k!=='id'&&k!=='rootOrdinal'))fail()
  ids.add(row.id)
 }
 return ownership(session)
}
const freezeRows=(rows:readonly FileBinding[]):readonly FileBinding[]=>Object.freeze(rows.map(r=>Object.freeze({rootOrdinal:r.rootOrdinal,id:r.id})))
export function validateBindings(session:SourceSession,rows:readonly FileBinding[]):{ok:true}|FileFailure {
 try{checked(session,rows);return {ok:true}}catch{return {ok:false,reason:'invalid-file-bindings'}}
}
/** Preserve complete canonical content, including children with no natural root. */
export function projectBindings(session:SourceSession,rows:readonly FileBinding[]):Node {
 const owners=checked(session,rows),children:Node[]=[]
 const clean=(node:Node):Node=>{
  const nested:Node[]=[];node.forEach(child=>nested.push(clean(child)))
  const content=Fragment.fromArray(nested)
  if(Object.hasOwn(node.type.spec.attrs??{},BLOCK_ID_ATTR))return node.type.create({...node.attrs,[BLOCK_ID_ATTR]:null},content,node.marks)
  return node.isLeaf?node:node.copy(content)
 }
 session.doc.forEach((node,_pos,i)=>{
  const n=clean(node),owner=owners[i]
  if(owner!==null&&!Object.hasOwn(n.type.spec.attrs??{},BLOCK_ID_ATTR))fail()
  children.push(owner===null?n:n.type.create({...n.attrs,[BLOCK_ID_ATTR]:rows[owner].id},n.content,n.marks))
 })
 return session.doc.copy(Fragment.fromArray(children))
}
/** Correspondence is data, not authority. The controller pairs real F1 results. */
export function nextBindings(base:Pick<FileState,'session'|'bindings'>,next:SourceSession,correspondence:readonly FileRootCorrespondence[],idFactory:()=>string):BindingsResult {
 try{
  checked(base.session,base.bindings);ownership(next)
  const before=new Set<number>(),after=new Set<number>(),used=new Set(base.bindings.map(r=>r.id)),rows:FileBinding[]=new Array(next.roots.length)
  const fresh=()=>{const id=idFactory();if(typeof id!=='string'||!id||used.has(id))fail();used.add(id);return id}
  const ordinals=(values:readonly number[],count:number,seen:Set<number>)=>{
   if(!Array.isArray(values))fail();let previous=-1
   for(const id of values){if(!integer(id)||id<=previous||id>=count||seen.has(id))fail();previous=id;seen.add(id)}
  }
  if(!Array.isArray(correspondence))fail()
  for(const component of correspondence){
   if(!component||Object.keys(component).length!==3||Object.keys(component).some(k=>!['kind','beforeRoots','afterRoots'].includes(k)))fail()
   const {beforeRoots:b,afterRoots:a,kind}=component
   ordinals(b,base.session.roots.length,before);ordinals(a,next.roots.length,after)
   if(kind==='untouched'||kind==='retained'){if(b.length!==1||a.length!==1)fail()}
   else if(kind==='split'){if(b.length!==1||a.length<2)fail()}
   else if(kind==='join'){if(b.length<2||a.length!==1)fail()}
   else if(kind==='birth'){if(b.length||!a.length)fail()}
   else if(kind==='deleted'){if(!b.length||a.length)fail()}
   else if(kind==='repartition'){if(!b.length||!a.length)fail()}
   else fail()
   a.forEach((rootOrdinal,i)=>{rows[rootOrdinal]={rootOrdinal,id:(kind==='untouched'||kind==='retained'||kind==='join'||kind==='split'&&i===0)?base.bindings[b[0]].id:fresh()}})
  }
  if(before.size!==base.session.roots.length||after.size!==next.roots.length)fail()
  checked(next,rows);return {ok:true,bindings:freezeRows(rows)}
 }catch{return {ok:false,reason:'invalid-file-correspondence'}}
}
export function restoreBindings(base:Pick<FileState,'session'|'bindings'>,next:SourceSession,transition:Readonly<{before:BindingImage;after:BindingImage}>):BindingsResult {
 try{
  checked(base.session,base.bindings);checked(base.session,transition.before.roots);checked(next,transition.after.roots)
  if(transition.before.sourceHash!==sha256Sync(base.session.source)||transition.after.sourceHash!==sha256Sync(next.source)
   ||base.bindings.some((row,i)=>row.id!==transition.before.roots[i].id))fail()
  return {ok:true,bindings:freezeRows(transition.after.roots)}
 }catch{return {ok:false,reason:'invalid-history-bindings'}}
}
export function restoreRecovery(session:SourceSession,recovery:FileRecovery|undefined,idFactory:()=>string):BindingsResult {
 if(recovery?.v===1&&recovery.sourceHash===sha256Sync(session.source)&&integer(recovery.sourceRevision)&&validateBindings(session,recovery.bindings).ok)
  return {ok:true,bindings:freezeRows(recovery.bindings)}
 try{const rows=session.roots.map(root=>({rootOrdinal:root.id,id:idFactory()}));checked(session,rows);return {ok:true,bindings:freezeRows(rows)}}
 catch{return {ok:false,reason:'invalid-file-bindings'}}
}
