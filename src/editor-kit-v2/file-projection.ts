import {Fragment,Slice,type Node} from 'prosemirror-model'
import {EditorState,type Transaction} from 'prosemirror-state'
import {Step,ReplaceStep,ReplaceAroundStep,AddMarkStep,RemoveMarkStep,AddNodeMarkStep,RemoveNodeMarkStep,AttrStep} from 'prosemirror-transform'
import type {SourceSession} from '@moraya/core'
import type {FileBinding,FileFailure,FileState} from './file-contract'
import {BLOCK_ID_ATTR} from './identity'
import {projectBindings,validateBindings} from './file-bindings'

const memo=new WeakMap<Node,Node>()
export function neutralize(node:Node):Node {
 const known=memo.get(node);if(known)return known
 const nodes:Node[]=[];let changed=false
 node.forEach(child=>{const n=neutralize(child);nodes.push(n);changed ||= n!==child})
 const tagged=Object.hasOwn(node.type.spec.attrs??{},BLOCK_ID_ATTR)&&node.attrs[BLOCK_ID_ATTR]!==null
 const result=tagged?node.type.create({...node.attrs,[BLOCK_ID_ATTR]:null},Fragment.fromArray(nodes),node.marks)
  :changed?node.copy(Fragment.fromArray(nodes)):node
 memo.set(node,result);return result
}
export function assertProjection(business:Node,session:SourceSession):void {
 if(business.type.schema!==session.doc.type.schema||!neutralize(business).eq(session.doc))throw Error('invalid-file-projection')
}
function fail():never {throw Error('invalid-file-projection')}
function cleanSlice(slice:Slice,allowed:ReadonlySet<string>):Slice {
 const nodes:Node[]=[]
 const check=(node:Node)=>{
  if(Object.hasOwn(node.type.spec.attrs??{},BLOCK_ID_ATTR)){
   const id=node.attrs[BLOCK_ID_ATTR]
   if(id!==null&&(typeof id!=='string'||!allowed.has(id)))fail()
  }
  node.forEach(check)
 }
 slice.content.forEach(node=>{check(node);nodes.push(neutralize(node))})
 return new Slice(Fragment.fromArray(nodes),slice.openStart,slice.openEnd)
}
/** Exact prototypes preserve every original range and slice open depth. */
function projectStandardStep(step:Step,allowed:ReadonlySet<string>):Step {
 const proto=Object.getPrototypeOf(step)
 if(proto===ReplaceStep.prototype){const s=step as ReplaceStep;return new ReplaceStep(s.from,s.to,cleanSlice(s.slice,allowed),(s as ReplaceStep&{structure:boolean}).structure)}
 if(proto===ReplaceAroundStep.prototype){const s=step as ReplaceAroundStep;return new ReplaceAroundStep(s.from,s.to,s.gapFrom,s.gapTo,cleanSlice(s.slice,allowed),s.insert,(s as ReplaceAroundStep&{structure:boolean}).structure)}
 if(proto===AddMarkStep.prototype){const s=step as AddMarkStep;return new AddMarkStep(s.from,s.to,s.mark)}
 if(proto===RemoveMarkStep.prototype){const s=step as RemoveMarkStep;return new RemoveMarkStep(s.from,s.to,s.mark)}
 if(proto===AddNodeMarkStep.prototype){const s=step as AddNodeMarkStep;return new AddNodeMarkStep(s.pos,s.mark)}
 if(proto===RemoveNodeMarkStep.prototype){const s=step as RemoveNodeMarkStep;return new RemoveNodeMarkStep(s.pos,s.mark)}
 if(proto===AttrStep.prototype){const s=step as AttrStep;return new AttrStep(s.pos,s.attr,s.value)}
 return fail()
}
/** Given the previous invariant, standard local steps can only affect these
 * subtrees. Memoization avoids recursively visiting untouched business nodes. */
