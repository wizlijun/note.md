#!/usr/bin/env node
// Actual serialized reader + content-addressed IIFE. No replacement editor module.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { shareEditorAssets } from './share-editor-assets.mjs'
import { Window } from 'happy-dom'
const root=process.cwd(), scratch=await mkdtemp(resolve(tmpdir(),'share-reader-'))
const output=process.env.GATE_LOG_DIR??resolve(scratch,'evidence')
const sha=s=>createHash('sha256').update(s).digest('hex')
const manifest=JSON.parse(await readFile(resolve(root,'dist/share-editor-manifest.json'),'utf8'))
const assets=new Map(await Promise.all(['js','css'].map(async k=>[manifest[k].name,await readFile(resolve(root,'dist/assets',manifest[k].name)).catch(()=>readFile(resolve(root,'dist',manifest[k].name)))])))
let html='', origin, browser, server, mode='ok', postStatus=200, postDelay=0, receiptStatus=404
const requests=[], bodies=[], errors=[], violations=[], checks=[], network=[], evidence=[]
const base='第一句。\n\n第二句。\n'
const structure='soft one\nsoft two\n\nhard one  \nhard two\n\n{==范围批注==}{>>owner<<}{>>point<<}\n\n- [ ] 待办\n- 普通列表\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n$x^2 + \\frac{1}{2}$\n\n```js\nconst a = 1\n```\n'
const snapshot={schemaVersion:1,project_id:'kit-project',snapshotId:'S1',entry:'a.md',files:[{path:'a.md',hash:sha(base),bytes:Buffer.byteLength(base),markdown:base},{path:'b.md',hash:sha(structure),bytes:Buffer.byteLength(structure),markdown:structure}]}
try {
 await mkdir(output,{recursive:true})
 server=await createServer({root,configFile:false,envDir:scratch,logLevel:'error',optimizeDeps:{noDiscovery:true,include:[]},server:{host:'127.0.0.1',port:0},plugins:[svelte(),shareEditorAssets({test:true}),{name:'actual-share-reader',configureServer(vite){vite.middlewares.use(async(req,res,next)=>{
  const path=new URL(req.url,'http://local').pathname
  if(path.startsWith('/_kit/')) {requests.push(path);const bytes=assets.get(path.slice(6));if(mode==='timeout')return;if(mode==='404'||!bytes){res.statusCode=404;res.end();return}res.setHeader('Content-Type',path.endsWith('.css')?'text/css':'application/javascript');res.end(mode==='sri'?Buffer.concat([bytes,Buffer.from('\n/* corrupted */')]):bytes);return}
  if(path==='/project/mock'){res.setHeader('Content-Type','text/html');res.end(html);return}
  if(path==='/project/mock/version'){res.setHeader('Content-Type','application/json');res.end('{"snapshotId":"S1"}');return}
  if(path.startsWith('/feedback/mock/receipt/')){res.statusCode=receiptStatus;res.setHeader('Content-Type','application/json');res.end('{}');return}
  if(path==='/feedback/mock'&&req.method==='POST'){let body='';for await(const c of req)body+=c;bodies.push(body);if(postDelay)await new Promise(r=>setTimeout(r,postDelay));if(postStatus===0){res.destroy();return}res.statusCode=postStatus;res.setHeader('Content-Type','application/json');res.end('{}');return}
  next()
 })}}]})
 await server.listen();origin=server.resolvedUrls.local[0].replace(/\/$/,'')
 const dom=new Window({url:origin});dom.document.write('<!doctype html><html><body></body></html>');Object.assign(globalThis,{window:dom,document:dom.document,DOMParser:dom.DOMParser,Node:dom.Node,HTMLElement:dom.HTMLElement})
 const {buildProjectBundle}=await server.ssrLoadModule('/src/lib/project-share/bundle.ts')
 const descriptor={apiVersion:1,...Object.fromEntries(['js','css'].map(k=>[k,{url:origin+'/_kit/'+manifest[k].name,integrity:manifest[k].sri}]))}
 const {renderProjectPresentation}=await server.ssrLoadModule('/src/lib/project-share/presentation.ts')
 const theme={themeId:'frozen-one',compiledCss:'[data-theme="frozen-one"] .moraya-editor{color:rgb(31,53,71);font-family:Georgia,serif;font-size:19px;line-height:1.8}'}
 const presentation=await renderProjectPresentation(snapshot,{frozenTheme:theme})
 html=buildProjectBundle(snapshot,origin+'/feedback/mock',{editorKit:descriptor,presentation})
 const playwright=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href:'playwright')
 browser=await playwright.chromium.launch({headless:true})
 async function open(fault) {
  const context=await browser.newContext({viewport:{width:1200,height:850}}),page=await context.newPage()
  page.on('pageerror',e=>errors.push(String(e)))
  page.on('request',r=>network.push({url:r.url().split('#')[0],type:r.resourceType()}))
  await page.addInitScript(fault=> {
   window.cspViolations=[];document.addEventListener('securitypolicyviolation',e=>window.cspViolations.push({directive:e.violatedDirective,blocked:e.blockedURI}))
   window.calls={build:0,submit:0};window.writes=[];window.fault=fault;window.pendingCommits=0
   let module
   // Observe the actual module's public calls; never replace the real mount/owner.
   Object.defineProperty(window,'NotemdShareEditor',{configurable:true,get:()=>module,set:value=> {
    module=value;if(window.fault==='api')value.apiVersion=2
    const mount=value.mount
    value.mount=async(...args)=> {
     window.realHost=args[1];window.live=await args[1].loadDraft()
     if(window.fault==='mount'){const badges=args[1].setFileBadges;args[1].setFileBadges=(...a)=>{args[1].setFileBadges=badges;throw Error('injected mount failure')}}
     const submit=args[1].submit;args[1].submit=async(...params)=>{window.calls.submit++;return submit(...params)}
     const handle=await mount(...args),build=handle.buildSubmission
     handle.buildSubmission=async(...params)=>{window.calls.build++;return build(...params)}
     window.realHandle=handle;return handle
    }
   }})
   const put=IDBObjectStore.prototype.put
   IDBObjectStore.prototype.put=function(value,key) {
    if(typeof key==='string'&&key.includes(':draft2:')) {
     const copy=structuredClone(value);window.writes.push(copy)
     if(window.pausePending && value.pending && !window.pendingPaused) {window.pendingPaused=true;const store=this;const pump=()=>{if(window.pausePending){const o=store.get('__test_keepalive__');o.onsuccess=pump}};pump()}
     const fail=window.fault==='pending'&&!!value.pending || window.fault==='confirm'&&!!value.lastSubmissionId&&!value.pending || window.fault==='ordinary'&&!value.pending
     if(fail){window.fault=undefined;this.transaction.abort();throw Error('injected IDB failure')}
     if(value.pending)this.transaction.addEventListener('complete',()=>window.pendingCommits++)
    }
    return put.call(this,value,key)
   }
  },fault)
  return {page,context}
 }
 async function enter(page) {
  await page.goto(origin+'/project/mock#feedback=local-fixture-token')
  await page.waitForFunction(()=>!document.querySelector('#edit').disabled)
  await page.locator('#edit').click()
  await page.locator('.ProseMirror').waitFor()
 }
 async function source(page,text) {
  await page.getByRole('button',{name:'Source',exact:true}).click()
  if(text!==undefined)await page.locator('.kit-source-ta').fill(text)
 }
 async function raw(page) {return page.evaluate(()=>window.live.after['a.md'])}
 async function stored(page) {
  return page.evaluate(async()=> {
   const db=await new Promise((r,j)=>{const o=indexedDB.open('notemd-project-sharing',1);o.onsuccess=()=>r(o.result);o.onerror=()=>j(o.error)})
   try{return await new Promise((r,j)=>{const tx=db.transaction('data'),store=tx.objectStore('data'),o=store.getAll();tx.oncomplete=()=>r(o.result.filter(v=>v?.v===2));tx.onabort=()=>j(tx.error)})}finally{db.close()}
  })
 }
 if(process.env.SHARE_EDITOR_BROWSER_CASE==='receipts') {
  for(const [code,label]of [[404,'已送达，待处理'],[403,'权限不足'],[410,'分享已失效']]) {
   receiptStatus=code;const {page,context}=await open()
   await enter(page);await page.evaluate(async()=>{const db=await new Promise(r=>{const o=indexedDB.open('notemd-project-sharing',1);o.onsuccess=()=>r(o.result)});await new Promise((r,j)=>{const t=db.transaction('data','readwrite');t.objectStore('data').put(['receipt-test'],'kit-project:submitted');t.oncomplete=r;t.onabort=j});db.close()})
   await page.reload();await page.waitForFunction(label=>document.querySelector('#receipts').textContent.includes(label),label)
   checks.push('receipt-'+code+'-'+label);await context.close()
  }
 } else if(process.env.SHARE_EDITOR_BROWSER_CASE==='fallback-critic') {
  const {page,context}=await open(),critic='{==第一句==}{>>访客批注<<}。\n\n第二句。\n'
  await enter(page);await source(page,critic);await page.waitForTimeout(450)
  mode='404';await page.reload();await page.waitForFunction(()=>!document.querySelector('#edit').disabled);await page.locator('#edit').click()
  await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('增强编辑器不可用'))
  const before=bodies.length;await page.locator('#editor').fill(critic+'后续输入');await page.waitForTimeout(150);await page.locator('#submit').click()
  await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('请恢复增强编辑器或导出备份'))
  assert.equal(bodies.length,before);const durable=(await stored(page))[0]
  assert.equal(durable.after['a.md'],critic+'后续输入');assert.equal(durable.pending,undefined);assert.equal(durable.editorFiles?.['a.md'],undefined)
  evidence.push({case:'enhanced Critic fallback continued input',durable});checks.push('continued-fallback-critic-no-loss');await context.close()
 } else {
 const {page,context}=await open()
 await page.goto(origin+'/project/mock');await page.waitForTimeout(200);assert.equal(requests.length,0,'readonly must not fetch kit')
 await page.goto('about:blank');await page.goto(origin+'/project/mock#feedback=local-fixture-token');await page.waitForFunction(()=>!document.querySelector('#edit').disabled)
 assert.equal(requests.length,0,'token alone must not fetch kit')
 const readStyle=await page.locator('#document p').first().evaluate(el=>{const s=getComputedStyle(el);return {color:s.color,font:s.fontFamily,size:s.fontSize,line:s.lineHeight}})
 await page.locator('#edit').click();await page.locator('.ProseMirror').waitFor()
 assert.equal(requests.filter(p=>p.endsWith('.js')).length,1);assert.equal(requests.filter(p=>p.endsWith('.css')).length,1)
 const richStyle=await page.locator('.ProseMirror p').first().evaluate(el=>{const s=getComputedStyle(el);return {color:s.color,font:s.fontFamily,size:s.fontSize,line:s.lineHeight}})
 assert.deepEqual(richStyle,readStyle);evidence.push({theme:theme.themeId,readStyle,richStyle})
 await source(page,'第一句！\n\n第二句！\n');await page.waitForTimeout(450)
 await page.evaluate(async()=>{await window.realHandle.buildSubmission({});await window.realHandle.buildSubmission({})})
 assert.equal(await page.evaluate(()=>window.calls.submit),0);assert.equal((await stored(page))[0].pending,undefined)
 await page.getByRole('button',{name:'Rich',exact:true}).click();await page.getByRole('button',{name:'我的修改',exact:true}).click()
 assert.equal(await page.locator('aside[aria-label="我的修改"] button').count(),2)
 await page.locator('aside[aria-label="我的修改"] button').first().click()
 await page.waitForFunction(()=>window.live.after['a.md']==='第一句。\n\n第二句！\n')
 await page.getByRole('button',{name:'撤销',exact:true}).click();assert.equal(await raw(page),'第一句！\n\n第二句！\n')
 await page.getByRole('button',{name:'重做',exact:true}).click();assert.equal(await raw(page),'第一句。\n\n第二句！\n')
 await page.screenshot({path:resolve(output,'reader-changes.png'),fullPage:true})
 postStatus=503;postDelay=150
 await page.locator('#submit').dblclick();await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('结果未知'))
 assert.equal(bodies.length,1);assert.equal(JSON.parse(bodies[0]).edits[0].afterMarkdown,'第一句。\n\n第二句！\n')
 const calls=await page.evaluate(()=>({...window.calls,pending:window.pendingCommits}))
 assert.equal(calls.build,3);assert.equal(calls.submit,1);assert.equal(calls.pending,1)
 await source(page,'第一句。\n\n第二句！后续\n');await page.waitForTimeout(450)
 postStatus=200;await page.locator('#submit').click();await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('已送达'))
 assert.equal(bodies[1],bodies[0]);assert.equal(await page.evaluate(()=>window.calls.build),3)
 let durable=(await stored(page))[0];assert.equal(durable.after['a.md'],'第一句。\n\n第二句！后续\n');assert.equal(durable.pending,undefined)
 evidence.push({case:'503 exact retry and later input',durable,calls});checks.push('lazy-real-IIFE','two-hunks-revert-undo-redo','build-no-submit','double-click-single-flight','503-exact-retry','later-input-retained')
 await page.getByRole('button',{name:'Rich',exact:true}).click()
 await page.evaluate(()=>window.realHost.openFile('b.md'));await page.waitForFunction(()=>document.querySelector('.share-editor-toolbar span').textContent==='b.md')
 await page.screenshot({path:resolve(output,'reader-structure.png'),fullPage:true})
 const geometry=await page.evaluate(()=>({whiteSpace:getComputedStyle(document.querySelector('.ProseMirror')).whiteSpace,badge:getComputedStyle(document.querySelector('.note-badge'),'::before').content,anchor:getComputedStyle(document.querySelector('.moraya-note-anchor'),'::before').content,math:!!document.querySelector('.katex'),table:!!document.querySelector('.ProseMirror table')}))
 evidence.push({case:'structure',geometry});await writeFile(resolve(output,'structure.json'),JSON.stringify(geometry,null,2))
 violations.push(...await page.evaluate(()=>window.cspViolations));await context.close()
 // Fault injection below always executes the real hashed bytes where delivery succeeds.
 for(const failure of ['sri','404','timeout','api','mount']) {
  mode=['api','mount'].includes(failure)?'ok':failure
  const {page,context}=await open(failure),before=bodies.length,started=Date.now()
  await page.goto(origin+'/project/mock#feedback=local-fixture-token');await page.waitForFunction(()=>!document.querySelector('#edit').disabled)
  await page.locator('#edit').click();await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('增强编辑器不可用'),null,{timeout:18000})
  if(failure==='timeout')assert.ok(Date.now()-started>=15000)
  assert.equal(await page.locator('.ProseMirror').count(),0)
  assert.ok(await page.locator('#editor').isVisible())
  assert.equal(await page.locator('script[integrity],link[integrity]').count(),0)
  await page.locator('#editor').fill(base+'fallback '+failure)
  await page.locator('#submit').click();await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('已送达'))
  assert.equal(bodies.length,before+1);assert.equal(JSON.parse(bodies.at(-1)).client.kind,'browser-fallback')
  checks.push(failure+'-fallback-submit');evidence.push({case:failure,durable:await stored(page),elapsed:Date.now()-started})
  await context.close()
 }
 mode='ok';postDelay=0
 for(const failure of ['ordinary','pending','confirm']) {
  const {page,context}=await open(),before=bodies.length
  await enter(page);await source(page,'第一句！\n\n第二句。\n');await page.waitForTimeout(450)
  await page.evaluate(f=>window.fault=f,failure)
  await page.locator('#submit').click()
  await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('无法提交')||document.querySelector('#status').textContent.includes('结果未知'))
  assert.equal(bodies.length-before,failure==='confirm'?1:0)
  const retained=(await stored(page))[0]
  assert.equal(!!retained.pending,failure==='confirm')
  evidence.push({case:failure+' IDB failure',retained})
  if(failure==='confirm') {
   const frozen=retained.pending.body
   await page.reload();await page.waitForFunction(()=>!document.querySelector('#submit').disabled)
   await page.locator('#submit').click();await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('已送达'))
   assert.equal(bodies.at(-1),frozen);assert.equal(await page.evaluate(()=>window.calls.build),0)
  }
  checks.push(failure+'-IDB-boundary');await context.close()
 }
 // An interrupted response leaves the same exact pending for an explicit retry.
 {
  const {page,context}=await open();await enter(page);await source(page,base+'network')
  postStatus=0;await page.locator('#submit').click();await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('结果未知'))
  const frozen=(await stored(page))[0].pending.body
  postStatus=200;await page.locator('#submit').click();await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('已送达'))
  assert.equal(bodies.at(-1),frozen);checks.push('interrupted-response-exact-retry');await context.close()
 }
 // Switching files must not close the current owner after a failed save.
 {
  const {page,context}=await open();await enter(page);await source(page,base+'retained');await page.waitForTimeout(450)
  await page.evaluate(()=>window.fault='ordinary');await page.evaluate(()=>window.realHost.openFile('b.md'))
  await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('切换前保存失败'))
  assert.equal(await page.locator('.share-editor-toolbar span').innerText(),'a.md');assert.equal(await page.locator('.kit-source-ta').inputValue(),base+'retained')
  checks.push('switch-file-save-failure-retains-owner');await context.close()
 }
 // A changed live lineage during build cancels the newly built submission.
 {
  const {page,context}=await open();await enter(page);await source(page,base+'lineage');await page.waitForTimeout(450)
  const before=bodies.length
  await page.evaluate(()=>{const build=window.realHandle.buildSubmission;window.realHandle.buildSubmission=async(...a)=>{const result=await build(...a);window.live.snapshotId='changed-during-build';return result}})
  await page.locator('#submit').click();await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('本次提交已取消'))
  assert.equal(bodies.length,before);assert.equal((await stored(page))[0].pending,undefined);checks.push('lineage-build-cancel');await context.close()
 }
 // Keep accepting edits both after the built snapshot and during its frozen IDB transaction.
 for(const phase of ['build','freeze']) {
  const {page,context}=await open();await enter(page);await source(page,base+'B');await page.waitForTimeout(450)
  if(phase==='build') await page.evaluate(()=>{const build=window.realHandle.buildSubmission;window.realHandle.buildSubmission=async(...a)=>{const result=await build(...a);window.buildPaused=true;await new Promise(r=>window.releaseBuild=r);return result}})
  else await page.evaluate(()=>window.pausePending=true)
  await page.locator('#submit').click();await page.waitForFunction(phase=>phase==='build'?window.buildPaused:window.pendingPaused,phase)
  await page.locator('.kit-source-ta').fill(base+'C');await page.waitForFunction(()=>window.live.after['a.md'].endsWith('C'));await page.waitForTimeout(350)
  if(phase==='build')await page.evaluate(()=>window.releaseBuild());else await page.evaluate(()=>window.pausePending=false)
  await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('已送达'))
  const durable=(await stored(page))[0]
  assert.equal(durable.after['a.md'],base+'C');assert.equal(JSON.parse(bodies.at(-1)).edits[0].afterMarkdown,base+'B');assert.equal(durable.pending,undefined)
  evidence.push({case:phase+' concurrent after',durable,body:bodies.at(-1)});checks.push(phase+'-concurrent-after-preserved');await context.close()
 }
 // The reader's real frozen presentation owns fonts and colors in both appearances.
 for(const themeId of ['frozen-one','frozen-two']) for(const appearance of ['light','dark']) {
  const frozenTheme=themeId==='frozen-one'?theme:{themeId,compiledCss:'[data-theme="frozen-two"] .moraya-editor{color:rgb(63,32,51);font-family:Arial,sans-serif;font-size:17px;line-height:1.65}@media(prefers-color-scheme:dark){[data-theme="frozen-two"] .moraya-editor{color:rgb(230,202,219)}}'}
  html=buildProjectBundle(snapshot,origin+'/feedback/mock',{editorKit:descriptor,presentation:await renderProjectPresentation(snapshot,{frozenTheme})})
  const {page,context}=await open();await page.emulateMedia({colorScheme:appearance})
  await page.goto(origin+'/project/mock#feedback=local-fixture-token');await page.waitForFunction(()=>!document.querySelector('#edit').disabled)
  const before=await page.locator('#document p').first().evaluate(el=>{const s=getComputedStyle(el);return {color:s.color,font:s.fontFamily,size:s.fontSize,line:s.lineHeight}})
  await page.locator('#edit').click();await page.locator('.ProseMirror').waitFor()
  const after=await page.locator('.ProseMirror p').first().evaluate(el=>{const s=getComputedStyle(el);return {color:s.color,font:s.fontFamily,size:s.fontSize,line:s.lineHeight}})
  assert.deepEqual(after,before)
  await page.evaluate(()=>window.realHost.openFile('b.md'));await page.waitForFunction(()=>document.querySelector('.share-editor-toolbar span').textContent==='b.md')
  const fonts=await page.evaluate(async()=>{await document.fonts.load('19px KaTeX_Main');await document.fonts.ready;const c=document.createElement('canvas').getContext('2d');c.font='19px KaTeX_Main';const glyph=c.measureText('∑x²').width;c.font='19px monospace';return {faces:[...document.fonts].filter(f=>f.family==='KaTeX_Main').map(f=>({family:f.family,status:f.status})),glyph,fallback:c.measureText('∑x²').width,math:getComputedStyle(document.querySelector('.katex')).fontFamily,whiteSpace:getComputedStyle(document.querySelector('.ProseMirror')).whiteSpace,badge:getComputedStyle(document.querySelector('.note-badge'),'::before').content,checkbox:getComputedStyle(document.querySelector('[data-item-type=task]'),'::before').width,toolbar:getComputedStyle(document.querySelector('.code-block-toolbar')).position}})
  assert.ok(fonts.faces.some(f=>f.status==='loaded'));assert.notEqual(fonts.glyph,fonts.fallback);assert.match(fonts.math,/KaTeX/);assert.equal(fonts.whiteSpace,'pre-wrap');assert.match(fonts.badge,/※/);assert.ok(parseFloat(fonts.checkbox)>5);assert.equal(fonts.toolbar,'absolute')
  await page.locator('.moraya-note-anchor').click();assert.equal(await page.locator('.note-edit textarea').inputValue(),'point');await page.locator('.note-edit textarea').press('Enter')
  await page.evaluate(()=>{const node=document.querySelector('.ProseMirror p').firstChild,r=document.createRange();r.setStart(node,0);r.setEnd(node,4);const s=getSelection();s.removeAllRanges();s.addRange(r)})
  await page.waitForTimeout(80);await page.getByRole('button',{name:'批注',exact:true}).click();await page.locator('.note-edit textarea').fill('guest selection');await page.locator('.note-edit textarea').press('Enter')
  await page.waitForFunction(()=>window.live.after['b.md']?.includes('guest selection'))
  await source(page);assert.match(await page.locator('.kit-source-ta').inputValue(),/guest selection/);await page.getByRole('button',{name:'Rich',exact:true}).click()
  await page.locator('#file-toggle').click();await page.locator('[data-file="b.md"]').click({button:'right'});await page.locator('#download-file').hover()
  const hover=await page.locator('#download-file').evaluate(el=>({background:getComputedStyle(el).backgroundColor,color:getComputedStyle(el).color}))
  assert.equal(hover.color,'rgb(255, 255, 255)');assert.notEqual(hover.background,'rgba(0, 0, 0, 0)')
  await page.screenshot({path:resolve(output,themeId+'-'+appearance+'.png'),fullPage:true})
  evidence.push({theme:themeId,appearance,before,after,fonts,hover});violations.push(...await page.evaluate(()=>window.cspViolations));await context.close()
 }
 checks.push('two-frozen-themes-light-dark','katex-loaded-glyph-no-network-font','real-badge-and-selection-annotation','menu-global-hover')
 // Old pages with no descriptor remain fully self contained, even on Edit.
 html=buildProjectBundle(snapshot,origin+'/feedback/mock')
 {
  const {page,context}=await open(),count=requests.length
  await page.goto(origin+'/project/mock#feedback=local-fixture-token');await page.waitForFunction(()=>!document.querySelector('#edit').disabled);await page.locator('#edit').click();await page.waitForTimeout(100)
  assert.equal(requests.length,count);assert.ok(await page.locator('#editor').isVisible());await context.close();checks.push('no-descriptor-zero-kit')
 }
 assert.deepEqual(violations,[])
 assert.deepEqual(errors,[])
 assert.equal(network.filter(r=>r.type==='font'&&!r.url.startsWith('data:')).length,0)
 assert.equal(geometry.whiteSpace,'pre-wrap','actual editor soft/hard breaks require structural CSS')
 assert.match(geometry.badge,/※/,'actual owner badge must be visible')
 }
 console.log('actual reader lazy IIFE: PASS')
} finally {
 await writeFile(resolve(output,'browser.json'),JSON.stringify({manifest,requests,bodies,errors,violations,checks,network,evidence},null,2))
 await browser?.close();await server?.close();await rm(scratch,{recursive:true,force:true})
}
