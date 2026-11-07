import { env, runInDurableObject } from 'cloudflare:test'
import { it, expect } from 'vitest'
import * as Y from 'yjs'
import { PackedWireValidator as WireValidator } from '../src/packed-wire-validator'
import { unb64 } from '../src/protocol'
import { Env } from '../src/index'
import fixture from '../../write-core/tests/fixtures/yrs-v1.json'
import pending from '../../write-core/tests/fixtures/pending-invalid-v1.json'
import fork from '../../write-core/tests/fixtures/fork-v1.json'
const bindings=env as unknown as Env
async function sqlTest(fn:(validator:WireValidator,tx:<T>(f:()=>T)=>T)=>void) {
  const stub=bindings.SPACES.get(bindings.SPACES.idFromName(crypto.randomUUID()))
  await runInDurableObject(stub,async(_instance:any,state:any)=>{
    const v=new WireValidator(state.storage.sql)
    fn(v,(f)=>state.storage.transactionSync(f))
  })
}
it('validates actual Rust wire in reverse order and does not build a Y.Doc',async()=>{
  await sqlTest((v,tx)=>{
    const b=unb64(fixture.base),a=unb64(fixture.updates[0]),z=unb64(fixture.updates[1])
    expect(tx(()=>v.validate(fixture.pageId,1,'later',z)).pending).toBe(true)
    tx(()=>v.validate(fixture.pageId,1,'base',b))
    tx(()=>v.validate(fixture.pageId,1,'left',a))
    expect(tx(()=>v.validate(fixture.pageId,1,'full',unb64(fixture.full))).quarantined).toEqual([])
  })
})
it('quarantines the original bad pending packet when a legitimate dependency arrives',async()=>{
  await sqlTest((v,tx)=>{
    tx(()=>v.validate(pending.pageId,1,'base',unb64(pending.base)))
    expect(tx(()=>v.validate(pending.pageId,1,'bad',unb64(pending.pendingInvalid))).pending).toBe(true)
    const result=tx(()=>v.validate(pending.pageId,1,'good-dependency',unb64(pending.dependency)))
    expect(result.quarantined).toEqual(['bad'])
    expect(result.pending).toBe(false)
  })
})
it('rejects immutable timing deletion and actor collision without retaining the failed packet',async()=>{
  await sqlTest((v,tx)=>{
    tx(()=>v.validate(fixture.pageId,1,'base',unb64(fixture.full)))
    const d=new Y.Doc();Y.applyUpdate(d,unb64(fixture.full))
    const before=Y.encodeStateVector(d)
    d.getMap('timing').clear()
    expect(()=>tx(()=>v.validate(fixture.pageId,1,'delete-time',Y.encodeStateAsUpdate(d,before)))).toThrow()
    const collision=new Y.Doc();collision.clientID=100;collision.getMap('page').set('schema',2)
    expect(()=>tx(()=>v.validate(fixture.pageId,1,'collision',Y.encodeStateAsUpdate(collision)))).toThrow()
    expect(tx(()=>v.validate(fixture.pageId,1,'still-good',unb64(fixture.full))).quarantined).toEqual([])
  })
})
it('rejects nested data and unexpected trailing bytes',async()=>{
  await sqlTest((v,tx)=>{
    const d=new Y.Doc();d.getMap('page').set('nested',new Y.Map())
    expect(()=>tx(()=>v.validate(fixture.pageId,1,'nested',Y.encodeStateAsUpdate(d)))).toThrow()
    const b=unb64(fixture.base),extra=new Uint8Array(b.length+1);extra.set(b)
    expect(()=>tx(()=>v.validate(fixture.pageId,1,'extra',extra))).toThrow()
  })
})

it('accepts actual Rust recovery provenance without inventing a device write',async()=>{
 await sqlTest((v,tx)=>{expect(tx(()=>v.validate(fork.pageId,1,'recover',unb64(fork.full))).pending).toBe(false)})
})

import { WireValidator as Legacy } from '../src/wire-validator'
import { PackedWireValidator as Packed } from '../src/packed-wire-validator'
import { ApiError } from '../src/protocol'

