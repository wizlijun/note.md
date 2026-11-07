import { env, runInDurableObject } from 'cloudflare:test'
import { it, expect } from 'vitest'
import * as Y from 'yjs'
import { WireValidator } from '../src/wire-validator'
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
