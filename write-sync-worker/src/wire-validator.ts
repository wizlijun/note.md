/** Bounded V1 wire validation for the opaque journal. This is NOT a Y.Doc
 * materializer: logical text, line identities and timing reduction are verified
 * by write-core on a throwaway candidate before clients publish a view.
 * Parser field order follows Yjs 13.6.33 lazyStructReaderGenerator. */
import { UpdateDecoderV1 } from 'yjs'
import * as decoding from 'lib0/decoding'
import { ApiError, LIMITS, id as uuid, validateTimingEvent } from './protocol'

type ID = { client: number; clock: number }
type Row = {
  page: string; client: number; clock: number; end_clock: number; op: string;
  root: string | null; sub: string | null; lc: number | null; lk: number | null;
  rc: number | null; rk: number | null; kind: number; value: string | null;
}
type Operation = { op: string; quarantined: number; pending: number }
const bad = (code: string): never => { throw new ApiError(['page_identity_changed','timing_event_mutated','immutable_field_deleted','wire_actor_collision'].includes(code)?409:400, code) }
const integer = (n: number): number => Number.isInteger(n) && n >= 0 && n <= 0xffffffff ? n : bad('invalid_wire_integer')
const identity = (id: ID | null): ID | null => id && ({ client: integer(id.client), clock: integer(id.clock) })
const sameID = (a: ID | null, b: ID | null): boolean => a?.client === b?.client && a?.clock === b?.clock

