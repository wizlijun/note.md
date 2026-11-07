import test from 'node:test'
import assert from 'node:assert/strict'
import { corpus, quantiles } from './corpus.mjs'
test('corpus hashes, UTF16 boundaries and sentinels are deterministic',()=>{
 for(const units of [10000,100000,1000000]){
  const value=corpus(units);assert.equal(value.markdown.length,units);assert.equal(value.sha256,corpus(units).sha256)
  for(const marker of value.markers)assert.equal(value.markdown.split(marker).length,2)
  assert(value.markdown.includes('👩‍💻'));assert(value.markdown.includes('é'));assert(!/(?<!\n)\n(?!\n)/.test(value.markdown))
 }
})
test('p95 uses documented nearest rank and preserves raw samples',()=>{const values=Array.from({length:100},(_,i)=>100-i);assert.deepEqual(quantiles(values),{count:100,p50:50,p95:95,p99:99,max:100});assert.equal(values[0],100);assert.equal(quantiles([]),null)})
