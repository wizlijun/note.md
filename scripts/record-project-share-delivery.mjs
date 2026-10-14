import { projectShareBrowserSource } from './project-share-browser.mjs'
// Actual ProjectStore -> production bundle/archive -> real local Worker -> Chromium
// -> original Worker envelope -> actual merge kernel -> ProjectStore apply -> receipt.
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir, mkdtemp, rm, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'vite'
import { Window } from 'happy-dom'
const root=process.cwd(), own=resolve('.superpowers/sdd/2026-10-14-project-share-browser-desktop-delivery')
const output=process.env.GATE_LOG_DIR, fixture=resolve(output,'fixture')
assert.ok(output && process.env.OWNER_TEST_BINARY)
const require=createRequire(import.meta.url), workerRequire=createRequire(await realpath(resolve('worker/node_modules/wrangler/package.json')))
const {Miniflare}=workerRequire('miniflare')
const {build}=createRequire(require.resolve('vite/package.json'))('esbuild')
const sha=v=>createHash('sha256').update(v).digest('hex')
const json=async p=>JSON.parse(await readFile(p,'utf8'))
const save=async(name,value)=>writeFile(resolve(output,name),JSON.stringify(value,null,2),{flag:'wx'})
let mf,server,browser, scratch, context, step=0
const operations=[],network=[],bodies=[],errors=[]
async function owner(op,args={}) {
 const index=++step, request={op,...args,output:`owner-${index}.json`}, path=resolve(fixture,`request-${index}.json`)
 await writeFile(path,JSON.stringify(request),{flag:'wx'})
 const argv=['--ignored','--exact','record_project_share_delivery','--nocapture'], started=new Date().toISOString()
 const run=spawnSync(process.env.OWNER_TEST_BINARY,argv,{cwd:root,env:{...process.env,NOTEMD_DELIVERY_ROOT:fixture,NOTEMD_DELIVERY_REQUEST:path},encoding:'utf8',timeout:120000})
 const record={argv:[process.env.OWNER_TEST_BINARY,...argv],cwd:root,started,ended:new Date().toISOString(),exit:run.status,stdout:run.stdout,stderr:run.stderr,error:run.error?.message,requestSha256:sha(await readFile(path))}
 await save(`owner-${index}-execution.json`,record);operations.push(record)
 assert.equal(run.status,0,`actual owner ${op}: ${run.stderr}\n${run.stdout}`)
 return json(resolve(fixture,request.output))
}
try {
 await mkdir(fixture);for(const p of ['vault','state','source/docs'])await mkdir(resolve(fixture,p),{recursive:true})
 await writeFile(resolve(fixture,'.notemd-delivery-fixture'),'synthetic-project-share-task8\n',{flag:'wx'})
 const initial='第一句。\n\n第二句。\n', note='# Second document\n\nUntouched raw.\n', png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7XcAAAAASUVORK5CYII=','base64')
 await writeFile(resolve(fixture,'source/README.md'),initial);await writeFile(resolve(fixture,'source/docs/note.md'),note);await writeFile(resolve(fixture,'source/pixel.png'),png);await writeFile(resolve(fixture,'source/unapproved.txt'),'not approved')
 scratch=await mkdtemp(resolve(tmpdir(),'notemd-task8-empty-'))
 server=await createServer({plugins:[projectShareBrowserSource()],root,configFile:false,envDir:scratch,logLevel:'error',optimizeDeps:{noDiscovery:true,include:[]},server:{middlewareMode:true}})
 const dom=new Window({url:'http://127.0.0.1/'});dom.document.write('<!doctype html><html><body></body></html>');Object.assign(globalThis,{window:dom,document:dom.document,DOMParser:dom.DOMParser,Node:dom.Node,HTMLElement:dom.HTMLElement})
 const {buildProjectBundle}=await server.ssrLoadModule('/src/lib/project-share/bundle.ts')
 const {buildProjectArchive}=await server.ssrLoadModule('/src/lib/project-share/archive.ts')
 const {createArtifactPlan,MULTIPART_BYTES}=await server.ssrLoadModule('/src/lib/project-share/multipart.ts')
 const {propose,compose,acceptUnconflicted}=await server.ssrLoadModule('/src/lib/share-merge/index.ts')
 const {buildProjectReceipt}=await server.ssrLoadModule('/src/lib/project-share/receipt.ts')
 const workerBuild=await build({entryPoints:[resolve('worker/src/index.ts')],bundle:true,format:'esm',platform:'browser',external:['node:*'],write:false,logLevel:'error'})
 await writeFile(resolve(output,'worker.mjs'),workerBuild.outputFiles[0].contents,{flag:'wx'})
 mf=new Miniflare({modules:true,script:workerBuild.outputFiles[0].text,compatibilityDate:'2024-12-30',compatibilityFlags:['nodejs_compat'],bindings:{SHARE_API_KEY:'task8-synthetic-owner'},kvNamespaces:['SHARES'],r2Buckets:['MEDIA'],durableObjects:{AUDIENCE:{className:'SlugAnalytics',useSQLite:true},AUDIENCE_DAY:{className:'DayRollup',useSQLite:true}},unsafeEphemeralDurableObjects:true,host:'127.0.0.1',port:0})
 const origin=(await mf.ready).origin,slug='2026-10-14-task8-local',url=origin+'/'+slug,feedbackUrl=origin+'/feedback/'+slug,editToken='a'.repeat(32),feedbackToken='task8-synthetic-guest'
 const auth={Authorization:'Bearer task8-synthetic-owner'}
 async function request(path,init={}) {
  const response=await fetch(origin+path,init),bytes=Buffer.from(await response.arrayBuffer())
  network.push({actor:'owner',path,method:init.method??'GET',status:response.status,requestSha256:init.body?sha(init.body):undefined,responseSha256:sha(bytes),bytes:bytes.length})
  assert.ok(response.ok,`${path}: ${response.status} ${bytes.toString().slice(0,1000)}`)
  return bytes
 }
 const manifest=await json(resolve('dist/share-editor-manifest.json'))
 const descriptor={apiVersion:1}
 for(const kind of ['js','css','mermaid']) {
  const asset=manifest[kind],bytes=await readFile(resolve('dist/assets',asset.name))
  assert.equal(sha(bytes),asset.sha256)
  await request('/_kit/'+asset.name,{method:'PUT',headers:auth,body:bytes})
  assert.deepEqual(await request('/_kit/'+asset.name),bytes)
  descriptor[kind]={url:origin+'/_kit/'+asset.name,integrity:asset.sri}
 }
 async function transfer(snapshot,artifacts,publicationId,previousPublicationId,phase) {
  const sessionId=publicationId+'-'+phase,plans=await Promise.all(artifacts.map(async a=>createArtifactPlan(a.name,a.bytes)))
  const common={edit_token:editToken,publicationId,sessionId}
  const op=(name,extra={})=>request(`/project/${slug}/upload/${name}`,{method:'POST',headers:{...auth,'Content-Type':'application/json'},body:JSON.stringify({...common,...extra})})
  await op('begin',{project_id:snapshot.project_id,feedback_token_hash:sha(feedbackToken),previousPublicationId,phase,snapshotId:snapshot.snapshotId,entry:snapshot.entry,title:'Task8 synthetic project',expires_in_seconds:3600,artifacts:plans,archiveFormat:'source'})
  for(const artifact of artifacts) {
   const plan=plans.find(p=>p.name===artifact.name),parts=[]
   for(const part of plan.parts) parts.push(JSON.parse((await request(`/project/${slug}/upload/part`,{method:'POST',headers:{...auth,'X-Edit-Token':editToken,'X-Publication-Id':publicationId,'X-Upload-Session':sessionId,'X-Artifact':artifact.name,'X-Part-Number':String(part.number)},body:artifact.bytes.slice((part.number-1)*MULTIPART_BYTES,(part.number-1)*MULTIPART_BYTES+part.bytes)})).toString()))
   await op('seal',{artifact:artifact.name,parts})
  }
  await op('commit')
 }
 async function publish(publicationId,previousPublicationId) {
  const entry=await owner('freeze',{paths:['README.md']})
  const options={editorKit:descriptor,archiveUrl:`${origin}/project/${slug}/download`}
  const entryHtml=buildProjectBundle(entry.snapshot,feedbackUrl,{...options,publicationPending:true})
  await writeFile(resolve(fixture,publicationId+'-entry.html'),entryHtml,{flag:'wx'});await owner('bundle',{snapshotId:entry.snapshot.snapshotId,htmlFile:publicationId+'-entry.html'})
  await transfer(entry.snapshot,[{name:'entry',bytes:Buffer.from(entryHtml)}],publicationId,previousPublicationId,'entry')
  const full=await owner('freeze',{paths:['README.md','docs/note.md','pixel.png']})
  const html=buildProjectBundle(full.snapshot,feedbackUrl,options),archive=await buildProjectArchive(full.snapshot,html,'source')
  await writeFile(resolve(output,publicationId+'-reader.html'),html,{flag:'wx'});await writeFile(resolve(output,publicationId+'-source.zip'),archive,{flag:'wx'})
  await writeFile(resolve(fixture,publicationId+'-reader.html'),html,{flag:'wx'});await owner('bundle',{snapshotId:full.snapshot.snapshotId,htmlFile:publicationId+'-reader.html'})
  await transfer(full.snapshot,[{name:'reader',bytes:Buffer.from(html)},{name:'archive',bytes:archive}],publicationId,previousPublicationId,'full')
  await owner('published',{snapshotId:full.snapshot.snapshotId,url})
  assert.deepEqual(await request(`/project/${slug}/download`),Buffer.from(archive))
  assert.deepEqual(await request('/'+slug),Buffer.from(html))
  return full
 }
 const s1=await publish('publication1',null)
 const playwright=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);browser=await playwright.chromium.launch({headless:true})
 context=await browser.newContext({viewport:{width:1200,height:850},acceptDownloads:true});const page=await context.newPage()
 page.on('pageerror',error=>errors.push(String(error)))
 page.on('request',r=>{network.push({actor:'browser',url:r.url(),method:r.method(),type:r.resourceType()});if(r.method()==='POST'&&r.url()===feedbackUrl)bodies.push(r.postDataBuffer())})
 await page.goto(url);await page.waitForTimeout(150)
 assert.equal(network.filter(x=>x.actor==='browser'&&x.url.includes('/_kit/')).length,0)
 await page.screenshot({path:resolve(output,'readonly.png'),fullPage:true})
 // Observe public handle only; original mount, state and storage remain in use.
 await page.addInitScript(()=>{let module;Object.defineProperty(window,'NotemdShareEditor',{configurable:true,get:()=>module,set:value=>{module=value;const mount=value.mount;value.mount=async(...args)=>{window.realHost=args[1];const handle=await mount(...args);window.realHandle=handle;return handle}}})})
 await page.goto('about:blank');await page.goto(url+'#feedback='+feedbackToken);await page.locator('#edit').click();await page.locator('.ProseMirror').waitFor()
 async function source(raw) {await page.getByRole('tab',{name:'源码',exact:true}).click();await page.locator('.kit-source-ta').fill(raw);await page.getByRole('tab',{name:'富文本',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.share-editor-modes [role=tab]').getAttribute('aria-selected')==='true');await page.evaluate(()=>window.realHandle.buildSubmission({}))}
 async function current() {return page.evaluate(async()=>{const draft=await window.realHost.loadDraft();return draft.after['README.md']})}
 const editingControls=[]
 for(const [label,pattern] of [['Table',/\|/],['Math formula',/\$\$/]]) {
  await source('/')
  await page.locator('.ProseMirror p').last().click();await page.keyboard.press('End');await page.keyboard.press('Backspace');await page.keyboard.type('/')
  await page.locator('.slash-menu').waitFor();const row=page.locator('.slash-menu .menu-row').filter({hasText:label});await row.hover()
  const hover=await row.evaluate(el=>({background:getComputedStyle(el).backgroundColor,color:getComputedStyle(el).color}))
  assert.equal(hover.color,'rgb(255, 255, 255)');await row.click()
  const raw=await current();assert.match(raw,pattern);editingControls.push({action:'slash '+label,raw,hover})
 }
 await source('Guest note target.\n')
 await page.evaluate(()=>{const node=document.querySelector('.ProseMirror p').firstChild,r=document.createRange();r.setStart(node,0);r.setEnd(node,5);const sel=getSelection();sel.removeAllRanges();sel.addRange(r)})
 await page.waitForTimeout(80);await page.getByRole('button',{name:'批注',exact:true}).click();await page.locator('.note-edit textarea').fill('task8 real annotation');await page.locator('.note-edit textarea').press('Enter')
 await page.waitForFunction(async()=> (await window.realHost.loadDraft()).after['README.md'].includes('task8 real annotation'))
 editingControls.push({action:'actual selection note popup',raw:await current()});await save('editing-controls.json',editingControls)
 await page.screenshot({path:resolve(output,'editing-controls-note.png'),fullPage:true})
 await source(initial)
 await source('第一句！\n\n第二句！\n');await page.getByRole('button',{name:'我的修改',exact:true}).click();assert.equal(await page.locator('aside[aria-label="我的修改"] button').count(),2)
 await page.locator('aside[aria-label="我的修改"] button').first().click();assert.equal(await current(),'第一句。\n\n第二句！\n')
 await page.screenshot({path:resolve(output,'one-hunk-reverted.png'),fullPage:true})
 await page.locator('#submit').click();await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('已送达'))
 assert.equal(bodies.length,1);await writeFile(resolve(output,'submission-http-body.json'),bodies[0],{flag:'wx'})
 const payload=JSON.parse(bodies[0]),bucket=await mf.getR2Bucket('MEDIA'),stored=await bucket.get(`feedback/${s1.info.project_id}/${payload.submissionId}.json`)
 assert.ok(stored);const envelopeBytes=Buffer.from(await stored.arrayBuffer()),envelope=JSON.parse(envelopeBytes)
 assert.equal(envelope.requestHash,sha(bodies[0]));assert.deepEqual(envelope.payload,payload)
 await writeFile(resolve(fixture,'worker-envelope.json'),envelopeBytes,{flag:'wx'})
 const ownerReview=await owner('review',{envelopeFile:'worker-envelope.json'}),review=ownerReview.review
 const proposal=propose({path:'README.md',base:review.base,ours:review.current,theirs:review.after}),decisions=acceptUnconflicted(proposal),result=compose(proposal,decisions)
 assert.equal(result.pendingConflicts.length,0);assert.equal(result.text,'第一句。\n\n第二句！\n')
 await save('actual-merge-producer.json',{proposal,decisions,result})
 const applied=await owner('apply',{submissionId:payload.submissionId,expectedHash:review.currentHash,content:result.text,summary:{accepted:result.accepted,total:result.total},draft:{kernel_version:1,ours_hash:proposal.oursHash,hunks:decisions,target:'worktree',updated_at:new Date().toISOString()}})
 const receipt=buildProjectReceipt(applied.feedback,new Date().toISOString());assert.equal(receipt.outcome,'accepted')
 const receiptBody=JSON.stringify(receipt);await writeFile(resolve(output,'receipt-body.json'),receiptBody,{flag:'wx'})
 await request(`/feedback/${slug}/receipt/${payload.submissionId}`,{method:'PUT',headers:{...auth,'Content-Type':'application/json'},body:receiptBody})
 const readReceipt=await request(`/feedback/${slug}/receipt/${payload.submissionId}`,{headers:{'X-Feedback-Token':feedbackToken}});assert.deepEqual(JSON.parse(readReceipt),receipt)
 await page.reload();await page.waitForFunction(()=>document.querySelector('#receipts').textContent.includes('已合入'))
 await page.screenshot({path:resolve(output,'receipt.png'),fullPage:true})
 await page.locator('#edit').click();await page.locator('.ProseMirror').waitFor();await source('第一句？\n\n第二句！\n')
 const s2=await publish('publication2','publication1');assert.notEqual(s2.snapshot.snapshotId,s1.snapshot.snapshotId)
 await page.reload();await page.waitForFunction(()=>document.querySelector('#old-drafts').textContent.includes('旧版本'))
 await page.getByRole('button',{name:'在新版本上继续',exact:true}).click();await page.locator('.rebase-panel').waitFor()
 await page.getByRole('button',{name:'取消',exact:true}).click();assert.equal(await current(),'第一句？\n\n第二句！\n')
 await page.getByRole('button',{name:'在新版本上继续',exact:true}).click();await page.getByRole('button',{name:'完成迁移',exact:true}).click();await page.locator('.rebase-panel').waitFor({state:'detached'})
 assert.equal(await page.evaluate(async()=>(await window.realHost.loadDraft()).snapshotId),s2.snapshot.snapshotId)
 await page.getByRole('button',{name:'撤销 rebase',exact:true}).click();for(let attempt=0;attempt<150;attempt++){if(await page.evaluate(async sid=>(await window.realHost.loadDraft()).snapshotId===sid,s1.snapshot.snapshotId))break;await page.waitForTimeout(20)};assert.equal(await page.evaluate(async()=>(await window.realHost.loadDraft()).snapshotId),s1.snapshot.snapshotId)
 await page.locator('#collaboration-options').evaluate(el=>el.open=true);const download=page.waitForEvent('download');await page.locator('#export').click();const exported=await download;const backup=await readFile(await exported.path());await writeFile(resolve(output,'exported-draft'+(exported.suggestedFilename().endsWith('.zip')?'.zip':'.json')),backup,{flag:'wx'})
 await page.screenshot({path:resolve(output,'rebase-undo-export.png'),fullPage:true})
 assert.equal(await readFile(resolve(fixture,'source/docs/note.md'),'utf8'),note);assert.deepEqual(await readFile(resolve(fixture,'source/pixel.png')),png)
 assert.deepEqual(errors,[])
 await save('chain-result.json',{s1:s1.snapshot.snapshotId,s2:s2.snapshot.snapshotId,manifest,workerSha256:sha(workerBuild.outputFiles[0].contents),submissionSha256:sha(bodies[0]),envelopeSha256:sha(envelopeBytes),receiptSha256:sha(receiptBody),exportSha256:sha(backup),sourceSha256:sha(await readFile(resolve(fixture,'source/README.md'))),unchangedNoteSha256:sha(note),unchangedAttachmentSha256:sha(png),browser:await browser.version(),checks:['actual ProjectStore approved freeze','real local Worker multipart publish','readonly no kit and anonymous exact ZIP','actual IIFE Rich/Source and individual hunk undo','original HTTP submission to Worker','actual merge propose/compose to actual owner review-save/apply','actual receipt projection and browser receipt','actual S2 publication and rebase cancel/finish/undo/export'],limits:['Rust owner methods are actual APIs, not native UI clicks','system IME and native deep-link are separate evidence']})
 console.log('PASS actual ProjectStore -> Worker -> browser -> owner apply -> receipt -> S2/rebase/export')
} finally {
 await save('network.json',network);await save('owner-operations.json',operations);await save('page-errors.json',errors)
 await context?.close();await browser?.close();await mf?.dispose();await server?.close();if(scratch)await rm(scratch,{recursive:true,force:true})
}
