import {EditorState,Plugin,PluginKey,Selection,type Transaction} from 'prosemirror-state'
import type {EditorView} from 'prosemirror-view'
import {Fragment,Slice,type Node,type Schema} from 'prosemirror-model'
import {Step,ReplaceStep,ReplaceAroundStep,AddMarkStep,RemoveMarkStep,AddNodeMarkStep,RemoveNodeMarkStep,AttrStep} from 'prosemirror-transform'
import {history,closeHistory} from 'prosemirror-history'
import {createSourceSession,prepareFileSourceEdits,applySourceBlockTransaction,prepareSourceListBoundarySteps,type SourcePatch} from '@moraya/core'
import {SourceHistoryStep,TableLayoutStep,type TableImage} from '@moraya/core/source-history'
import type {FileIds,FileRecovery,FilePolicy,ObserverDelta,FileResult,FileState,FileSnapshot,FileSlashCommand} from './file-contract'
import {restoreRecovery,restoreBindings,projectBindings,nextBindings,validateBindings} from './file-bindings'
import {createFileProjection,neutralize} from './file-projection'
import {initialLayout,sourceLayout,richLayout,layoutDeltas,validateLayout,sameTableImage,verifyTableIntent} from './file-layout'
import {createFileHistory} from './file-history'
import {sha256Sync} from '../lib/share-merge/hash'
import {runSlashCommand,type SlashCommandTarget} from '../lib/slash-menu/slash-command'
import {prepareFileStructural,type StructuralPreparation,type MoveWitness} from './file-commands'
import type {StructuralCommand} from './contract'
import {editorDelta} from '../lib/insights/observer'
import {richBodySelection} from '../lib/rich-editor-focus'