function sameLocal(business:Node,canonical:Node,step:Step,after:boolean):boolean {
 if(!business.sameMarkup(canonical)||business.content.size!==canonical.content.size)return false
 const proto=Object.getPrototypeOf(step)
 if(proto===AttrStep.prototype||proto===AddNodeMarkStep.prototype||proto===RemoveNodeMarkStep.prototype){
  const pos=(step as AttrStep).pos,a=business.nodeAt(pos),b=canonical.nodeAt(pos)
  return !!a&&!!b&&neutralize(a).eq(b)
 }
 if(proto===ReplaceStep.prototype){
  const s=step as ReplaceStep,from=s.from,to=after?s.from+s.slice.size:s.to
  const a=business.resolve(from),b=business.resolve(to)
  if(a.sameParent(b)&&a.parent.inlineContent&&!s.slice.openStart&&!s.slice.openEnd)
   return neutralize(a.parent).eq(canonical.resolve(from).parent)
 }
 if(proto===AddMarkStep.prototype||proto===RemoveMarkStep.prototype){
  const s=step as AddMarkStep,a=business.resolve(s.from),b=business.resolve(s.to)
  if(a.sameParent(b))return neutralize(a.parent).eq(canonical.resolve(s.from).parent)
  for(let i=a.index(0);i<=Math.min(b.index(0),business.childCount-1);i++)if(!neutralize(business.child(i)).eq(canonical.child(i)))return false
  return true
 }
 return neutralize(business).eq(canonical)
}
export function createFileProjection(){
 type Grant={tr:Transaction;before:Node;after:Node;value:unknown;pos:number}
 const grants=new WeakMap<Step,Grant>()
 return {
  project(base:Pick<FileState,'session'|'bindings'>,tr:Transaction):{ok:true;transaction:Transaction}|FileFailure {
   try{
    if(!validateBindings(base.session,base.bindings).ok||tr.steps.length!==tr.docs.length)fail()
    assertProjection(tr.before,base.session)
    if(!tr.before.eq(projectBindings(base.session,base.bindings)))fail()
    const replay=EditorState.create({doc:base.session.doc}).tr,allowed=new Set(base.bindings.map(row=>row.id))
    let identityOnly=false
    for(let i=0;i<tr.steps.length;i++){
     const step=tr.steps[i],before=tr.docs[i],after=tr.docs[i+1]??tr.doc,grant=grants.get(step)
     // Check prototype before invoking an untrusted Step implementation.
     if(Object.getPrototypeOf(step)===AttrStep.prototype&&(step as AttrStep).attr===BLOCK_ID_ATTR
      &&Object.hasOwn(before.nodeAt((step as AttrStep).pos)?.type.spec.attrs??{},BLOCK_ID_ATTR)){
      const s=step as AttrStep
      if(!grant||grant.tr!==tr||grant.before!==before||grant.after!==after||grant.pos!==s.pos||grant.value!==s.value)fail()
      if(!s.apply(before).doc?.eq(after)||!sameLocal(before,replay.doc,step,false)||!sameLocal(after,replay.doc,step,true))fail()
      if(typeof s.value==='string')allowed.add(s.value)
      continue
     }
     const projected=projectStandardStep(step,allowed)
     if(!step.apply(before).doc?.eq(after)||!sameLocal(before,replay.doc,step,false))fail()
     const result=replay.maybeStep(projected);if(result.failed||!sameLocal(after,replay.doc,step,true))fail()
     if(!before.eq(after)&&sameLocal(before,replay.doc,step,false))identityOnly=true
    }
    if(!neutralize(tr.doc).eq(replay.doc)||identityOnly&&replay.doc.eq(base.session.doc))fail()
    return {ok:true,transaction:replay}
   }catch{return {ok:false,reason:'invalid-file-projection'}}
  },
  appendBindings(tr:Transaction,session:SourceSession,rows:readonly FileBinding[]):{ok:true}|FileFailure {
   try{
    const target=projectBindings(session,rows);assertProjection(tr.doc,session)
    const pending:{pos:number;value:unknown}[]=[]
    tr.doc.descendants((node,pos)=>{
     const expected=target.nodeAt(pos);if(!expected||node.type!==expected.type)fail()
     if(Object.hasOwn(node.type.spec.attrs??{},BLOCK_ID_ATTR)&&node.attrs[BLOCK_ID_ATTR]!==expected.attrs[BLOCK_ID_ATTR])pending.push({pos,value:expected.attrs[BLOCK_ID_ATTR]})
    })
    // All validation precedes mutation; callers must discard a failed candidate.
    for(const {pos,value} of pending){const before=tr.doc,step=new AttrStep(pos,BLOCK_ID_ATTR,value);tr.step(step);grants.set(step,{tr,before,after:tr.doc,value,pos})}
    if(!tr.doc.eq(target))fail();assertProjection(tr.doc,session);return {ok:true}
   }catch{return {ok:false,reason:'invalid-file-projection'}}
  },
 }
}
