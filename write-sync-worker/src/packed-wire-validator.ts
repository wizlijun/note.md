/** Packed, bounded opaque-wire index. It preserves the legacy validator's
 * immutable fields, actor collision and delayed quarantine checks without one
 * SQL row per Yjs struct. Logical document semantics still belong to write-core.
 * Caller MUST wrap validate/reset and journal changes in the same transaction. */
import { UpdateDecoderV1 } from 'yjs'
import * as decoding from 'lib0/decoding'
import { ApiError, LIMITS, id as uuid, validateTimingEvent } from './protocol'

type ID={client:number;clock:number}
type Row={client:number;clock:number;end:number;op:string;root:string|null;sub:string|null;lc:number|null;lk:number|null;rc:number|null;rk:number|null;kind:number;value:string|null;external?:boolean}
type Tuple=[number,number,string,string|null,string|null,number|null,number|null,number|null,number|null,number,string|null,number?]
type Op={op:string;q:boolean;pending:boolean}
type Block={client:number;bucket:number;rows:Row[];dirty:boolean;charge:number}
type FieldBuffer={bytes:Uint8Array;used:number}
const CLOCKS=256, FIELD_BYTES=28, FIELD_RECORDS=2048, FIELD_SEGMENT=FIELD_BYTES*FIELD_RECORDS
// A uniformly random Sumi UUID population of 100k averages 24 entries per bucket.
// Bound adversarially selected prefixes instead of admitting quadratic scans.
export const PACKED_FIELD_REFS_PER_BUCKET=4096
const TABLES=['packed_items','packed_values','packed_fields','packed_ops','packed_deletes','packed_clients','packed_refs']
const bad=(code:string):never=>{throw new ApiError(['page_identity_changed','timing_event_mutated','immutable_field_deleted','wire_actor_collision'].includes(code)?409:400,code)}
const integer=(n:number):number=>Number.isInteger(n)&&n>=0&&n<=0xffffffff?n:bad('invalid_wire_integer')
const identity=(id:ID|null):ID|null=>id&&({client:integer(id.client),clock:integer(id.clock)})
const sameID=(a:ID|null,b:ID|null)=>a?.client===b?.client&&a?.clock===b?.clock
const buffer=(value:ArrayBuffer|Uint8Array):Uint8Array=>value instanceof Uint8Array?value:new Uint8Array(value)
function key(root:string,sub:string):{bucket:number;bytes:Uint8Array} {
  const bytes=new Uint8Array(20)
  if(root==='page'){const code=['schema','page_id','epoch','root_line_id'].indexOf(sub);if(code<0)bad('unknown_page_field');bytes[0]=code+1;return {bucket:4096,bytes}}
  uuid(sub)
  const hex=sub.replaceAll('-','');let mask=0
  for(let i=0;i<16;i++)bytes[i]=parseInt(hex.slice(i*2,i*2+2),16)
  for(let i=0;i<32;i++)if(hex[i]>='A'&&hex[i]<='F')mask=(mask|(1<<i))>>>0
  new DataView(bytes.buffer).setUint32(16,mask,true)
  return {bucket:bytes[0]*16+(bytes[1]>>>4),bytes}
}
function matching(bytes:Uint8Array,at:number,key:Uint8Array):boolean {for(let i=0;i<20;i++)if(bytes[at+i]!==key[i])return false;return true}
function ref(bytes:Uint8Array,at:number):ID {const v=new DataView(bytes.buffer,bytes.byteOffset+at,FIELD_BYTES);return {client:v.getUint32(20,true),clock:v.getUint32(24,true)}}
function tuple(row:Row):Tuple{return [row.clock,row.end,row.op,row.root,row.sub,row.lc,row.lk,row.rc,row.rk,row.kind,row.value,row.external?1:0]}
function row(client:number,t:Tuple):Row{return {client,clock:t[0],end:t[1],op:t[2],root:t[3],sub:t[4],lc:t[5],lk:t[6],rc:t[7],rk:t[8],kind:t[9],value:t[10],external:!!t[11]}}