export class WireValidator {
  constructor(private sql: SqlStorage) {
    sql.exec(`CREATE TABLE IF NOT EXISTS wire_ops(page TEXT NOT NULL,op TEXT NOT NULL,quarantined INTEGER NOT NULL DEFAULT 0,pending INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(page,op))`)
    sql.exec(`CREATE TABLE IF NOT EXISTS wire_items(page TEXT NOT NULL,client INTEGER NOT NULL,clock INTEGER NOT NULL,end_clock INTEGER NOT NULL,op TEXT NOT NULL,root TEXT,sub TEXT,lc INTEGER,lk INTEGER,rc INTEGER,rk INTEGER,kind INTEGER NOT NULL,value TEXT,PRIMARY KEY(page,client,clock))`)
    sql.exec(`CREATE INDEX IF NOT EXISTS wire_items_op ON wire_items(page,op)`)
    sql.exec(`CREATE INDEX IF NOT EXISTS wire_items_pending ON wire_items(page,root,client,clock)`)
    sql.exec(`CREATE INDEX IF NOT EXISTS wire_items_field ON wire_items(page,root,sub)`)
    sql.exec(`CREATE TABLE IF NOT EXISTS wire_deletes(page TEXT NOT NULL,op TEXT NOT NULL,client INTEGER NOT NULL,clock INTEGER NOT NULL,end_clock INTEGER NOT NULL,PRIMARY KEY(page,op,client,clock))`)
    sql.exec(`CREATE INDEX IF NOT EXISTS wire_delete_target ON wire_deletes(page,client,clock)`)
    sql.exec(`CREATE TABLE IF NOT EXISTS wire_clocks(page TEXT NOT NULL,client INTEGER NOT NULL,next_clock INTEGER NOT NULL,PRIMARY KEY(page,client))`)
    sql.exec(`CREATE TABLE IF NOT EXISTS wire_fields(page TEXT NOT NULL,root TEXT NOT NULL,sub TEXT NOT NULL,value TEXT NOT NULL,op TEXT NOT NULL,PRIMARY KEY(page,root,sub))`)
  }
  /** Only for an unprovisioned recovery staging object; caller owns transaction. */
  reset():void {
    for(const table of ['wire_deletes','wire_items','wire_fields','wire_clocks','wire_ops'])this.sql.exec(`DELETE FROM ${table}`)
  }
  private find(page: string, id: ID): Row | undefined {
    const row=this.sql.exec<Row>(`SELECT * FROM wire_items WHERE page=? AND client=? AND clock<=? ORDER BY clock DESC LIMIT 1`,page,id.client,id.clock).toArray()[0]
    return row && row.end_clock>id.clock ? row : undefined
  }
  private *intersections(page:string,client:number,start:number,end:number):Generator<Row> {
    const previous=this.sql.exec<Row>(`SELECT * FROM wire_items WHERE page=? AND client=? AND clock<? ORDER BY clock DESC LIMIT 1`,page,client,start).toArray()[0]
    if(previous && previous.end_clock>start)yield previous
    yield* this.sql.exec<Row>(`SELECT * FROM wire_items WHERE page=? AND client=? AND clock>=? AND clock<? ORDER BY clock`,page,client,start,end)
  }
  private resolve(row: Row): Row {
    if (row.root || row.kind === 0) return row
    const left = row.lc === null ? undefined : this.find(row.page,{client:row.lc,clock:row.lk!})
    const right = row.rc === null ? undefined : this.find(row.page,{client:row.rc,clock:row.rk!})
    if (left?.root && right?.root && (left.root !== right.root || left.sub !== right.sub)) bad('inconsistent_wire_parent')
    const parent = left?.root ? left : right?.root ? right : undefined
    if (parent) { row.root=parent.root; row.sub=parent.sub }
    return row
  }
  private check(row: Row, epoch: number): void {
    if (!row.root || row.kind === 0 || row.kind === 1) return
    if (row.root === 'body') {
      if (row.sub !== null || ![4,6].includes(row.kind)) bad('invalid_body_wire_type')
      return
    }
    if (!['page','timing'].includes(row.root) || row.sub === null || ![2,8].includes(row.kind)) bad('invalid_shared_root')
    const value: unknown = JSON.parse(row.value!)
    if (row.root === 'page') {
      if ((row.sub === 'schema' && value !== 1) || (row.sub === 'page_id' && value !== row.page) || (row.sub === 'epoch' && value !== epoch)) bad('page_identity_changed')
      if (row.sub === 'root_line_id') { if (typeof value !== 'string') bad('invalid_root_line'); uuid(value) }
      else if (!['schema','page_id','epoch'].includes(row.sub!)) bad('unknown_page_field')
    } else { uuid(row.sub); validateTimingEvent(value) }
    const prior=this.sql.exec<{value:string}>(`SELECT value FROM wire_fields WHERE page=? AND root=? AND sub=?`,row.page,row.root,row.sub).toArray()[0]
    if (prior && prior.value !== row.value) bad(row.root === 'timing' ? 'timing_event_mutated' : 'page_identity_changed')
    this.sql.exec(`INSERT OR IGNORE INTO wire_fields VALUES(?,?,?,?,?)`,row.page,row.root,row.sub,row.value,row.op)
  }
  private put(row: Row, epoch: number): void {
    this.resolve(row)
    const overlaps=this.intersections(row.page,row.client,row.clock,row.end_clock)
    let covered=row.clock
    for (const old of overlaps) {
      const a=Math.max(row.clock,old.clock),b=Math.min(row.end_clock,old.end_clock)
      // GC/deleted structs do not replace retained original metadata. The delete
      // set is validated separately; no causal bytes are discarded from journal.
      if (![0,1].includes(row.kind) && ![0,1].includes(old.kind)) {
        const left=(r:Row,at:number):ID|null => at>r.clock ? {client:r.client,clock:at-1} : r.lc===null ? null : {client:r.lc,clock:r.lk!}
        if (row.kind !== old.kind || !sameID(left(row,a),left(old,a)) || row.rc!==old.rc || row.rk!==old.rk || (row.root && old.root && (row.root!==old.root || row.sub!==old.sub))) bad('wire_actor_collision')
        if (row.kind===4) {
          const x=JSON.parse(row.value!) as string,y=JSON.parse(old.value!) as string
          if (x.slice(a-row.clock,b-row.clock)!==y.slice(a-old.clock,b-old.clock)) bad('wire_actor_collision')
        } else if (row.value!==old.value) bad('wire_actor_collision')
      }
      if (old.clock>covered) this.insertSlice(row,covered,old.clock,epoch)
      covered=Math.max(covered,old.end_clock)
    }
    if (covered<row.end_clock) this.insertSlice(row,covered,row.end_clock,epoch)
  }
  private insertSlice(row:Row,start:number,end:number,epoch:number):void {
    const part={...row,clock:start,end_clock:end}
    if (start>row.clock) {part.lc=row.client;part.lk=start-1}
    if (row.kind===4) part.value=JSON.stringify((JSON.parse(row.value!) as string).slice(start-row.clock,end-row.clock))
    this.check(part,epoch)
    this.sql.exec(`INSERT INTO wire_items VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,part.page,part.client,part.clock,part.end_clock,part.op,part.root,part.sub,part.lc,part.lk,part.rc,part.rk,part.kind,part.value)
  }
  private covered(page:string,client:number,start:number,end:number):boolean {
    let cursor=start
    for (const row of this.intersections(page,client,start,end)) {
      if (row.clock>cursor) return false
      cursor=Math.max(cursor,row.end_clock)
    }
    return cursor>=end
  }
  /** Must run inside the same DO SQL transaction as the journal insert. A thrown
   * error rolls back the CURRENT packet; deferred violations quarantine their
   * original op, which caller must exclude from every journal/read/broadcast. */
  validate(pageId:string,epoch:number,opKey:string,bytes:Uint8Array):{quarantined:string[],pending:boolean,hasContent:boolean} {
    uuid(pageId)
    if (bytes.byteLength>LIMITS.updateBytes) bad('update_limit')
    const prior=this.sql.exec<Operation>(`SELECT op,quarantined,pending FROM wire_ops WHERE page=? AND op=?`,pageId,opKey).toArray()[0]
    if (prior) return {quarantined:prior.quarantined?[opKey]:[],pending:!!prior.pending,hasContent:false}
    this.sql.exec(`INSERT INTO wire_ops(page,op) VALUES(?,?)`,pageId,opKey)
    let hasContent=false,count=0
    const changedClients=new Set<number>()
    try {
      const reader=decoding.createDecoder(bytes),d=new UpdateDecoderV1(reader)
      const clients=integer(decoding.readVarUint(reader))
      if (clients>100_000) bad('wire_client_limit')
      for (let c=0;c<clients;c++) {
        const structs=integer(decoding.readVarUint(reader)),client=integer(d.readClient())
        let clock=integer(decoding.readVarUint(reader))
        changedClients.add(client)
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
          this.put({page:pageId,client,clock,end_clock:end,op:opKey,root,sub,lc:left?.client??null,lk:left?.clock??null,rc:right?.client??null,rk:right?.clock??null,kind,value},epoch)
          clock=end
        }
      }
      const deletes=integer(decoding.readVarUint(reader))
      if(deletes>100_000)bad('wire_delete_limit')
      for(let i=0;i<deletes;i++) {
        const client=integer(decoding.readVarUint(reader)),ranges=integer(decoding.readVarUint(reader));d.resetDsCurVal()
        if((count+=ranges)>1_000_000)bad('wire_delete_limit')
        for(let j=0;j<ranges;j++){const start=integer(d.readDsClock()),len=integer(d.readDsLen());if(!len)bad('empty_delete_range');this.sql.exec(`INSERT OR IGNORE INTO wire_deletes VALUES(?,?,?,?,?)`,pageId,opKey,client,start,integer(start+len))}
      }
      if(reader.pos!==bytes.length)bad('wire_trailing_bytes')
    } catch(error) {if(error instanceof ApiError)throw error;bad('invalid_yjs_update')}
    const quarantined=new Set<string>()
    const quarantine=(op:string,reason:string):void=>{
      if(op===opKey)bad(reason)
      quarantined.add(op)
      this.sql.exec(`UPDATE wire_ops SET quarantined=1,pending=0 WHERE page=? AND op=?`,pageId,op)
      this.sql.exec(`DELETE FROM wire_fields WHERE page=? AND op=?`,pageId,op)
      for(const row of this.sql.exec<{client:number,clock:number}>(`SELECT client,MIN(clock) AS clock FROM wire_items WHERE page=? AND op=? GROUP BY client`,pageId,op)) {
        changedClients.add(row.client)
        this.sql.exec(`UPDATE wire_clocks SET next_clock=MIN(next_clock,?) WHERE page=? AND client=?`,row.clock,pageId,row.client)
        this.sql.exec(`UPDATE wire_ops SET pending=1 WHERE page=? AND quarantined=0 AND op IN (SELECT op FROM wire_items WHERE page=? AND client=? AND clock>=?)`,pageId,pageId,row.client,row.clock)
      }
      this.sql.exec(`DELETE FROM wire_items WHERE page=? AND op=?`,pageId,op)
      this.sql.exec(`INSERT OR IGNORE INTO wire_fields SELECT i.page,i.root,i.sub,i.value,i.op FROM wire_items i JOIN wire_ops o ON i.page=o.page AND i.op=o.op WHERE i.page=? AND o.quarantined=0 AND i.root IN ('page','timing') AND i.kind IN (2,8)`,pageId)
    }
    let advanced=true,passes=0
    while(advanced && passes++<64){
      advanced=false
      let client=-1,clock=-1
      while(true){
        const batch=this.sql.exec<Row>(`SELECT i.* FROM wire_items i JOIN wire_ops o ON i.page=o.page AND i.op=o.op WHERE i.page=? AND i.root IS NULL AND i.kind<>0 AND o.quarantined=0 AND (i.client>? OR (i.client=? AND i.clock>?)) ORDER BY i.client,i.clock LIMIT 64`,pageId,client,client,clock).toArray()
        if(!batch.length)break
        for(const row of batch){
          client=row.client;clock=row.clock
          if(quarantined.has(row.op))continue
          try {this.resolve(row);if(row.root){this.check(row,epoch);this.sql.exec(`UPDATE wire_items SET root=?,sub=? WHERE page=? AND client=? AND clock=?`,row.root,row.sub,pageId,row.client,row.clock);advanced=true}}
          catch(error){if(error instanceof ApiError){quarantine(row.op,error.code);advanced=true}else throw error}
        }
      }
    }
    // Check deletions only once parents are known. Same-value replacements are
    // allowed; deleting the last immutable field value is not.
    for(const item of this.sql.exec<Row & {delete_op:string}>(`SELECT i.*,d.op AS delete_op FROM wire_deletes d JOIN wire_ops o ON o.page=d.page AND o.op=d.op JOIN wire_items i ON i.page=d.page AND i.client=d.client AND i.clock<d.end_clock AND i.end_clock>d.clock WHERE d.page=? AND o.quarantined=0 AND o.pending=1 AND i.root IN ('page','timing')`,pageId)){
      if(item.sub===null || item.kind===1)continue
      const survivor=this.sql.exec(`SELECT 1 FROM wire_items i JOIN wire_ops o ON o.page=i.page AND o.op=i.op WHERE i.page=? AND i.root=? AND i.sub=? AND i.kind IN (2,8) AND o.quarantined=0 AND NOT EXISTS (SELECT 1 FROM wire_deletes d JOIN wire_ops x ON x.page=d.page AND x.op=d.op WHERE d.page=i.page AND d.client=i.client AND d.clock<=i.clock AND d.end_clock>i.clock AND x.quarantined=0) LIMIT 1`,pageId,item.root,item.sub).toArray().length>0
      if(!survivor)quarantine(item.delete_op,'immutable_field_deleted')
    }
    for(const client of changedClients) {
      let next=this.sql.exec<{next_clock:number}>(`SELECT next_clock FROM wire_clocks WHERE page=? AND client=?`,pageId,client).toArray()[0]?.next_clock??0
      for(const row of this.sql.exec<{clock:number,end_clock:number}>(`SELECT clock,end_clock FROM wire_items WHERE page=? AND client=? AND clock>=? ORDER BY clock`,pageId,client,next)) {
        if(row.clock>next)break
        next=Math.max(next,row.end_clock)
      }
      this.sql.exec(`INSERT INTO wire_clocks VALUES(?,?,?) ON CONFLICT(page,client) DO UPDATE SET next_clock=excluded.next_clock`,pageId,client,next)
    }
    const pageReady=this.sql.exec<{n:number}>(`SELECT COUNT(*) AS n FROM wire_fields WHERE page=? AND root='page'`,pageId).toArray()[0].n===4
    for(const op of this.sql.exec<Operation>(`SELECT op,quarantined,pending FROM wire_ops WHERE page=? AND quarantined=0 AND pending=1`,pageId)){
      let pending=!pageReady || this.sql.exec(`SELECT 1 FROM wire_items WHERE page=? AND op=? AND root IS NULL AND kind<>0 LIMIT 1`,pageId,op.op).toArray().length>0
      if(!pending)pending=this.sql.exec(`SELECT 1 FROM wire_items i JOIN wire_clocks c ON c.page=i.page AND c.client=i.client WHERE i.page=? AND i.op=? AND i.end_clock>c.next_clock LIMIT 1`,pageId,op.op).toArray().length>0
      if(!pending) for(const r of this.sql.exec<{client:number,clock:number,end_clock:number}>(`SELECT client,clock,end_clock FROM wire_deletes WHERE page=? AND op=?`,pageId,op.op)){if(!this.covered(pageId,r.client,r.clock,r.end_clock)){pending=true;break}}
      this.sql.exec(`UPDATE wire_ops SET pending=? WHERE page=? AND op=?`,pending?1:0,pageId,op.op)
    }
    const pending=this.sql.exec<{pending:number}>(`SELECT pending FROM wire_ops WHERE page=? AND op=?`,pageId,opKey).toArray()[0].pending!==0
    return {quarantined:[...quarantined],pending,hasContent}
  }
}