async function compare(packets:{op:string;bytes:Uint8Array}[]) {
 const stub=bindings.SPACES.get(bindings.SPACES.idFromName(crypto.randomUUID()))
 await runInDurableObject(stub,async(_instance:any,state:any)=>{
  const old=new Legacy(state.storage.sql),packed=new Packed(state.storage.sql)
  const call=(v:Legacy|Packed,p:{op:string;bytes:Uint8Array})=>{
   try {const r=state.storage.transactionSync(()=>v.validate(fixture.pageId,1,p.op,p.bytes));return {ok:true,...r,quarantined:r.quarantined.sort()}}
   catch(e){return {ok:false,code:e instanceof ApiError?e.code:String(e)}}
  }
  for(const packet of packets)expect(call(packed,packet),packet.op).toEqual(call(old,packet))
  const reopened=new Packed(state.storage.sql)
  const last={op:'reopened-full',bytes:unb64(fixture.full)}
  expect(call(reopened,last)).toEqual(call(old,last))
 })
}
it('matches the legacy validator under deterministic offline permutations and duplicates',async()=>{
 let seed=0x9372a;const rand=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed}
 const peers=Array.from({length:4},()=>{const d=new Y.Doc({gc:false});Y.applyUpdate(d,unb64(fixture.full));return d})
 const packets:{op:string;bytes:Uint8Array}[]=[]
 const timingValue=peers[0].getMap('timing').values().next().value
 for(let n=0;n<180;n++){
  const d=peers[rand()%peers.length],text=d.getText('body'),before=Y.encodeStateVector(d)
  d.transact(()=>{
   if(n%5===0&&text.length>2)text.delete(rand()%text.length,1)
   else text.insert(rand()%(text.length+1),n%7===0?'中文':'x')
   if(n%9===0)d.getMap('timing').set(crypto.randomUUID(),timingValue)
  })
  packets.push({op:`offline-${n}`,bytes:Y.encodeStateAsUpdate(d,before)})
 }
 for(let n=packets.length-1;n>0;n--){const j=rand()%(n+1);[packets[n],packets[j]]=[packets[j],packets[n]]}
 packets.splice(30,0,{op:'base',bytes:unb64(fixture.full)})
 packets.push(...packets.slice(0,20).map((p,n)=>({...p,op:`duplicate-${n}`})))
 await compare(packets)
})
it('matches delayed bad-field quarantine and rollback on all packet permutations',async()=>{
 const start={op:'base',bytes:unb64(pending.base)},bad={op:'bad',bytes:unb64(pending.pendingInvalid)},dep={op:'dep',bytes:unb64(pending.dependency)}
 for(const order of [[start,bad,dep],[bad,start,dep],[bad,dep,start],[dep,bad,start],[dep,start,bad],[start,dep,bad]])await compare(order)
})
it('splits long text across clock blocks without losing duplicate/overlap identity',async()=>{
 const d=new Y.Doc({gc:false});Y.applyUpdate(d,unb64(fixture.full));const before=Y.encodeStateVector(d)
 d.getText('body').insert(0,'中😀'.repeat(3000));const initial=Y.encodeStateAsUpdate(d,before)
 const checkpoint=Y.encodeStateVector(d);d.getText('body').delete(255,800);d.getText('body').insert(520,'end')
 await compare([{op:'base',bytes:unb64(fixture.full)},{op:'long',bytes:initial},{op:'long-again',bytes:initial},{op:'edited',bytes:Y.encodeStateAsUpdate(d,checkpoint)},{op:'full',bytes:Y.encodeStateAsUpdate(d)}])
})
it('preserves distinct UUID spelling and same-value immutable replacements',async()=>{
 const d=new Y.Doc({gc:false});Y.applyUpdate(d,unb64(fixture.full));const before=Y.encodeStateVector(d)
 const value=d.getMap('timing').values().next().value,id='abcdefab-abcd-4abc-8abc-abcdefabcdef'
 d.getMap('timing').set(id,value);d.getMap('timing').set(id.toUpperCase(),value)
 const first=Y.encodeStateAsUpdate(d,before),next=Y.encodeStateVector(d)
 d.getMap('page').set('epoch',1);d.getMap('timing').set(id,value)
 await compare([{op:'base',bytes:unb64(fixture.full)},{op:'spelling',bytes:first},{op:'same-value',bytes:Y.encodeStateAsUpdate(d,next)}])
})
it('stores large valid timing values outside bounded item blocks and retains immutability',async()=>{
 const d=new Y.Doc({gc:false});Y.applyUpdate(d,unb64(fixture.full));const before=Y.encodeStateVector(d)
 const original=JSON.parse(d.getMap('timing').values().next().value as string)
 original[3]=Array.from({length:300},()=>original[3][0]);const value=JSON.stringify(original)
 expect(value.length).toBeGreaterThan(4096)
 const id=crypto.randomUUID();d.getMap('timing').set(id,value);const first=Y.encodeStateAsUpdate(d,before),next=Y.encodeStateVector(d)
 original[1]++;d.getMap('timing').set(id,JSON.stringify(original))
 await compare([{op:'base',bytes:unb64(fixture.full)},{op:'large',bytes:first},{op:'mutation',bytes:Y.encodeStateAsUpdate(d,next)}])
})