export interface FileStructuralPort {prepareStructural(command:StructuralCommand):StructuralPreparation;dispatch(tr:Transaction):boolean;probe(tr:Transaction):boolean}
export interface FileControllerOptions {raw:string;authority:string;schema:Schema;ids:FileIds;plugins:Plugin[];recovery?:FileRecovery;onDelta?:(delta:ObserverDelta)=>void;policy?:FilePolicy}
class FileAdmissionFailure extends Error {}
function fail(reason:string):never {throw new FileAdmissionFailure(reason)}
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b)
const standard=[ReplaceStep,ReplaceAroundStep,AddMarkStep,RemoveMarkStep,AddNodeMarkStep,RemoveNodeMarkStep,AttrStep].map(c=>c.prototype)
const stepMethods=['apply','getMap','invert','map','merge','toJSON'] as const
const stepExecutors=new Map([...standard,SourceHistoryStep.prototype,TableLayoutStep.prototype].map(proto=>[proto,stepMethods.map(method=>proto[method])]))
// Seal execution objects as well as JSON: native history calls invert and keeps maps.
// Array values (StepMap ranges, Mapping maps/mirror) are copied for comparison only.
function sealExecutionObject(value:object):()=>boolean {
 const levels:{object:object;prototype:object|null;properties:{key:PropertyKey;descriptor:PropertyDescriptor;items?:unknown[]}[]}[]=[]
 for(let object:object|null=value;object&&object!==Object.prototype;object=Object.getPrototypeOf(object)){
  levels.push({object,prototype:Object.getPrototypeOf(object),properties:Reflect.ownKeys(object).map(key=>{
   const descriptor=Object.getOwnPropertyDescriptor(object!,key)!
   return {key,descriptor,...(Array.isArray(descriptor.value)?{items:[...descriptor.value]}:{})}
  })})
 }
 return ()=>levels.every(({object,prototype,properties})=>Object.getPrototypeOf(object)===prototype&&Reflect.ownKeys(object).length===properties.length&&properties.every(({key,descriptor:d,items})=>{
  const now=Object.getOwnPropertyDescriptor(object,key)
  return !!now&&now.value===d.value&&now.get===d.get&&now.set===d.set&&now.writable===d.writable&&now.enumerable===d.enumerable&&now.configurable===d.configurable
   &&(!items||Array.isArray(now.value)&&now.value.length===items.length&&items.every((item,i)=>item===now.value[i]))
 }))
}
function sealChain(tr:Transaction):()=>boolean {
 for(const step of tr.steps){
  const methods=stepExecutors.get(Object.getPrototypeOf(step))
  if(!methods||stepMethods.some((method,i)=>step[method]!==methods[i]))fail('invalid-step-execution')
 }
 const before=tr.before,doc=tr.doc,steps=[...tr.steps],docs=[...tr.docs],mapping=tr.mapping
 const intact=[...steps,...mapping.maps,mapping].map(sealExecutionObject),json=JSON.stringify(steps.map(step=>step.toJSON()))
 return ()=>tr.before===before&&tr.doc===doc&&tr.mapping===mapping&&tr.steps.length===steps.length&&tr.docs.length===docs.length
  &&steps.every((step,i)=>step===tr.steps[i])&&docs.every((node,i)=>node===tr.docs[i])&&intact.every(check=>check())&&json===JSON.stringify(tr.steps.map(step=>step.toJSON()))
}
function sourceDifference(before:string,after:string):SourcePatch[]{
 if(before===after)return []
 let from=0,left=before.length,right=after.length
 while(from<left&&from<right&&before[from]===after[from])from++
 while(left>from&&right>from&&before[left-1]===after[right-1]){left--;right--}
 const split=(text:string,p:number)=>p>0&&p<text.length&&(text[p-1]==='\r'&&text[p]==='\n'||/[\uD800-\uDBFF]/.test(text[p-1])&&/[\uDC00-\uDFFF]/.test(text[p]))
 while(split(before,from)||split(after,from))from--
 while(split(before,left)||split(after,right)){left++;right++}
 return [{from,to:left,removed:before.slice(from,left),text:after.slice(from,right)}]
}
function middleReplace(before:Node,target:Node,tr:Transaction):void{
 let start=0,endBefore=before.childCount,endAfter=target.childCount,from=0,to=before.content.size
 while(start<endBefore&&start<endAfter&&before.child(start).eq(target.child(start))){from+=before.child(start).nodeSize;start++}
 while(endBefore>start&&endAfter>start&&before.child(endBefore-1).eq(target.child(endAfter-1))){to-=before.child(--endBefore).nodeSize;endAfter--}
 if(start<endBefore||start<endAfter){const nodes:Node[]=[];for(let i=start;i<endAfter;i++)nodes.push(target.child(i));tr.step(new ReplaceStep(from,to,new Slice(Fragment.fromArray(nodes),0,0)))}
 if(!tr.doc.eq(target))fail('source-middle-replace')
}
export function createFileController(options:FileControllerOptions){
 const source=createSourceSession(options.raw,options.schema);if(!source.ok)throw Error(source.reason)
 const rows=restoreRecovery(source.session,options.recovery,options.ids.blockId);if(!rows.ok)throw Error(rows.reason)
 const initial:FileState=Object.freeze({session:source.session,bindings:rows.bindings,sourceHash:sha256Sync(options.raw),sourceLineage:options.ids.lineage(),layout:initialLayout(source.session.doc,options.ids.tableId),authority:options.authority,generation:0})
 const key=new PluginKey<FileState>('file'),historyKey=history().spec.key!
 if(options.plugins.filter(p=>p.spec.key===historyKey).length!==1)throw Error('file-requires-one-native-history')
 const projection=createFileProjection(),listeners=new Set<(snapshot:FileSnapshot)=>void>(),viewListeners=new Set<()=>void>()
 let current:EditorState,attached:EditorView|null=null,readOnly=false,composing=false,inDispatch=false,lastError:unknown=null
 type Intent={kind:'source'|'restore'|'insert'|'history'|'layout';base:FileState;next:FileState;chain:()=>boolean}
 type Prepared={base:FileState;chain:()=>boolean;next:FileState;addToHistory:unknown;historyMeta:unknown;appended:unknown;intent:Intent|undefined}
 type Frame={root:Transaction;failed:boolean;prepared:Set<Transaction>;rootKind:string}
 let active:Frame|null=null
 const slashHints=new WeakMap<Transaction,{base:EditorState;records:{state:EditorState;tr:Transaction;offset:number;steps:readonly Step[]}[]}>()
 const moves=new WeakMap<Transaction,MoveWitness>()
 const intents=new WeakMap<Transaction,Intent>(),prepared=new WeakMap<Transaction,Prepared>()
 const read=(state:EditorState)=>key.getState(state)??fail('missing-file-state')
 const writable=()=>!readOnly&&!composing
 const snapshot=():FileSnapshot=>{const s=read(current);return Object.freeze({raw:s.session.source,sourceRevision:s.session.revision,generation:s.generation,authority:s.authority,sourceLineage:s.sourceLineage,sourceHash:s.sourceHash,bindings:s.bindings})}
 function validateFinal(state:EditorState){const s=read(state);if(!state.doc.eq(projectBindings(s.session,s.bindings)))fail('invalid-final-projection');validateLayout(state.doc,s.layout)}
 function appendPayload(tr:Transaction,base:FileState,next:FileState,edits:readonly SourcePatch[]){
  if(next.session.source!==base.session.source){
   tr.step(new SourceHistoryStep([{beforeLineage:base.sourceLineage,afterLineage:next.sourceLineage,beforeHash:base.sourceHash,afterHash:next.sourceHash,edits:SourceHistoryStep.canonicalEdits(edits),...(!same(base.bindings,next.bindings)?{bindings:{before:{sourceHash:base.sourceHash,roots:base.bindings},after:{sourceHash:next.sourceHash,roots:next.bindings}}}:{})}]))
  }
  const deltas=layoutDeltas(base.layout,next.layout);if(deltas.length)tr.step(new TableLayoutStep(deltas))
 }
 function register(tr:Transaction,kind:Intent['kind'],base:FileState,next:FileState){intents.set(tr,{kind,base,next,chain:sealChain(tr)})}
 function sourceTransaction(value:string,kind:'source'|'restore'|'insert',insert?:{content:string;from:number;to:number;at:number;eol:string}):{tr:Transaction;changed:boolean}{
  const base=read(current),edits=sourceDifference(base.session.source,value),tr=current.tr
  if(!edits.length)return {tr,changed:false}
  const update=prepareFileSourceEdits(base.session,{expectedRevision:base.session.revision,edits});if(!update.ok)fail(update.reason)
  if(insert){
   const births=update.file.correspondence.filter(c=>c.kind==='birth')
   const intact=update.file.correspondence.filter(c=>c.kind!=='birth')
   const oldRaw=base.session.source
   const unchanged=intact.every(c=>{
    if(c.beforeRoots.length!==1||c.afterRoots.length!==1)return false
    const old=base.session.roots[c.beforeRoots[0]],next=update.session.roots[c.afterRoots[0]]
    const before=oldRaw.slice(old.sourceFrom,old.sourceTo),after=update.session.source.slice(next.sourceFrom,next.sourceTo)
    if(c.kind==='untouched')return before===after
    return c.kind==='retained'&&insert.at===oldRaw.length&&old.sourceTo===oldRaw.length&&!/[\r\n]$/.test(oldRaw)
     &&update.session.source.slice(0,oldRaw.length)===oldRaw&&after===before+insert.eol
     &&base.session.doc.slice(old.pmFrom,old.pmTo).content.eq(update.session.doc.slice(next.pmFrom,next.pmTo).content)
   })
   const trimmed=insert.content.trim(),offset=insert.content.indexOf(trimmed),natural=births.length===1&&births[0].afterRoots.length===1?update.session.roots[births[0].afterRoots[0]]:undefined
   if(!natural||!trimmed||natural.sourceFrom>insert.from+offset||natural.sourceTo<insert.from+offset+trimmed.length||intact.length!==base.session.roots.length||update.file.correspondence.length!==intact.length+1
    ||!unchanged)fail('unsupported-block-insert')
  }
  const result=nextBindings(base,update.session,update.file.correspondence,options.ids.blockId);if(!result.ok)fail(result.reason)
  const next:FileState=Object.freeze({...base,session:update.session,bindings:result.bindings,sourceHash:sha256Sync(update.session.source),sourceLineage:options.ids.lineage(),layout:sourceLayout(base,update.session,update.file.correspondence,options.ids.tableId),generation:base.generation+1})
  middleReplace(current.doc,projectBindings(next.session,next.bindings),tr)
  appendPayload(tr,base,next,update.edits);register(tr,kind,base,next)
  return {tr,changed:true}
 }
 function prepareHistory(tr:Transaction):boolean{
  try{
   // Native popEvent may return the installed branch's inverse Step itself.
   // Protect those immutable execution values before a later filter sees them.
   for(const value of [...tr.steps,...tr.mapping.maps]){
    for(const field of Object.values(value))if(Array.isArray(field))Object.freeze(field)
    Object.freeze(value)
   }
   const base=read(current);let next=base,rawPayload=false,layoutPayload=false
   for(let i=0;i<tr.steps.length;i++){
    const step=tr.steps[i],proto=Object.getPrototypeOf(step),before=tr.docs[i],after=tr.docs[i+1]??tr.doc
    if(!step.apply(before).doc?.eq(after))fail('invalid-history-chain')
    if(proto===SourceHistoryStep.prototype){
     for(const delta of (step as SourceHistoryStep).deltas){
      if(delta.beforeLineage!==next.sourceLineage||delta.beforeHash!==next.sourceHash)fail('stale-history-source')
      const update=prepareFileSourceEdits(next.session,{expectedRevision:next.session.revision,edits:delta.edits});if(!update.ok||sha256Sync(update.session.source)!==delta.afterHash)fail('invalid-history-source')
      const restored=delta.bindings?restoreBindings(next,update.session,delta.bindings):validateBindings(update.session,next.bindings).ok?{ok:true as const,bindings:next.bindings}:{ok:false as const,reason:'invalid-history-bindings'}
      if(!restored.ok)fail(restored.reason)
      if(!delta.bindings&&update.file.correspondence.some(c=>c.kind!=='untouched'&&c.kind!=='retained'))fail('missing-history-bindings')
      next={...next,session:update.session,bindings:restored.bindings,sourceHash:delta.afterHash,sourceLineage:delta.afterLineage};rawPayload=true
     }
    }else if(proto===TableLayoutStep.prototype){
     const layout=new Map(next.layout)
     for(const delta of (step as TableLayoutStep).deltas){if(!sameTableImage(layout.get(delta.id),delta.before))fail('stale-history-layout');if(delta.after)layout.set(delta.id,delta.after);else layout.delete(delta.id)}
     next={...next,layout};layoutPayload=true
    }else if(!standard.includes(proto))fail('unsupported-history-step')
   }
   if(!rawPayload&&neutralize(tr.doc).eq(next.session.doc)){
    const bindings=next.session.roots.map(root=>({rootOrdinal:root.id,id:tr.doc.child(root.childFrom).attrs.cdrBlockId as string}))
    const oldIds=new Set(next.bindings.map(row=>row.id))
    if(!validateBindings(next.session,bindings).ok||bindings.some(row=>!oldIds.has(row.id))||!tr.doc.eq(projectBindings(next.session,bindings)))fail('invalid-history-identities')
    next={...next,bindings:Object.freeze(bindings.map(row=>Object.freeze(row)))}
   }else if(!rawPayload&&!layoutPayload)fail('missing-history-payload')
   if(!tr.doc.eq(projectBindings(next.session,next.bindings)))fail('missing-history-payload')
   validateLayout(tr.doc,next.layout)
   next=Object.freeze({...next,generation:base.generation+1});register(tr,'history',base,next);return true
  }catch(error){lastError=error;return false}
 }
 function prepareActual(tr:Transaction,state:EditorState):Prepared{
  const base=read(state),intent=intents.get(tr)
  if(!active)fail('outside-file-admission')
  if(tr.before!==state.doc)fail('stale-file-transaction')
  if(tr.getMeta('appendedTransaction')!==undefined)fail('forged-append-origin')
  if(!intent&&tr.getMeta(historyKey)!==undefined)fail('forged-history-origin')
  let next=base
  if(tr.steps.length){
   if(!writable()||tr.getMeta('addToHistory')===false)fail('unsupported-file-change')
   if(intent){
    if(intent.base!==base||!intent.chain())fail('stale-file-intent')
    next=intent.next
   }else{
    if(active.root!==tr&&active.rootKind!=='local-rich')fail('unsupported-file-append')
    const slash=slashHints.get(tr)
    if(slash){
     if(slash.base!==state)fail('stale-slash-command')
     for(const record of slash.records){
      if(record.steps.some((step,i)=>tr.steps[record.offset+i]!==step))fail('invalid-slash-table-chain')
      verifyTableIntent(record.state,record.tr)
     }
    }
    const hint=verifyTableIntent(state,tr),projected=projection.project(base,tr);if(!projected.ok)fail(projected.reason)
    const boundary=prepareSourceListBoundarySteps(base.session,projected.transaction);if(!boundary.ok)fail(boundary.reason)
    for(const step of boundary.steps){tr.step(step);projected.transaction.step(step)}
    const update=applySourceBlockTransaction(base.session,projected.transaction);if(!update.ok)fail(update.reason)
    const result=update.file?nextBindings(base,update.session,update.file.correspondence,options.ids.blockId):{ok:true as const,bindings:base.bindings}
    if(!result.ok)fail(result.reason)
    const move=moves.get(tr)
    if(move){
     const a=tr.steps[0],b=tr.steps[1]
     if(move.generation!==base.generation||Object.getPrototypeOf(a)!==ReplaceStep.prototype||Object.getPrototypeOf(b)!==ReplaceStep.prototype)fail('invalid-move-witness')
     const remove=a as ReplaceStep,insert=b as ReplaceStep
     if(remove.from!==move.from||remove.to!==move.to||remove.slice.size||insert.from!==move.insertAt||insert.to!==move.insertAt||!insert.slice.eq(move.slice)||!tr.before.slice(move.from,move.to).eq(move.slice)||remove.getMap().map(move.target)!==move.insertAt)fail('invalid-move-witness')
     const tail=tr.mapping.slice(2),from=tail.map(move.insertAt,-1),to=tail.map(move.insertAt+move.slice.size,1),root=update.session.roots.find(r=>r.pmFrom===from&&r.pmTo===to)
     if(!root)fail('invalid-move-target')
     const inherited=new Map<number,string>([[root.id,move.id]])
     for(const original of base.session.roots){
      if(original.id===move.rootOrdinal)continue
      const start=tr.mapping.map(original.pmFrom,1),end=tr.mapping.map(original.pmTo,-1),target=update.session.roots.find(r=>r.pmFrom===start&&r.pmTo===end)
      if(!target||!tr.before.slice(original.pmFrom,original.pmTo).content.eq(tr.doc.slice(start,end).content))fail('invalid-move-correspondence')
      inherited.set(target.id,base.bindings[original.id].id)
     }
     if(inherited.size!==update.session.roots.length)fail('invalid-move-roots')
     result.bindings=Object.freeze(result.bindings.map(row=>Object.freeze({...row,id:inherited.get(row.rootOrdinal)!})))
     if(!validateBindings(update.session,result.bindings).ok)fail('invalid-move-bindings')
    }
    const identity=projection.appendBindings(tr,update.session,result.bindings);if(!identity.ok)fail(identity.reason)
    next=Object.freeze({...base,session:update.session,bindings:result.bindings,sourceHash:sha256Sync(update.session.source),sourceLineage:update.session.source===base.session.source?base.sourceLineage:options.ids.lineage(),layout:richLayout(base,tr,options.ids.tableId,hint),generation:base.generation+1})
    if(move){
     const layout=new Map(next.layout)
     for(const [id,old] of base.layout)if(old.position>=move.from&&old.position<move.to){
      const position=tr.mapping.slice(2).map(move.insertAt+old.position-move.from,-1)
      for(const [created,t] of layout)if(t.position===position)layout.delete(created)
      layout.set(id,Object.freeze({...old,position}))
     }
     next=Object.freeze({...next,layout})
    }
    appendPayload(tr,base,next,update.edits.map(e=>({...e,removed:base.session.source.slice(e.from,e.to)})))
   }
  }
  const value:Prepared={base,chain:sealChain(tr),next,addToHistory:tr.getMeta('addToHistory'),historyMeta:tr.getMeta(historyKey),appended:active.root===tr?undefined:active.root,intent}
  prepared.set(tr,value);active.prepared.add(tr);return value
 }
 const first=new Plugin<FileState>({key,state:{init:()=>initial,apply(tr,value){
  const p=prepared.get(tr)
  if(!p||p.base!==value||!p.chain()||p.addToHistory!==tr.getMeta('addToHistory')||p.historyMeta!==tr.getMeta(historyKey)||p.appended!==tr.getMeta('appendedTransaction')||p.intent!==intents.get(tr))fail('mutated-file-admission')
  return p.next
 }},filterTransaction(tr,state){try{prepareActual(tr,state);return true}catch(error){if(active)active.failed=true;lastError=error;return false}}})
 function admit(tr:Transaction,execute:boolean):boolean{
  if(inDispatch||tr.before!==current.doc)return false
  const base=current,frame:Frame={root:tr,failed:false,prepared:new Set(),rootKind:intents.get(tr)?.kind??'local-rich'}
  inDispatch=true;active=frame
  try{
   const result=base.applyTransaction(tr)
   if(frame.failed||!result.transactions.length)return false
   const applied=new Set(result.transactions);for(const t of frame.prepared)if(t.steps.length&&!applied.has(t))return false
   validateFinal(result.state)
   const before=read(base),after=read(result.state)
   if(options.policy&&!options.policy.acceptRawChange(before.session.source,after.session.source))return false
   if(!execute)return true
   current=result.state
   try{attached?.updateState(current)}catch(error){lastError=error}
   for(const listener of viewListeners)try{listener()}catch(error){lastError=error}
   if(before.sourceHash!==after.sourceHash||before.session.source!==after.session.source){
    const value=snapshot(),subscribers=[...listeners],delta=editorDelta(result.transactions,base.doc,current.doc)
    queueMicrotask(()=>{
     for(const listener of subscribers)if(listeners.has(listener))try{listener(value)}catch(error){lastError=error}
     try{options.onDelta?.(delta)}catch(error){lastError=error}
    })
   }
   return true
  }catch(error){lastError=error;return false}finally{active=null;inDispatch=false}
 }
 const historyCommands=createFileHistory({get state(){return current},get view(){return attached},prepareHistory,admit,writable})
 const doc=projectBindings(initial.session,initial.bindings),selection=richBodySelection(doc)
 current=EditorState.create({doc,...(selection?{selection}:{}),plugins:[first,historyCommands.plugin,...options.plugins]})
 function replaceSource(input:{expectedGeneration:number;value:string},kind:'source'|'restore'='source'):FileResult{
  if(input.expectedGeneration!==read(current).generation)return {ok:false,reason:'stale-source'}
  if(!writable()||inDispatch)return {ok:false,reason:'file-not-writable'}
  try{
   const {tr,changed}=sourceTransaction(input.value,kind)
   if(!changed)return {ok:true,changed:false,snapshot:snapshot()}
   if(kind==='restore')closeHistory(tr)
   if(!admit(tr,true))return {ok:false,reason:lastError instanceof Error?lastError.message:'file-rejected'}
   if(kind==='restore')admit(closeHistory(current.tr),true)
   return {ok:true,changed:true,snapshot:snapshot()}
  }catch(error){lastError=error;return {ok:false,reason:error instanceof Error?error.message:'file-rejected'}}
 }
 return {
  get state(){return current},get view(){return attached},get diagnostic(){return lastError},snapshot,
  dispatch(tr:Transaction){
   const move=moves.has(tr);if(move)closeHistory(tr)
   const accepted=admit(tr,true);if(accepted&&move)admit(closeHistory(current.tr),true)
   return accepted
  },probe:(tr:Transaction)=>admit(moves.has(tr)?closeHistory(tr):tr,false),replaceSource,
  restoreContent:(raw:string)=>replaceSource({expectedGeneration:read(current).generation,value:raw},'restore'),runHistory:historyCommands.run,
  bindView(view:EditorView|null){if(view&&view.state!==current)throw Error('file-view-state-mismatch');attached=view;for(const listener of viewListeners)listener()},
  setReadOnly(value:boolean){readOnly=value;for(const listener of viewListeners)listener()},setComposing(value:boolean){composing=value;for(const listener of viewListeners)listener()},
  observe(listener:(snapshot:FileSnapshot)=>void){listeners.add(listener);return ()=>{listeners.delete(listener)}},
  observeView(listener:()=>void){viewListeners.add(listener);return ()=>{viewListeners.delete(listener)}},
  prepareStructural(command:StructuralCommand):StructuralPreparation{
   if(!writable()||inDispatch)return {ok:false,reason:'file-not-writable'}
   try{
    const result=prepareFileStructural(current,read(current),command)
    if(!result.ok)return result
    if(result.insert){const source=sourceTransaction(result.insert.value,'insert',result.insert);return {ok:true,...source}}
    if(result.move)moves.set(result.tr,result.move)
    return result
   }catch(error){lastError=error;return {ok:false,reason:error instanceof Error?error.message:'file-rejected'}}
  },
  executeSlashCommand(id:FileSlashCommand,execute:boolean):boolean{
   if(!writable()||inDispatch)return false
   const {selection}=current,{$from}=selection
   if(!selection.empty||$from.parent.type!==current.schema.nodes.paragraph||!/^\/([a-zA-Z0-9一-龥]*)$/.test($from.parent.textBetween(0,$from.parentOffset)))return false
   const base=current,combined=closeHistory(base.tr),records:{state:EditorState;tr:Transaction;offset:number;steps:readonly Step[]}[]=[];let draft=EditorState.create({schema:base.schema,doc:base.doc,selection:base.selection,storedMarks:base.storedMarks}),focus=false,count=0
   const target:SlashCommandTarget={get state(){return draft},focus(){focus=true},dispatch(tr){
    if(tr.before!==draft.doc||tr.doc.type.schema!==base.schema||tr.steps.length!==tr.docs.length)fail('invalid-slash-chain')
    if(Object.keys((tr as unknown as {meta:Record<string,unknown>}).meta).some(k=>k!=='moraya:gfm-table-operation'))fail('unsupported-slash-metadata')
    if(verifyTableIntent(draft,tr))records.push({state:draft,tr,offset:combined.steps.length,steps:[...tr.steps]})
    for(let i=0;i<tr.steps.length;i++){
     const step=tr.steps[i],before=tr.docs[i],after=tr.docs[i+1]??tr.doc
     if(!standard.includes(Object.getPrototypeOf(step))||before!==combined.doc&&!before.eq(combined.doc)||!step.apply(before).doc?.eq(after))fail('invalid-slash-step')
     combined.step(step)
    }
    draft=draft.apply(tr);combined.setSelection(Selection.fromJSON(combined.doc,draft.selection.toJSON()));combined.setStoredMarks(draft.storedMarks)
    if(tr.scrolledIntoView)combined.scrollIntoView()
    count++
   }}
   try{
    target.dispatch(draft.tr.delete($from.start(),selection.from))
    if(!runSlashCommand(target,id)||count<2||!combined.doc.eq(draft.doc)||!combined.selection.eq(draft.selection)||!same(combined.storedMarks,draft.storedMarks))return false
    slashHints.set(combined,{base,records})
    if(!admit(combined,execute))return false
    if(execute){admit(closeHistory(current.tr),true);if(focus)try{attached?.focus()}catch(error){lastError=error}}
    return true
   }catch(error){lastError=error;return false}
  },
  writable,
  readTable(position:number){for(const [id,value] of read(current).layout)if(value.position===position)return {id,...value};return null},
  readLayout(){return new Map(read(current).layout)},
  commitWidth(input:{generation:number;tableId:string;beforeWidths:readonly(number|null)[];afterWidths:readonly(number|null)[]}):boolean{
   const base=read(current),old=base.layout.get(input.tableId)
   if(!writable()||!old||input.generation!==base.generation||!same(old.widths,input.beforeWidths)||same(old.widths,input.afterWidths)||input.afterWidths.length!==old.columns||input.afterWidths.some(w=>w!==null&&(!Number.isFinite(w)||w<25)))return false
   const layout=new Map(base.layout);layout.set(input.tableId,Object.freeze({...old,widths:Object.freeze([...input.afterWidths])}))
   const next=Object.freeze({...base,layout,generation:base.generation+1}),tr=closeHistory(current.tr)
   appendPayload(tr,base,next,[]);register(tr,'layout',base,next)
   if(!admit(tr,true))return false
   admit(closeHistory(current.tr),true);return true
  },
 }
}
export type FileController=ReturnType<typeof createFileController>
