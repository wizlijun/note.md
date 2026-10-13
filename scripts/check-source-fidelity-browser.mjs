import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'vite'

const root = process.cwd()
const outputDir = resolve(process.env.SOURCE_FIDELITY_OUTPUT_DIR || '.superpowers/sdd/2026-10-13-shared-editor-source-fidelity')
const cacheDir = resolve(process.env.SOURCE_FIDELITY_CACHE_DIR || resolve(outputDir, 'task1-vite-cache'))
mkdirSync(outputDir, { recursive: true })
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE || '/Users/bruce/.npm/_npx/fd3bca3c548369c0/node_modules/playwright/index.mjs').href)
const coreDist = realpathSync('node_modules/@moraya/core/dist/index.js')
const base = '这是甲句。中间句保持。末句保持 _斜体_ 与 [链接](<https://example.com>)。'
const expected = '这是乙句。中间句保持。末句保持 _斜体_ 与 [链接](<https://example.com>)。'
const fixture = `<!doctype html><meta charset="utf-8"><style>.ProseMirror{min-height:300px}#editor{width:800px}</style><div id="editor"></div><div id="source"></div><script type="module">
import { mountDocumentEditor } from '/src/editor-kit-v2/main.ts'
import { mountSource } from '/src/editor-kit/source.ts'
import { propose } from '/src/lib/share-merge/index.ts'
window.notemd={request:async method=>method==='host.vault.info'?{root:''}:{},onMessage(){}}
window.batches=[];window.surfaceStates=[]
window.test={
 async open(source,preserveSource=true){window.snapshot={documentId:crypto.randomUUID(),revisionId:'r1',blocks:[{blockId:'b',blockRevision:'br1',markdown:source}]};window.mounted=await mountDocumentEditor(document.querySelector('#editor'),{snapshot,preserveSource,ids:{requestId:()=>crypto.randomUUID(),operationId:()=>crypto.randomUUID()},localChangeDebounceMs:10});mounted.surface.observeLocalOperations(b=>batches.push(b));mounted.surface.observeState(s=>surfaceStates.push(s))},
 draft(){return mounted.surface.getDraftMarkdown()},
 doc(){return document.querySelector('.ProseMirror').pmViewDesc.node.toJSON()},
 source(value){const source=mountSource(document.querySelector('#source'),value,()=>{});const output=source.getValue();source.destroy();return output},
 select(needle){const el=document.querySelector('.ProseMirror');el.focus();const walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);let node;while(node=walker.nextNode()){const index=node.textContent.indexOf(needle);if(index>=0){const range=document.createRange();range.setStart(node,index);range.setEnd(node,index+needle.length);const sel=window.getSelection();sel.removeAllRanges();sel.addRange(range);return true}}return false},
 result(base){const after=this.draft();return {after,doc:this.doc(),batches:structuredClone(batches),proposal:propose({path:'case.md',base,ours:base,theirs:after})}},
 async ack(markdown){const request=batches.at(-1);await mounted.surface.reconcile({kind:'ack-local',requestId:request.requestId,authoritative:{...snapshot,revisionId:'r2',blocks:[{...snapshot.blocks[0],blockRevision:'br2',markdown}]},includedChangeIds:[]});return surfaceStates.at(-1)}
};window.ready=true
</script>`
const server = await createServer({ root, configFile: false, envDir: resolve(outputDir, 'empty-env'), cacheDir,
  server: {host:'127.0.0.1',port:0,hmr:false,watch:null},
  plugins: [{name:'source-fidelity-fixture',configureServer(vite){
    vite.middlewares.use('/__source_fidelity',(_req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end(fixture)})
    vite.middlewares.use('/src/editor-kit-v2/editor-kit-v1.css',(_req,res)=>{res.setHeader('Content-Type','text/css');res.end('')})
  }}],
})
let browser
const responseHashes = []
const output = {environment:{node:process.version,coreDist,coreSha256:createHash('sha256').update(readFileSync(coreDist)).digest('hex')},pageErrors:[],coreResponses:[],cases:[]}
try {
  await server.listen()
  browser = await chromium.launch({headless:true})
  output.environment.browser = browser.version()
  const page = await browser.newPage()
  page.on('pageerror',error=>output.pageErrors.push(String(error)))
  page.on('response',response=>{if(response.url().includes('moraya')) responseHashes.push(response.body().then(body=>output.coreResponses.push({url:response.url(),sha256:createHash('sha256').update(body).digest('hex')})))})
  const url = `http://127.0.0.1:${server.httpServer.address().port}/__source_fidelity`
  const open = async (source=base,preserveSource=true) => {
    await page.goto(url); await page.waitForFunction(()=>window.ready)
    await page.evaluate(({source,preserveSource})=>test.open(source,preserveSource),{source,preserveSource})
  }
  let round = base
  output.cycles=[]
  for(let i=0;i<3;i++) {
    await open(round)
    round = await page.evaluate(()=>test.source(test.draft()))
    assert.equal(round,base)
    output.cycles.push(round)
  }
  await open()
  const row={name:'edit-separated-sentences',base,selected:await page.evaluate(()=>test.select('甲'))}
  assert.ok(row.selected)
  await page.keyboard.insertText('乙')
  await page.waitForFunction(()=>batches.length>0)
  row.edited=await page.evaluate(base=>test.result(base),base)
  assert.deepEqual(Buffer.from(row.edited.after),Buffer.from(expected),'only selected sentence bytes may change')
  assert.equal(row.edited.batches.length,1)
  assert.equal(row.edited.batches[0].operations.length,1)
  assert.equal(row.edited.batches[0].operations[0].kind,'block.replace')
  assert.equal(row.edited.batches[0].operations[0].payload.content,expected)
  const hunks=row.edited.proposal.hunks
  assert.equal(hunks.length,1);assert.equal(hunks[0].base,'这是甲句。');assert.equal(hunks[0].theirs,'这是乙句。')
  assert.equal(hunks[0].oursStart,0);assert.equal(hunks[0].oursEnd,5)
  row.afterUtf8Bytes=Buffer.byteLength(row.edited.after)
  output.cases.push(row)
  // Unsupported authority cannot clear pending or touch the source/PM state.
  output.rejectedAck=await page.evaluate(async()=>{
    const before={source:test.draft(),doc:test.doc(),state:surfaceStates.at(-1)}
    let error;try{await test.ack('远端改动。')}catch(e){error=String(e)}
    return {before,after:{source:test.draft(),doc:test.doc(),state:surfaceStates.at(-1)},error}
  })
  assert.match(output.rejectedAck.error,/SOURCE_FIDELITY/)
  assert.deepEqual(output.rejectedAck.after,output.rejectedAck.before)
  output.ack=await page.evaluate(expected=>test.ack(expected),expected)
  assert.equal(output.ack.dirty,false);assert.equal(output.ack.saving,false)
  assert.equal(await page.evaluate(()=>test.draft()),expected)
  await open()
  const before=await page.evaluate(()=>({source:test.draft(),doc:test.doc(),operations:batches.length}))
  assert.ok(await page.evaluate(()=>test.select('甲')))
  await page.keyboard.insertText('*乙*')
  await page.waitForTimeout(100)
  const after=await page.evaluate(()=>({source:test.draft(),doc:test.doc(),operations:batches.length}))
  output.semanticGuard={before,after}
  assert.deepEqual(after,before,'rejected text intent must leave PM, source and operation count unchanged')
  await open(base,false)
  assert.ok(await page.evaluate(()=>test.select('甲')))
  await page.keyboard.insertText('乙');await page.waitForFunction(()=>batches.length>0)
  output.defaultAfter=await page.evaluate(()=>test.draft())
  assert.equal(output.defaultAfter,'这是乙句。中间句保持。末句保持 *斜体* 与 [链接](https://example.com)。')
  assert.deepEqual(output.pageErrors,[])
  output.status='PASS'
  console.log(`PASS: real Kit opt-in ${row.afterUtf8Bytes} bytes; 1 hunk 0..5; semantic rejection, exact ack, default behavior; 0 pageErrors`)
} finally {
  await Promise.all(responseHashes)
  writeFileSync(resolve(outputDir,'task1-kit-results.json'),JSON.stringify(output,null,2)+'\n')
  await browser?.close();await server.close()
}