it('rejects adversarial dense UUID buckets promptly and rolls the whole packet back',async()=>{
 const d=new Y.Doc({gc:false});Y.applyUpdate(d,unb64(fixture.full));const value=d.getMap('timing').values().next().value
 for(let n=0;n<4100;n++)d.getMap('timing').set(`aaa00000-0000-4000-8000-${n.toString(16).padStart(12,'0')}`,value)
 const stub=bindings.SPACES.get(bindings.SPACES.idFromName(crypto.randomUUID()))
 await runInDurableObject(stub,async(_instance:any,state:any)=>{
  const packed=new Packed(state.storage.sql),begin=Date.now()
  expect(()=>state.storage.transactionSync(()=>packed.validate(fixture.pageId,1,'dense',Y.encodeStateAsUpdate(d)))).toThrow('field_bucket_capacity')
  expect(Date.now()-begin).toBeLessThan(5000)
  expect(state.storage.sql.exec('SELECT count(*) AS n FROM packed_ops').toArray()[0].n).toBe(0)
  expect(state.storage.transactionSync(()=>new Packed(state.storage.sql).validate(fixture.pageId,1,'good-after-rollback',unb64(fixture.full))).pending).toBe(false)
 })
})
it('retains valid field survivors when another operation is quarantined',async()=>{
 const d=new Y.Doc({gc:false});Y.applyUpdate(d,unb64(pending.base));const before=Y.encodeStateVector(d)
 const id=crypto.randomUUID(),value=JSON.parse(peekTiming())
 d.getMap('timing').set(id,JSON.stringify(value));const good=Y.encodeStateAsUpdate(d,before)
 const next=Y.encodeStateVector(d);d.getMap('timing').set(id,JSON.stringify(value));const duplicate=Y.encodeStateAsUpdate(d,next)
 await compare([{op:'base',bytes:unb64(pending.base)},{op:'good-time',bytes:good},{op:'bad',bytes:Y.mergeUpdates([duplicate,unb64(pending.pendingInvalid)])},{op:'dependency',bytes:unb64(pending.dependency)}])
})
function peekTiming():string {const d=new Y.Doc();Y.applyUpdate(d,unb64(fixture.full));return d.getMap('timing').values().next().value as string}

it('quarantines a deferred final-field deletion without blaming its legitimate replacement',async()=>{
 for(const [replaceOp,deleteOp] of [['a-replace','z-delete'],['z-replace','a-delete']]) {
  const d=new Y.Doc({gc:false});Y.applyUpdate(d,unb64(pending.base));d.clientID=7777
  const updates:Uint8Array[]=[];d.on('update',(u:Uint8Array)=>updates.push(u))
  const key=crypto.randomUUID(),value=d.getMap('timing').values().next().value
  d.getMap('timing').set(key,value);d.transact(()=>{d.getText('body').insert(0,'KEEP');d.getMap('timing').set(key,value)});d.getMap('timing').delete(key)
  expect(updates).toHaveLength(3)
  const stub=bindings.SPACES.get(bindings.SPACES.idFromName(crypto.randomUUID()))
  await runInDurableObject(stub,async(_instance:any,state:any)=>{
   const v=new Packed(state.storage.sql),apply=(op:string,u:Uint8Array)=>state.storage.transactionSync(()=>v.validate(pending.pageId,1,op,u))
   apply('base',unb64(pending.base))
   expect(apply(replaceOp,updates[1]).pending).toBe(true)
   expect(apply(deleteOp,updates[2]).pending).toBe(true)
   expect(apply('dependency',updates[0]).quarantined).toEqual([deleteOp])
   expect(state.storage.sql.exec('SELECT quarantined,pending FROM packed_ops WHERE op=?',replaceOp).toArray()[0]).toMatchObject({quarantined:0,pending:0})
   const replay=new Y.Doc();for(const bytes of [unb64(pending.base),updates[1],updates[0]])Y.applyUpdate(replay,bytes);expect(replay.getText('body').toString()).toContain('KEEP')
  })
 }
})

it('reads immutable references across multiple field segments after reopening',async()=>{
 const d=new Y.Doc({gc:false});Y.applyUpdate(d,unb64(fixture.full));const value=d.getMap('timing').values().next().value as string
 for(let n=0;n<3000;n++)d.getMap('timing').set(`bbb00000-0000-4000-8000-${n.toString(16).padStart(12,'0')}`,value)
 const full=Y.encodeStateAsUpdate(d),before=Y.encodeStateVector(d),changed=JSON.parse(value);changed[1]++
 d.getMap('timing').set(`bbb00000-0000-4000-8000-${(2999).toString(16).padStart(12,'0')}`,JSON.stringify(changed))
 await compare([{op:'segmented',bytes:full},{op:'mutated-last-segment',bytes:Y.encodeStateAsUpdate(d,before)}])
})