export class PackedWireValidator {
 constructor(private sql:SqlStorage){
  sql.exec(`CREATE TABLE IF NOT EXISTS packed_items(page TEXT NOT NULL,client INTEGER NOT NULL,bucket INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(page,client,bucket))`)
  sql.exec(`CREATE TABLE IF NOT EXISTS packed_values(page TEXT NOT NULL,client INTEGER NOT NULL,clock INTEGER NOT NULL,value TEXT NOT NULL,PRIMARY KEY(page,client,clock))`)
  sql.exec(`CREATE TABLE IF NOT EXISTS packed_fields(page TEXT NOT NULL,bucket INTEGER NOT NULL,segment INTEGER NOT NULL,data BLOB NOT NULL,PRIMARY KEY(page,bucket,segment))`)
  sql.exec(`CREATE TABLE IF NOT EXISTS packed_ops(page TEXT NOT NULL,op TEXT NOT NULL,quarantined INTEGER NOT NULL,pending INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(page,op))`)
  sql.exec(`CREATE INDEX IF NOT EXISTS packed_pending ON packed_ops(page,quarantined,pending)`)
  sql.exec(`CREATE TABLE IF NOT EXISTS packed_deletes(page TEXT NOT NULL,op TEXT NOT NULL,client INTEGER NOT NULL,segment INTEGER NOT NULL,data BLOB NOT NULL,PRIMARY KEY(page,op,client,segment))`)
  sql.exec(`CREATE INDEX IF NOT EXISTS packed_delete_client ON packed_deletes(page,client)`)
  sql.exec(`CREATE TABLE IF NOT EXISTS packed_refs(page TEXT NOT NULL,op TEXT NOT NULL,segment INTEGER NOT NULL,data BLOB NOT NULL,PRIMARY KEY(page,op,segment))`)
  sql.exec(`CREATE TABLE IF NOT EXISTS packed_clients(page TEXT NOT NULL,client INTEGER NOT NULL,next_clock INTEGER NOT NULL,PRIMARY KEY(page,client))`)
 }
 reset():void {for(const table of TABLES)this.sql.exec(`DELETE FROM ${table}`)}
 validate(pageId:string,epoch:number,opKey:string,bytes:Uint8Array):{quarantined:string[];pending:boolean;hasContent:boolean}{
  uuid(pageId);if(bytes.length>LIMITS.updateBytes)bad('update_limit')
  // All caches are transaction-local. A rejected packet cannot leave in-memory
  // data that disagrees with the caller's SQLite rollback.
  return new Pass(this.sql,pageId,epoch,opKey).run(bytes)
 }
}
class Pass {
 private blocks=new Map<string,Block>()
 private charge=0
 private fields=new Map<number,FieldBuffer>()
 private fieldBytes=0
 private fieldCounts=new Map<number,number>()
 private operations=new Map<string,Op>()
 private changedClients=new Set<number>()
 private current:Op
 private refBuffer=new Uint8Array(8192)
 private refUsed=0
 private refSegment=0
 private lastRef=""
 private quarantined=new Set<string>()
 constructor(private sql:SqlStorage,private page:string,private epoch:number,private op:string){this.current={op,q:false,pending:true}}
 private opGet(op:string):Op|undefined {
  if(op===this.op)return this.current
  let found=this.operations.get(op);if(found)return found
  const value=this.sql.exec<{quarantined:number;pending:number;data:string}>(`SELECT quarantined,pending,data FROM packed_ops WHERE page=? AND op=?`,this.page,op).toArray()[0]
  if(!value)return undefined
  found={op,q:!!value.quarantined,pending:!!value.pending}
  if(this.operations.size>=64)this.operations.delete(this.operations.keys().next().value!)
  this.operations.set(op,found);return found
 }
 private saveOp(op:Op):void {this.sql.exec(`UPDATE packed_ops SET quarantined=?,pending=?,data=? WHERE page=? AND op=?`,op.q?1:0,op.pending?1:0,'{}',this.page,op.op)}
 private block(client:number,bucket:number):Block {
  const id=`${client}:${bucket}`,cached=this.blocks.get(id)
  if(cached){this.blocks.delete(id);this.blocks.set(id,cached);return cached}
  const data=this.sql.exec<{data:string}>(`SELECT data FROM packed_items WHERE page=? AND client=? AND bucket=?`,this.page,client,bucket).toArray()[0]?.data
  const b={client,bucket,rows:data?(JSON.parse(data) as Tuple[]).map(t=>row(client,t)):[],dirty:false,charge:data?.length??0}
  this.blocks.set(id,b);this.charge+=b.charge;this.trim();return b
 }
 private trim():void {while(this.blocks.size>32||this.charge>2*1024*1024&&this.blocks.size>1){const id=this.blocks.keys().next().value!,b=this.blocks.get(id)!;this.flushBlock(b);this.charge-=b.charge;this.blocks.delete(id)}}
 private dirty(b:Block,added=256):void {b.dirty=true;b.charge+=added;this.charge+=added;this.trim()}
 private flushBlock(b:Block):void {
  if(!b.dirty)return
  if(b.rows.length)this.sql.exec(`INSERT INTO packed_items VALUES(?,?,?,?) ON CONFLICT(page,client,bucket) DO UPDATE SET data=excluded.data`,this.page,b.client,b.bucket,JSON.stringify(b.rows.map(tuple)))
  else this.sql.exec(`DELETE FROM packed_items WHERE page=? AND client=? AND bucket=?`,this.page,b.client,b.bucket)
  b.dirty=false
 }
 private flushBlocks():void {for(const b of this.blocks.values())this.flushBlock(b)}
 private find(id:ID):Row|undefined {const rows=this.block(id.client,Math.floor(id.clock/CLOCKS)).rows;let l=0,r=rows.length;while(l<r){const m=(l+r)>>>1;if(rows[m].clock<=id.clock)l=m+1;else r=m}const found=rows[l-1];return found&&found.end>id.clock?found:undefined}
 private value(r:Row):string|null {return r.external?this.sql.exec<{value:string}>(`SELECT value FROM packed_values WHERE page=? AND client=? AND clock=?`,this.page,r.client,r.clock).toArray()[0]?.value??bad('missing_packed_value'):r.value}
 private *intersections(client:number,start:number,end:number):Generator<Row>{
  this.flushBlocks()
  for(const {bucket} of this.sql.exec<{bucket:number}>(`SELECT bucket FROM packed_items WHERE page=? AND client=? AND bucket>=? AND bucket<=? ORDER BY bucket`,this.page,client,Math.floor(start/CLOCKS),Math.floor((end-1)/CLOCKS)))
   for(const r of this.block(client,bucket).rows)if(r.clock<end&&r.end>start)yield r
 }
 private resolve(r:Row):boolean {
  if(r.root||r.kind===0)return false
  const left=r.lc===null?undefined:this.find({client:r.lc,clock:r.lk!}),right=r.rc===null?undefined:this.find({client:r.rc,clock:r.rk!})
  if(left?.root&&right?.root&&(left.root!==right.root||left.sub!==right.sub))bad('inconsistent_wire_parent')
  const parent=left?.root?left:right?.root?right:undefined
  if(parent){r.root=parent.root;r.sub=parent.sub;return true}return false
 }
 private *fieldRefs(root:string,sub:string):Generator<ID>{
  const k=key(root,sub)
  for(const {data} of this.sql.exec<{data:ArrayBuffer}>(`SELECT data FROM packed_fields WHERE page=? AND bucket=? ORDER BY segment`,this.page,k.bucket)){
   const bytes=buffer(data);for(let at=0;at<bytes.length;at+=FIELD_BYTES)if(matching(bytes,at,k.bytes))yield ref(bytes,at)
  }
  const pending=this.fields.get(k.bucket);if(pending)for(let at=0;at<pending.used;at+=FIELD_BYTES)if(matching(pending.bytes,at,k.bytes))yield ref(pending.bytes,at)
 }
 private fieldCount(bucket:number):number {
  const cached=this.fieldCounts.get(bucket);if(cached!==undefined)return cached
  const count=this.sql.exec<{n:number}>(`SELECT COALESCE(SUM(length(data)),0) AS n FROM packed_fields WHERE page=? AND bucket=?`,this.page,bucket).toArray()[0].n/FIELD_BYTES
  this.fieldCounts.set(bucket,count);return count
 }
 private addField(r:Row):void {
  const k=key(r.root!,r.sub!),needed=FIELD_BYTES
  const count=this.fieldCount(k.bucket);if(count>=PACKED_FIELD_REFS_PER_BUCKET)bad('field_bucket_capacity')
  this.fieldCounts.set(k.bucket,count+1)
  let field=this.fields.get(k.bucket)
  if(!field){field={bytes:new Uint8Array(FIELD_BYTES*4),used:0};this.fields.set(k.bucket,field)}
  if(field.used+needed>field.bytes.length){const next=new Uint8Array(field.bytes.length*2);next.set(field.bytes);field.bytes=next}
  field.bytes.set(k.bytes,field.used);const v=new DataView(field.bytes.buffer);v.setUint32(field.used+20,r.client,true);v.setUint32(field.used+24,r.clock,true);field.used+=needed
  this.fieldBytes+=needed;if(this.fieldBytes>LIMITS.structsPerUpdate*FIELD_BYTES)bad('wire_struct_limit')
 }
 private flushFields():void {
  for(const [bucket,field] of this.fields){
   const tail=this.sql.exec<{segment:number;data:ArrayBuffer}>(`SELECT segment,data FROM packed_fields WHERE page=? AND bucket=? ORDER BY segment DESC LIMIT 1`,this.page,bucket).toArray()[0]
   let segment=tail?.segment??0,old=tail?buffer(tail.data):new Uint8Array(),offset=0
   if(old.length===FIELD_SEGMENT){segment++;old=new Uint8Array()}
   while(offset<field.used){const count=Math.min(FIELD_SEGMENT-old.length,field.used-offset),next=new Uint8Array(old.length+count);next.set(old);next.set(field.bytes.subarray(offset,offset+count),old.length)
    this.sql.exec(`INSERT INTO packed_fields VALUES(?,?,?,?) ON CONFLICT(page,bucket,segment) DO UPDATE SET data=excluded.data`,this.page,bucket,segment,next)
    offset+=count;segment++;old=new Uint8Array()
   }
  }
  this.fields.clear();this.fieldBytes=0
 }
 private check(r:Row):void {
  if(!r.root||r.kind===0||r.kind===1)return
  if(r.root==='body'){if(r.sub!==null||![4,6].includes(r.kind))bad('invalid_body_wire_type');return}
  if(!['page','timing'].includes(r.root)||r.sub===null||![2,8].includes(r.kind))bad('invalid_shared_root')
  const encoded=this.value(r)!,value:unknown=JSON.parse(encoded)
  if(r.root==='page'){
   if((r.sub==='schema'&&value!==1)||(r.sub==='page_id'&&value!==this.page)||(r.sub==='epoch'&&value!==this.epoch))bad('page_identity_changed')
   if(r.sub==='root_line_id'){if(typeof value!=='string')bad('invalid_root_line');uuid(value)}else if(!['schema','page_id','epoch'].includes(r.sub!))bad('unknown_page_field')
  }else{uuid(r.sub);validateTimingEvent(value)}
  if(this.fieldCount(key(r.root,r.sub!).bucket)>=PACKED_FIELD_REFS_PER_BUCKET)bad('field_bucket_capacity')
  let present=false
  for(const id of this.fieldRefs(r.root,r.sub!)){
   if(id.client===r.client&&id.clock===r.clock){present=true;continue}
   const prior=this.find(id);if(prior&&!this.opGet(prior.op)?.q){if(this.value(prior)!==encoded)bad(r.root==='timing'?'timing_event_mutated':'page_identity_changed');break}
  }
  if(!present)this.addField(r)
 }
 private insert(r:Row):void {
  this.check(r)
  if(r.value!==null&&r.value.length>4096){this.sql.exec(`INSERT INTO packed_values VALUES(?,?,?,?)`,this.page,r.client,r.clock,r.value);r.value=null;r.external=true}
  const bucket=Math.floor(r.clock/CLOCKS),b=this.block(r.client,bucket)
  let at=0;while(at<b.rows.length&&b.rows[at].clock<r.clock)at++;b.rows.splice(at,0,r);this.dirty(b,(r.value?.length??0)+256)
  const key=`${r.client}:${bucket}`
  if(key!==this.lastRef){const view=new DataView(this.refBuffer.buffer);view.setUint32(this.refUsed,r.client,true);view.setUint32(this.refUsed+4,bucket,true);this.refUsed+=8;this.lastRef=key;if(this.refUsed===this.refBuffer.length)this.flushRefs()}
 }
 private slice(r:Row,start:number,end:number):Row {
  const part={...r,clock:start,end};if(start>r.clock){part.lc=r.client;part.lk=start-1}
  if(r.kind===4)part.value=JSON.stringify((JSON.parse(this.value(r)!) as string).slice(start-r.clock,end-r.clock));return part
 }
 private put(r:Row):void {
  this.resolve(r)
  for(let start=r.clock;start<r.end;){const end=Math.min(r.end,(Math.floor(start/CLOCKS)+1)*CLOCKS),part=this.slice(r,start,end);this.putPart(part);start=end}
 }
 private putPart(r:Row):void {
  const b=this.block(r.client,Math.floor(r.clock/CLOCKS));const overlaps=b.rows.filter(old=>old.clock<r.end&&old.end>r.clock);let covered=r.clock
  for(const old of overlaps){const a=Math.max(r.clock,old.clock),end=Math.min(r.end,old.end)
   if(![0,1].includes(r.kind)&&![0,1].includes(old.kind)){
    const left=(x:Row,at:number):ID|null=>at>x.clock?{client:x.client,clock:at-1}:x.lc===null?null:{client:x.lc,clock:x.lk!}
    if(r.kind!==old.kind||!sameID(left(r,a),left(old,a))||r.rc!==old.rc||r.rk!==old.rk||(r.root&&old.root&&(r.root!==old.root||r.sub!==old.sub)))bad('wire_actor_collision')
    if(r.kind===4){if((JSON.parse(this.value(r)!) as string).slice(a-r.clock,end-r.clock)!==(JSON.parse(this.value(old)!) as string).slice(a-old.clock,end-old.clock))bad('wire_actor_collision')}
    else if(this.value(r)!==this.value(old))bad('wire_actor_collision')
   }
   if(old.clock>covered)this.insert(this.slice(r,covered,old.clock));covered=Math.max(covered,old.end)
  }
  if(covered<r.end)this.insert(this.slice(r,covered,r.end))
 }
 private *pendingOps():Generator<Op>{for(const r of this.sql.exec<{op:string}>(`SELECT op FROM packed_ops WHERE page=? AND quarantined=0 AND pending=1 ORDER BY op`,this.page)){const op=this.opGet(r.op);if(op&&!op.q)yield op}}
 private flushRefs():void {if(this.refUsed)this.sql.exec(`INSERT INTO packed_refs VALUES(?,?,?,?)`,this.page,this.op,this.refSegment++,this.refBuffer.slice(0,this.refUsed));this.refUsed=0}
 private *refs(op:Op):Generator<[number,number]>{for(const r of this.sql.exec<{data:ArrayBuffer}>(`SELECT data FROM packed_refs WHERE page=? AND op=? ORDER BY segment`,this.page,op.op)){const bytes=buffer(r.data),v=new DataView(bytes.buffer,bytes.byteOffset,bytes.length);for(let at=0;at<bytes.length;at+=8)yield [v.getUint32(at,true),v.getUint32(at+4,true)]}}
 private *ownRows(op:Op):Generator<Row>{for(const [client,bucket] of this.refs(op))for(const r of this.block(client,bucket).rows)if(r.op===op.op)yield r}
 private *deletes(op?:string,client?:number):Generator<{op:string;client:number;start:number;end:number}>{
  const query=op!==undefined?`SELECT op,client,data FROM packed_deletes WHERE page=? AND op=?`:`SELECT op,client,data FROM packed_deletes WHERE page=? AND client=?`
  for(const r of this.sql.exec<{op:string;client:number;data:ArrayBuffer}>(query,this.page,op??client!)){
   if(this.opGet(r.op)?.q)continue
   const bytes=buffer(r.data),v=new DataView(bytes.buffer,bytes.byteOffset,bytes.length)
   for(let at=0;at<bytes.length;at+=8)yield {op:r.op,client:r.client,start:v.getUint32(at,true),end:v.getUint32(at+4,true)}
  }
 }
 private deleted(r:Row):boolean {for(const d of this.deletes(undefined,r.client))if(d.start<=r.clock&&d.end>r.clock)return true;return false}
 private deletedBy(op:string,r:Row):boolean {for(const d of this.deletes(op))if(d.client===r.client&&d.start<=r.clock&&d.end>r.clock)return true;return false}
 private replacement(candidate:Row,target:Row,op:string):boolean {
  if(this.deletedBy(op,candidate))return false
  // A legitimate same-value map replacement must not be blamed for a later
  // pending delete of its replacement. Follow the Yjs map origin chain and
  // validate the later deleting operation separately, independent of op order.
  let current:Row|undefined=candidate
  for(let n=0;n<PACKED_FIELD_REFS_PER_BUCKET&&current!==undefined&&current.lc!==null;n++){
   const id={client:current.lc!,clock:current.lk!}
   if(id.client===target.client&&id.clock>=target.clock&&id.clock<target.end)return true
   current=this.find(id)
   if(!current||current.root!==target.root||current.sub!==target.sub)return false
  }
  return false
 }
 private covered(client:number,start:number,end:number):boolean {let at=start;for(const r of this.intersections(client,start,end)){if(r.clock>at||!r.root&&r.kind!==0)return false;at=Math.max(at,r.end)}return at>=end}
 private quarantine(opId:string,reason:string):void {
  if(opId===this.op)bad(reason);if(this.quarantined.has(opId))return
  const op=this.opGet(opId);if(!op)return;op.q=true;op.pending=false;this.saveOp(op);this.quarantined.add(opId)
  const removed=new Map<number,Set<string>>(),cuts=new Map<number,number>()
  for(const [client,bucket] of this.refs(op)){const b=this.block(client,bucket);for(const r of b.rows.filter(r=>r.op===opId)){
    cuts.set(client,Math.min(cuts.get(client)??0xffffffff,r.clock));this.changedClients.add(client)
    if(r.external)this.sql.exec(`DELETE FROM packed_values WHERE page=? AND client=? AND clock=?`,this.page,client,r.clock)
    if(r.root&&r.sub!==null&&['page','timing'].includes(r.root)&&[2,8].includes(r.kind)){const k=key(r.root,r.sub).bucket;let ids=removed.get(k);if(!ids){ids=new Set();removed.set(k,ids)}ids.add(`${client}:${r.clock}`)}
   }b.rows=b.rows.filter(r=>r.op!==opId);this.dirty(b)
  }
  this.flushBlocks();this.flushFields()
  for(const [bucket,ids] of removed)for(const r of this.sql.exec<{segment:number;data:ArrayBuffer}>(`SELECT segment,data FROM packed_fields WHERE page=? AND bucket=?`,this.page,bucket)){
   const bytes=buffer(r.data),kept=new Uint8Array(bytes.length);let used=0
   for(let at=0;at<bytes.length;at+=FIELD_BYTES){const id=ref(bytes,at);if(!ids.has(`${id.client}:${id.clock}`)){kept.set(bytes.subarray(at,at+FIELD_BYTES),used);used+=FIELD_BYTES}}
   if(used!==bytes.length){if(used)this.sql.exec(`UPDATE packed_fields SET data=? WHERE page=? AND bucket=? AND segment=?`,kept.slice(0,used),this.page,bucket,r.segment);else this.sql.exec(`DELETE FROM packed_fields WHERE page=? AND bucket=? AND segment=?`,this.page,bucket,r.segment)}
  }
  for(const bucket of removed.keys())this.fieldCounts.delete(bucket)
  for(const [client,cut] of cuts)this.sql.exec(`UPDATE packed_clients SET next_clock=MIN(next_clock,?) WHERE page=? AND client=?`,cut,this.page,client)
  // Rare quarantine: invalidate later operations across a removed clock gap.
  // The retained raw journal remains the recovery authority.
  for(const r of this.sql.exec<{op:string;data:string}>(`SELECT op,data FROM packed_ops WHERE page=? AND quarantined=0`,this.page)){
   const later=this.opGet(r.op)!
   for(const item of this.ownRows(later))if(cuts.has(item.client)&&item.end>cuts.get(item.client)!){later.pending=true;this.saveOp(later);break}
  }
 }

