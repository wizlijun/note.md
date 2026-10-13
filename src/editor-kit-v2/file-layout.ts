import type {Node} from 'prosemirror-model'
import {EditorState,type Transaction} from 'prosemirror-state'
import {gfmTableCommand,type GfmTableAction} from '@moraya/core/commands'
import type {FileRootCorrespondence,SourceSession} from '@moraya/core'
import type {TableImage,TableDelta} from '@moraya/core/source-history'
import type {FileState} from './file-contract'

export function scanTables(doc:Node):TableImage[]{
 const tables:TableImage[]=[]
 doc.descendants((table,position)=>{
  if(table.type.name!=='table')return true
  const columns=table.firstChild?.childCount??0
  let valid=columns>0
  table.forEach((row,_offset,index)=>{
   valid &&= row.type.name===(index===0?'table_header_row':'table_row')&&row.childCount===columns
   row.forEach(cell=>{valid &&= cell.type.name===(index===0?'table_header':'table_cell')&&cell.attrs.colspan===1&&cell.attrs.rowspan===1&&cell.attrs.colwidth===null})
  })
  if(valid)tables.push(image(position,columns,Array(columns).fill(null)))
  return true
 })
 return tables
}
const image=(position:number,columns:number,widths:readonly (number|null)[]):TableImage=>Object.freeze({position,columns,widths:Object.freeze([...widths])})
export const sameTableImage=(a:TableImage|null|undefined,b:TableImage|null|undefined):boolean=>JSON.stringify(a??null)===JSON.stringify(b??null)
export function initialLayout(doc:Node,ids:()=>string):ReadonlyMap<string,TableImage>{return new Map(scanTables(doc).map(t=>[ids(),t]))}
export function layoutDeltas(before:ReadonlyMap<string,TableImage>,after:ReadonlyMap<string,TableImage>):readonly TableDelta[]{
 const deltas:TableDelta[]=[]
 for(const id of [...new Set([...before.keys(),...after.keys()])].sort()){
  const a=before.get(id)??null,b=after.get(id)??null
  if(!sameTableImage(a,b))deltas.push(Object.freeze({id,before:a?image(a.position,a.columns,a.widths):null,after:b?image(b.position,b.columns,b.widths):null}))
 }
 return Object.freeze(deltas)
}
export function validateLayout(doc:Node,layout:ReadonlyMap<string,TableImage>):void {
 const tables=scanTables(doc),positions=new Set<number>()
 if(tables.length!==layout.size)throw Error('invalid-file-layout')
 for(const value of layout.values()){
  if(positions.has(value.position)||!tables.some(t=>t.position===value.position&&t.columns===value.columns)||value.widths.length!==value.columns||value.widths.some(w=>w!==null&&(!Number.isFinite(w)||w<25)))throw Error('invalid-file-layout')
  positions.add(value.position)
 }
}
export type TableIntent=Readonly<{v:1;kind:GfmTableAction['kind'];tablePos:number;column:number}>
export function verifyTableIntent(state:EditorState,tr:Transaction):TableIntent|null {
 const hint=tr.getMeta('moraya:gfm-table-operation') as TableIntent|undefined
 if(hint===undefined)return null
 if(!hint||hint.v!==1||Object.keys(hint).sort().join(',')!=='column,kind,tablePos,v'||!Number.isSafeInteger(hint.tablePos)||!Number.isSafeInteger(hint.column))throw Error('invalid-table-intent')
 let action:GfmTableAction
 if(hint.kind==='align-column'){
  const alignment=tr.doc.nodeAt(hint.tablePos)?.firstChild?.child(hint.column).attrs.alignment
  action={kind:hint.kind,alignment}
 }else action={kind:hint.kind} as GfmTableAction
 let expected:Transaction|undefined
 if(!gfmTableCommand(action)(state,t=>{expected=t})||!expected||JSON.stringify(expected.getMeta('moraya:gfm-table-operation'))!==JSON.stringify(hint)
  ||!expected.doc.eq(tr.doc)||JSON.stringify(expected.steps.map(s=>s.toJSON()))!==JSON.stringify(tr.steps.map(s=>s.toJSON())))throw Error('invalid-table-intent')
 return hint
}
/** Keep an occurrence only when its mapped outer boundary survives, or a
 * verified whole-table producer supplies the structural correspondence. */
export function richLayout(base:FileState,tr:Transaction,ids:()=>string,hint:TableIntent|null):ReadonlyMap<string,TableImage>{
 const tables=scanTables(tr.doc),next=new Map<string,TableImage>(),claimed=new Set<number>()
 for(const [id,old] of base.layout){
  const original=tr.before.nodeAt(old.position);if(!original)throw Error('invalid-file-layout')
  const from=tr.mapping.mapResult(old.position,1),to=tr.mapping.mapResult(old.position+original.nodeSize,-1)
  const matched=tables.find(t=>t.position===from.pos&&t.position+(tr.doc.nodeAt(t.position)?.nodeSize??0)===to.pos)
  if(!matched)continue
  let widths=[...old.widths]
  if(hint?.tablePos===old.position&&hint.kind!=='insert'){
   if(hint.kind==='add-column')widths.splice(hint.column+1,0,null)
   if(hint.kind==='delete-column')widths.splice(hint.column,1)
  }else if(from.deleted||to.deleted)continue
  if(widths.length!==matched.columns)continue
  next.set(id,image(matched.position,matched.columns,widths));claimed.add(matched.position)
 }
 for(const table of tables)if(!claimed.has(table.position))next.set(ids(),table)
 return next
}
function tablePath(doc:Node,position:number):number[]{const r=doc.resolve(position),path:number[]=[];for(let d=0;d<=r.depth;d++)path.push(r.index(d));return path}
function atPath(doc:Node,path:readonly number[]):{node:Node;position:number}|null{
 let node=doc,position=-1
 for(const index of path){if(index>=node.childCount)return null;position++;for(let i=0;i<index;i++)position+=node.child(i).nodeSize;node=node.child(index)}
 return {node,position}
}
export function sourceLayout(base:FileState,session:SourceSession,correspondence:readonly FileRootCorrespondence[],ids:()=>string):ReadonlyMap<string,TableImage>{
 const tables=scanTables(session.doc),next=new Map<string,TableImage>(),claimed=new Set<number>()
 for(const [id,old] of base.layout){
  const root=base.session.roots.find(r=>r.pmFrom<=old.position&&r.pmTo>old.position)
  if(!root)continue
  const pair=correspondence.find(c=>c.beforeRoots.length===1&&c.beforeRoots[0]===root.id&&c.afterRoots.length===1)
  if(!pair)continue
  const target=session.roots[pair.afterRoots[0]],path=tablePath(base.session.doc,old.position)
  let position:number|undefined
  if(pair.kind==='untouched'){
   path[0]=target.childFrom+(path[0]-root.childFrom);const at=atPath(session.doc,path)
   if(at?.node.type.name==='table')position=at.position
  }else if(pair.kind==='retained'&&root.childTo-root.childFrom===1&&target.childTo-target.childFrom===1&&root.pmFrom===old.position&&session.doc.nodeAt(target.pmFrom)?.type.name==='table')position=target.pmFrom
  const table=tables.find(t=>t.position===position&&t.columns===old.columns)
  if(table&&base.session.doc.nodeAt(old.position)?.childCount===session.doc.nodeAt(table.position)?.childCount){next.set(id,image(table.position,table.columns,old.widths));claimed.add(table.position)}
 }
 for(const t of tables)if(!claimed.has(t.position))next.set(ids(),t)
 return next
}
