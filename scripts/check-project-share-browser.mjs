#!/usr/bin/env node
// Real serialized project-share HTML, isolated mock service, no production data.
// PLAYWRIGHT_MODULE=/absolute/path/playwright/index.mjs node scripts/check-project-share-browser.mjs
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createServer } from 'vite'

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..')
const output=resolve(process.env.PROJECT_SHARE_BROWSER_ARTIFACTS??resolve(tmpdir(),'notemd-project-share-browser-artifacts'))
const scratch=await mkdtemp(resolve(tmpdir(),'notemd-share-browser-'))
let server, browser, context
const requests=[], bodies=[]
let version='S2', receiptActive=0, receiptMax=0, html=''
const hash='a'.repeat(64)
const snapshot={schemaVersion:1,project_id:'browser-project',snapshotId:'S2',entry:'README.md',files:[
  {path:'README.md',hash,bytes:10,markdown:'# Current S2\n\nPublished newer text'},
  {path:'docs/note.md',hash,bytes:10,markdown:'# Other file'},
]}
const old={v:2,lineageId:'browser-lineage',snapshotId:'S1',base:{'README.md':{hash,markdown:'# Original S1\n\n风险'}},after:{'README.md':'# Draft S1\n\n风险 modified'},annotationKinds:{}}
async function readBody(req) { const chunks=[];for await(const chunk of req)chunks.push(chunk);return Buffer.concat(chunks).toString('utf8') }
async function seed(page, entries) {
  await page.goto(origin+'/seed')
  await page.evaluate(async entries=> {
    const db=await new Promise((resolve,reject)=>{const op=indexedDB.open('notemd-project-sharing',1);op.onupgradeneeded=()=>op.result.createObjectStore('data');op.onsuccess=()=>resolve(op.result);op.onerror=()=>reject(op.error)})
    await new Promise((resolve,reject)=>{const tx=db.transaction('data','readwrite');for(const [key,value]of entries)tx.objectStore('data').put(value,key);tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error)})
    db.close()
  },entries)
}
async function stored(page, keys) {
  return page.evaluate(async keys=> {
    const db=await new Promise((resolve,reject)=>{const op=indexedDB.open('notemd-project-sharing',1);op.onsuccess=()=>resolve(op.result);op.onerror=()=>reject(op.error)})
    try {return await new Promise((resolve,reject)=> {
      const tx=db.transaction('data','readonly'),store=tx.objectStore('data'),values={}
      for(const key of keys) {const op=store.get(key);op.onsuccess=()=>{values[key]=op.result}}
      tx.oncomplete=()=>resolve(values);tx.onabort=()=>reject(tx.error)
    })} finally {db.close()}
  },keys)
}
let origin
try {
  await mkdir(output,{recursive:true})
  server=await createServer({root,configFile:false,envDir:scratch,logLevel:'error',server:{host:'127.0.0.1',port:0},plugins:[{
    name:'isolated-project-share-service',configureServer(vite) {
      vite.middlewares.use(async(req,res,next)=> {
        const path=new URL(req.url,'http://local').pathname
        const reply=(code,value)=>{res.statusCode=code;res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify(value))}
        try {
          if(path==='/seed') {res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Local browser fixture</title>');return}
          if(path==='/project/mock') {res.setHeader('Content-Type','text/html');res.setHeader('Cache-Control','no-store');res.end(html);return}
          if(path==='/project/mock/version') {requests.push({kind:'version',method:req.method,status:version==='gone'?410:200});reply(version==='gone'?410:200,{snapshotId:version});return}
          if(path.startsWith('/feedback/mock/receipt/')) {
            const id=decodeURIComponent(path.split('/').at(-1));receiptActive++;receiptMax=Math.max(receiptMax,receiptActive)
            requests.push({kind:'receipt',method:req.method,id})
            await new Promise(resolve=>setTimeout(resolve,25));receiptActive--
            if(id==='id-24')reply(404,{})
            else reply(200,{schemaVersion:1,project_id:'browser-project',submissionId:id,outcome:['partial','forwarded','rejected','superseded'][Number(id.split('-').at(-1))%4],files:[{path:'README.md',accepted:3,total:5}],reply:'<img src=x onerror="window.replyExecuted=true">回复'})
            return
          }
          if(path==='/feedback/mock'&&req.method==='POST') {
            const body=await readBody(req);bodies.push(body);const payload=JSON.parse(body)
            requests.push({kind:'submission',method:'POST',schemaVersion:payload.schemaVersion,snapshotId:payload.snapshotId,submissionId:payload.submissionId,bytes:Buffer.byteLength(body)})
            reply(bodies.length===1?503:200,{submissionId:payload.submissionId});return
          }
          next()
        }catch(error){reply(500,{error:String(error)})}
      })
    },
  }]})
  await server.listen()
  origin=server.resolvedUrls.local[0].replace(/\/$/,'')
  const {buildProjectBundle}=await server.ssrLoadModule('/src/lib/project-share/bundle.ts')
  html=buildProjectBundle(snapshot,origin+'/feedback/mock',{title:'Drafts and receipts',versionUrl:origin+'/project/mock/version'})
  const playwright=process.env.PLAYWRIGHT_MODULE?await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href):await import('playwright')
  browser=await playwright.chromium.launch({headless:true})
  context=await browser.newContext({viewport:{width:1200,height:850}})
  const page=await context.newPage(), errors=[]
  page.on('pageerror',error=>errors.push(String(error)))
  await seed(page,[['browser-project:draft2:browser-lineage',old],['browser-project:draft2-notes:browser-lineage',[{path:'README.md',selector:{exact:'风险',start:15,end:17,prefix:'# Original S1\n\n',suffix:''},comment:'请审阅',kind:'comment'}]],['browser-project:submitted',Array.from({length:25},(_,i)=>'id-'+i)]])
  await page.goto(origin+'/project/mock#feedback=local-fixture-token')
  await page.locator('#edit').waitFor({state:'visible'})
  await page.waitForFunction(()=>!document.querySelector('#edit').disabled)
  assert.match(await page.locator('#old-drafts').innerText(),/你在旧版本上有未提交的修改/)
  assert.equal(await page.locator('#editor').inputValue(),old.after['README.md'])
  await page.waitForFunction(()=>document.querySelector('#receipts').textContent.includes('已送达，待处理')&&document.querySelectorAll('#receipts p').length===20)
  await page.waitForTimeout(180)
  assert.equal(requests.filter(request=>request.kind==='receipt').length,20)
  assert.ok(receiptMax<=4)
  assert.equal(await page.locator('#receipts img').count(),0)
  await page.locator('#my-submissions summary').click()
  for(const label of ['已合入 3/5 处','已转入团队评审','未采纳','已被你的新提交取代']) assert.ok((await page.locator('#receipts').innerText()).includes(label))
  await page.screenshot({path:resolve(output,'stale-draft-receipts.png'),fullPage:true})
  await page.locator('#submit').click()
  await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('结果未知'))
  assert.equal(bodies.length,1)
  assert.equal(JSON.parse(bodies[0]).snapshotId,'S1')
  assert.equal(JSON.parse(bodies[0]).schemaVersion,2)
  assert.equal(JSON.parse(bodies[0]).client.kind,'browser-fallback')
  assert.equal(JSON.parse(bodies[0]).annotations[0].selector.exact,'风险')
  await page.locator('#edit').click();await page.locator('#editor').fill('# Later input on S1')
  await page.locator('#collaboration-options summary').click();await page.locator('#name').fill('Local contributor')
  version='S3'
  await page.locator('#submit').click()
  await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('已送达'))
  assert.equal(bodies[1],bodies[0])
  assert.match(await page.locator('#version-notice').innerText(),/分享者已发布新版本/)
  assert.equal(await page.locator('#editor').inputValue(),'# Later input on S1')
  const thirdResponse=page.waitForResponse(response=>response.url()===origin+'/feedback/mock'&&response.request().method()==='POST')
  await page.locator('#submit').click();await thirdResponse
  await page.waitForFunction(()=>!document.querySelector('#submit').disabled)
  assert.equal(bodies.length,3)
  assert.equal(await page.locator('#editor').inputValue(),'# Later input on S1')
  assert.equal(JSON.parse(bodies[2]).supersedes,JSON.parse(bodies[0]).submissionId)
  await page.locator('#submit').click();await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('没有新的修改或标注'))
  assert.equal(bodies.length,3)
  const v1Body='{ "schemaVersion":1,"project_id":"browser-project","snapshotId":"legacy-S0","submissionId":"legacy-submission","edits":[],"annotations":[] }'
  await seed(page,[['browser-project:legacy-S0',{drafts:{'README.md':'legacy draft'},annotations:[],pending:{body:v1Body}}]])
  await page.goto(origin+'/project/mock')
  const legacyRow=page.locator('#old-drafts p').filter({hasText:'旧版本有冻结提交'})
  await legacyRow.getByRole('button',{name:'按旧版本提交'}).click()
  await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('已送达'))
  assert.equal(bodies[3],v1Body)
  await page.locator('#submit').click();await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('没有新的修改或标注'))
  assert.equal(bodies.length,4)
  assert.equal(await page.evaluate(()=>window.replyExecuted),undefined)
  await page.screenshot({path:resolve(output,'version-and-v1-replay.png'),fullPage:true})
  await page.locator('#edit').click();await page.locator('#editor').fill('exportable after revoke')
  version='gone';await page.locator('#submit').click()
  await page.waitForFunction(()=>document.querySelector('#version-notice').textContent.includes('已失效'))
  assert.equal(await page.locator('#submit').isDisabled(),true)
  assert.equal(await page.locator('#editor').inputValue(),'exportable after revoke')
  await page.locator('#collaboration-options summary').click()
  assert.equal(await page.locator('#export').isEnabled(),true)
  await page.screenshot({path:resolve(output,'revoked-draft-export.png'),fullPage:true})
  const publicContext=await browser.newContext()
  try {
    const publicPage=await publicContext.newPage(),before=requests.filter(r=>r.kind==='receipt').length
    await publicPage.goto(origin+'/project/mock');await publicPage.waitForTimeout(100)
    assert.equal(await publicPage.locator('#collaboration').isVisible(),false)
    assert.equal(requests.filter(r=>r.kind==='receipt').length,before)
  } finally {await publicContext.close()}
  await context.close();context=undefined
  version='S2'
  const fix1={lineageReadGate:false,deletedOldFile:false,renamedOldFile:false}
  const lineageContext=await browser.newContext({viewport:{width:1200,height:850}})
  try {
    const scenario=await lineageContext.newPage();scenario.on('pageerror',error=>errors.push(String(error)))
    const current={v:2,lineageId:'current',snapshotId:'S2',base:{'README.md':{hash,markdown:'# CURRENT BASE'}},after:{'README.md':'CURRENT TEXT'},annotationKinds:{}}
    const previous={...old,lineageId:'old',after:{'README.md':'OLD TEXT'}}
    const currentNotes=[{path:'README.md',selector:{exact:'current'},comment:'CURRENT NOTE'}]
    const oldNotes=[{path:'README.md',selector:{exact:'风险'},comment:'OLD NOTE'}]
    await seed(scenario,[['browser-project:draft2:current',current],['browser-project:draft2:old',previous],['browser-project:draft2-notes:current',currentNotes],['browser-project:draft2-notes:old',oldNotes]])
    await scenario.goto(origin+'/project/mock#feedback=local-fixture-token')
    await scenario.waitForFunction(()=>!document.querySelector('#edit').disabled)
    await scenario.locator('#edit').click();await scenario.locator('#collaboration-options summary').click()
    // Gate only delivery of an actual IndexedDB transaction's completion. The
    // real get/result and all input-generated writes remain browser-native.
    await scenario.evaluate(()=> {
      const get=IDBObjectStore.prototype.get
      window.lineageReadGate={armed:true,started:false,release:null}
      IDBObjectStore.prototype.get=function(key) {
        const op=get.call(this,key),gate=window.lineageReadGate
        if(gate.armed&&key==='browser-project:draft2-notes:old') {
          gate.armed=false;let complete
          Object.defineProperty(this.transaction,'oncomplete',{configurable:true,set(fn){complete=fn}})
          this.transaction.addEventListener('complete',event=>{gate.started=true;gate.release=()=>complete?.(event)})
        }
        return op
      }
    })
    await scenario.locator('#old-drafts').getByRole('button',{name:'按旧版本提交'}).click()
    await scenario.waitForFunction(()=>window.lineageReadGate.started)
    await scenario.locator('#editor').fill('CURRENT INPUT DURING LOAD')
    await scenario.locator('#message').fill('CURRENT MESSAGE DURING LOAD')
    const keys=['browser-project:draft2:current','browser-project:draft2:old','browser-project:draft2-notes:current','browser-project:draft2-notes:old']
    let saved=await stored(scenario,keys)
    assert.equal(saved[keys[0]].after['README.md'],'CURRENT INPUT DURING LOAD')
    assert.equal(saved[keys[0]].message,'CURRENT MESSAGE DURING LOAD')
    await scenario.evaluate(()=>window.lineageReadGate.release())
    await scenario.waitForFunction(()=>!document.querySelector('#submit').disabled&&document.querySelector('#comments').textContent.includes('OLD NOTE'))
    saved=await stored(scenario,keys)
    assert.deepEqual(saved[keys[1]].after,previous.after);assert.deepEqual(saved[keys[2]],currentNotes);assert.deepEqual(saved[keys[3]],oldNotes)
    await scenario.reload();await scenario.waitForFunction(()=>!document.querySelector('#edit').disabled)
    assert.equal(await scenario.locator('#editor').inputValue(),'CURRENT INPUT DURING LOAD')
    await scenario.locator('#old-drafts').getByRole('button',{name:'按旧版本提交'}).click()
    await scenario.waitForFunction(()=>!document.querySelector('#submit').disabled&&document.querySelector('#comments').textContent.includes('OLD NOTE'))
    assert.equal(await scenario.locator('#editor').inputValue(),'OLD TEXT')
    assert.deepEqual((await stored(scenario,keys))[keys[3]],oldNotes)
    await scenario.screenshot({path:resolve(output,'fix1-lineage-read-gate.png'),fullPage:true})
    fix1.lineageReadGate=true
  } finally {await lineageContext.close()}
  for(const kind of ['deleted','renamed']) {
    const recoveryContext=await browser.newContext({viewport:{width:1200,height:850}})
    try {
      const scenario=await recoveryContext.newPage();scenario.on('pageerror',error=>errors.push(String(error)))
      const newSnapshot=structuredClone(snapshot)
      if(kind==='renamed')newSnapshot.files.push({path:'new/renamed.md',hash,bytes:10,markdown:'# RENAMED CURRENT'})
      html=buildProjectBundle(newSnapshot,origin+'/feedback/mock',{versionUrl:origin+'/project/mock/version'})
      const oldPath='old/deleted.md',base='# DELETED OLD BASE\n\n风险'
      const previous={v:2,lineageId:'missing',snapshotId:'S1',base:{[oldPath]:{hash,markdown:base}},after:{[oldPath]:'# DELETED OLD DRAFT'},annotationKinds:{}}
      const current={v:2,lineageId:'current',snapshotId:'S2',base:{},after:{},annotationKinds:{}}
      await seed(scenario,[['browser-project:draft2:missing',previous],['browser-project:draft2:current',current]])
      await scenario.goto(origin+'/project/mock#feedback=local-fixture-token')
      await scenario.waitForFunction(()=>!document.querySelector('#edit').disabled)
      const rowExport=scenario.waitForEvent('download')
      await scenario.locator('#old-drafts').getByRole('button',{name:'导出草稿'}).click()
      const originalExport=await rowExport
      const {readFile}=await import('node:fs/promises')
      assert.equal(JSON.parse(await readFile(await originalExport.path(),'utf8')).draft.base[oldPath].markdown,base)
      await scenario.locator('#old-drafts').getByRole('button',{name:'按旧版本提交'}).click()
      await scenario.waitForFunction(()=>!document.querySelector('#submit').disabled&&document.querySelector('#editor').value==='# DELETED OLD DRAFT')
      await scenario.locator('#file-toggle').click()
      await scenario.locator('[data-file="README.md"]').click()
      assert.equal(await scenario.locator('#edit').isDisabled(),true)
      await scenario.locator('[data-file="old/deleted.md"]').click()
      assert.equal(await scenario.locator('#edit').isEnabled(),true)
      await scenario.locator('#file-toggle').click()
      await scenario.locator('#collaboration-options summary').click();await scenario.locator('#baseline').click()
      assert.match(await scenario.locator('#document').innerText(),/DELETED OLD BASE/)
      await scenario.locator('#edit').click();await scenario.locator('#editor').fill('# EDITED MISSING '+kind)
      const before=bodies.length,response=scenario.waitForResponse(response=>response.url()===origin+'/feedback/mock'&&response.request().method()==='POST')
      await scenario.locator('#submit').click();await response;await scenario.waitForFunction(()=>!document.querySelector('#submit').disabled)
      assert.equal(bodies.length,before+1)
      assert.equal(JSON.parse(bodies.at(-1)).snapshotId,'S1')
      assert.deepEqual(JSON.parse(bodies.at(-1)).edits,[{path:oldPath,baseHash:hash,afterMarkdown:'# EDITED MISSING '+kind}])
      const download=scenario.waitForEvent('download');await scenario.locator('#export').click();const exported=await download
      const draftFile=await exported.path()
      const content=JSON.parse(await readFile(draftFile,'utf8'))
      assert.equal(content.draft.base[oldPath].markdown,base);assert.equal(content.draft.after[oldPath],'# EDITED MISSING '+kind)
      await scenario.screenshot({path:resolve(output,'fix1-'+kind+'-old-file.png'),fullPage:true})
      await scenario.reload();await scenario.waitForFunction(()=>!document.querySelector('#edit').disabled)
      await scenario.locator('#old-drafts').getByRole('button',{name:'按旧版本提交'}).click()
      await scenario.waitForFunction(()=>!document.querySelector('#submit').disabled&&document.querySelector('#editor').value.startsWith('# EDITED MISSING'))
      assert.equal(await scenario.locator('#editor').inputValue(),'# EDITED MISSING '+kind)
      fix1[kind+'OldFile']=true
    } finally {await recoveryContext.close()}
  }
  assert.deepEqual(errors,[])
  const summary={result:'PASS',receipts:{recent20:true,maxConcurrent:receiptMax,replyTextOnly:true},draft:{oldSnapshot:'S1',pendingByteIdentical:true,newSubmissionSupersedes:true,v1ByteIdentical:true,revocationKeepsExport:true},fix1,requests}
  await writeFile(resolve(output,'safe-summary.json'),JSON.stringify(summary,null,2)+'\n')
  console.log('PASS: real bundled HTML, S1 on S2, v2/v1 exact retries, receipts recent20/concurrency<=4/text, version banner and revoked export')
  console.log('PASS fix1: real notes read gate + input + persisted/restarted lineages; deleted/renamed old paths edit, S1 submit and export')
  console.log('Artifacts: '+output)
} finally {
  await context?.close()
  await browser?.close()
  await server?.close()
  await rm(scratch,{recursive:true,force:true})
}