 run(bytes:Uint8Array):{quarantined:string[];pending:boolean;hasContent:boolean}{
  const prior=this.sql.exec<{quarantined:number;pending:number}>(`SELECT quarantined,pending FROM packed_ops WHERE page=? AND op=?`,this.page,this.op).toArray()[0]
  if(prior)return {quarantined:prior.quarantined?[this.op]:[],pending:!!prior.pending,hasContent:false}
  this.sql.exec(`INSERT INTO packed_ops VALUES(?,?,0,1,?)`,this.page,this.op,JSON.stringify({refs:[],ends:[]}))
  let count=0,hasContent=false
    try {
      const reader=decoding.createDecoder(bytes),d=new UpdateDecoderV1(reader)
      const clients=integer(decoding.readVarUint(reader))
      if (clients>100_000) bad('wire_client_limit')
      for (let c=0;c<clients;c++) {
        const structs=integer(decoding.readVarUint(reader)),client=integer(d.readClient())
        let clock=integer(decoding.readVarUint(reader))
        this.changedClients.add(client)
        if ((count+=structs)>LIMITS.structsPerUpdate) bad('wire_struct_limit')
        for (let n=0;n<structs;n++) {
          const info=d.readInfo(),kind=info&31
          if (info===10) {clock=integer(clock+integer(decoding.readVarUint(reader)));continue}
          let len=1,root:string|null=null,sub:string|null=null,left:ID|null=null,right:ID|null=null,value:string|null=null
          if (kind===0) len=integer(d.readLen())
          else {
            left=identity(info&128?d.readLeftID():null);right=identity(info&64?d.readRightID():null)
            if (!left && !right) {
              if (!d.readParentInfo()) bad('nested_shared_type_not_supported')
              root=d.readString()
              if (!['body','page','timing'].includes(root)) bad('unknown_shared_root')
              if (info&32) sub=d.readString()
            }
            if (kind===1) len=integer(d.readLen())
            else if (kind===4) {const text=d.readString();len=text.length;if(len>LIMITS.bodyUnits)bad('body_limit');value=JSON.stringify(text);hasContent ||= len>0}
            else if (kind===6) {const key=d.readKey(),encoded=d.readString();if(key!=='next_line_id'||encoded.length>128)bad('unknown_text_attribute');const attr=JSON.parse(encoded);if(attr!==null)uuid(attr);value=JSON.stringify([key,attr])}
            else if (kind===8 || kind===2) {
              if (d.readLen()!==1) bad('invalid_map_value')
              if (kind===8) {
                // Reject object/array/binary/bigint before lib0 allocates them.
                const tag=reader.arr[reader.pos]
                if (![127,126,125,124,123,121,120,119].includes(tag)) bad('non_scalar_map_value')
                const scalar=d.readAny();value=JSON.stringify(scalar)
                if(value===undefined)bad('undefined_map_value')
              } else {const encoded=d.readString();if(encoded==='undefined')bad('undefined_map_value');value=JSON.stringify(JSON.parse(encoded))}
            } else bad('unsupported_wire_content')
          }
          if (len===0)bad('empty_wire_struct')
          const end=integer(clock+len)
          this.put({client,clock,end,op:this.op,root,sub,lc:left?.client??null,lk:left?.clock??null,rc:right?.client??null,rk:right?.clock??null,kind,value})
          clock=end
        }
      }
      const deletes=integer(decoding.readVarUint(reader))
      if(deletes>100_000)bad('wire_delete_limit')
      for(let i=0;i<deletes;i++) {
        const client=integer(decoding.readVarUint(reader)),ranges=integer(decoding.readVarUint(reader));d.resetDsCurVal()
        if((count+=ranges)>1_000_000)bad('wire_delete_limit')
        let segment=0,used=0;const packed=new Uint8Array(8192),view=new DataView(packed.buffer)
        const flush=()=>{if(used)this.sql.exec(`INSERT INTO packed_deletes VALUES(?,?,?,?,?)`,this.page,this.op,client,segment++,packed.slice(0,used));used=0}
        for(let j=0;j<ranges;j++){const start=integer(d.readDsClock()),len=integer(d.readDsLen());if(!len)bad('empty_delete_range');view.setUint32(used,start,true);view.setUint32(used+4,integer(start+len),true);used+=8;if(used===packed.length)flush()}
        flush()
      }
      if(reader.pos!==bytes.length)bad('wire_trailing_bytes')
    } catch(error) {if(error instanceof ApiError)throw error;bad('invalid_yjs_update')}

  this.flushRefs();this.saveOp(this.current);this.flushBlocks()
  let advanced=true,passes=0
  while(advanced&&passes++<64){
   advanced=false
   for(const op of this.pendingOps()){
    if(this.quarantined.has(op.op))continue
    for(const r of this.ownRows(op)){
     if(r.root||r.kind===0)continue
     try {
      if(this.resolve(r)){
       this.check(r)
       const b=this.block(r.client,Math.floor(r.clock/CLOCKS)),at=b.rows.findIndex(item=>item.clock===r.clock)
       if(at<0)bad('missing_packed_item');b.rows[at]=r;this.dirty(b);advanced=true
      }
     }catch(error){if(error instanceof ApiError){this.quarantine(op.op,error.code);advanced=true;break}else throw error}
    }
   }
  }
  this.flushBlocks()
  for(const op of this.pendingOps()){
   if(this.quarantined.has(op.op))continue
   const checkedFields=new Set<string>()
   outer:for(const d of this.deletes(op.op))for(const item of this.intersections(d.client,d.start,d.end)){
    if(!item.root||!['page','timing'].includes(item.root)||item.sub===null||![2,8].includes(item.kind))continue
    const field=`${item.root}:${item.sub}`;if(checkedFields.has(field))continue;checkedFields.add(field)
    let survivor=false
    for(const id of this.fieldRefs(item.root,item.sub)){const candidate=this.find(id);if(candidate&&!this.opGet(candidate.op)?.q&&(!this.deleted(candidate)||this.replacement(candidate,item,op.op))){survivor=true;break}}
    if(!survivor){this.quarantine(op.op,'immutable_field_deleted');break outer}
   }
  }
  this.flushBlocks()
  for(const client of this.changedClients){
   let next=this.sql.exec<{next_clock:number}>(`SELECT next_clock FROM packed_clients WHERE page=? AND client=?`,this.page,client).toArray()[0]?.next_clock??0
   for(const r of this.intersections(client,next,0xffffffff)){if(r.clock>next)break;next=Math.max(next,r.end)}
   this.sql.exec(`INSERT INTO packed_clients VALUES(?,?,?) ON CONFLICT(page,client) DO UPDATE SET next_clock=excluded.next_clock`,this.page,client,next)
  }
  const pageReady=['schema','page_id','epoch','root_line_id'].every(sub=>{
   for(const id of this.fieldRefs('page',sub)){const r=this.find(id);if(r&&!this.opGet(r.op)?.q)return true}return false
  })
  for(const op of this.pendingOps()){
   let pending=!pageReady
   if(!pending)for(const r of this.ownRows(op)){if(!r.root&&r.kind!==0){pending=true;break}}
   if(!pending){let lastClient=-1,clock=0;for(const item of this.ownRows(op)){if(item.client!==lastClient){lastClient=item.client;clock=this.sql.exec<{next_clock:number}>(`SELECT next_clock FROM packed_clients WHERE page=? AND client=?`,this.page,item.client).toArray()[0]?.next_clock??0}if(item.end>clock){pending=true;break}}}
   if(!pending)for(const d of this.deletes(op.op))if(!this.covered(d.client,d.start,d.end)){pending=true;break}
   op.pending=pending;this.saveOp(op)
  }
  this.flushBlocks();this.flushFields()
  return {quarantined:[...this.quarantined],pending:this.current.pending,hasContent}
 }
}
