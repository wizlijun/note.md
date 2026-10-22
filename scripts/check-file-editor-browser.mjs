import assert from 'node:assert/strict'
import {mkdirSync,writeFileSync,readFileSync,realpathSync} from 'node:fs'
import {resolve,relative} from 'node:path'
import {pathToFileURL} from 'node:url'
import {createHash} from 'node:crypto'
import {createServer} from 'vite'
import {svelte} from '@sveltejs/vite-plugin-svelte'
const own=resolve('.superpowers/sdd/2026-10-14-file-bindings-history')
const caseName=process.argv[3]
assert.equal(process.argv[2],'--case');assert.ok(['resize','mount','recovery','image','cjk','checkbox'].includes(caseName),'unknown file editor browser case')
for(const name of ['FILE_PLAN_OWN','FILE_EDITOR_OUTPUT_DIR','FILE_EDITOR_CACHE_DIR','PLAYWRIGHT_MODULE'])assert.ok(process.env[name],`${name} required`)
assert.equal(resolve(process.env.FILE_PLAN_OWN),own)
const outputDir=resolve(process.env.FILE_EDITOR_OUTPUT_DIR),cacheDir=resolve(process.env.FILE_EDITOR_CACHE_DIR)
for(const dir of [outputDir,cacheDir])assert.ok(relative(own,dir)&&!relative(own,dir).startsWith('..'),'output must be inside current OWN')
mkdirSync(outputDir,{recursive:true});mkdirSync(cacheDir,{recursive:true})
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href)
const resizeFixture=`<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/src/styles/app.css"><link rel="stylesheet" href="/src/styles/editor-base.css"><link rel="stylesheet" href="/src-tauri/resources/themes/default.css"><style>#editor{margin:40px;width:700px}.ProseMirror{min-height:300px}</style></head><body><div id="editor"></div><script type="module">
import {EditorView} from 'prosemirror-view'
import {TextSelection} from 'prosemirror-state'
import {history,undoDepth,redoDepth} from 'prosemirror-history'
import {defaultSchema} from '@moraya/core/schema'
import {gfmTableCommand} from '@moraya/core/commands'
import {withBlockIdentitySchema} from '/src/editor-kit-v2/identity.ts'
import {createFileController} from '/src/editor-kit-v2/file-controller.ts'
import {createFileResize} from '/src/editor-kit-v2/file-resize.ts'
import {executeFileStructural} from '/src/editor-kit-v2/file-commands.ts'
let n=0,c;const resize=createFileResize(()=>c)
c=createFileController({raw:'| Alpha | Beta |\\n| --- | --- |\\n| Gamma | Delta |',authority:'browser',schema:withBlockIdentitySchema(defaultSchema),ids:{blockId:()=> 'b'+ ++n,lineage:()=> 's'+ ++n,tableId:()=> 't'+ ++n},plugins:[resize.plugin,history()]})
const view=new EditorView(document.querySelector('#editor'),{state:c.state,nodeViews:{table:resize.nodeView},attributes:{class:'moraya-editor',id:'write'},dispatchTransaction:tr=>c.dispatch(tr)})
c.bindView(view)
window.test={
 snapshot:()=>({raw:c.snapshot().raw,generation:c.snapshot().generation,selection:c.state.selection.toJSON(),undo:undoDepth(c.state),redo:redoDepth(c.state),layout:[...c.readLayout()],cols:[...view.dom.querySelectorAll('col')].map(x=>x.style.width),diagnostic:String(c.diagnostic)}),
 undo:()=>c.runHistory('undo',true),redo:()=>c.runHistory('redo',true),readonly:v=>c.setReadOnly(v),composing:v=>c.setComposing(v),
 command:kind=>gfmTableCommand({kind})(c.state,tr=>c.dispatch(tr)),
 select:()=>c.dispatch(c.state.tr.setSelection(TextSelection.create(c.state.doc,4))),
 type:()=>c.dispatch(c.state.tr.insertText('X',4)),
 remove:()=>executeFileStructural(c,{kind:'block.delete',blockId:c.snapshot().bindings[0].id},true),
 cancel:kind=>{const el=view.dom.querySelector('.column-resize-handle');if(el)el.dispatchEvent(new PointerEvent(kind,{pointerId:1,isPrimary:true,bubbles:true}))},
 close:()=>{c.bindView(null);view.destroy()},
};window.ready=true
</script></body></html>`
const mountFixture=`<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/src/styles/app.css"><link rel="stylesheet" href="/src-tauri/resources/themes/default.css"><style>body{margin:0}nav{height:45px;display:flex;gap:12px}#editor{margin:20px;width:750px;height:530px}.ProseMirror{min-height:350px;padding:15px}</style></head><body><nav><button id="source">Source</button><button id="rich">Rich</button><button id="save">Save</button><span id="saved"></span></nav><div id="editor"></div><script type="module">
import {mountFileEditor} from '/src/editor-kit-v2/main.ts'
import {BrowserMediaResolver} from '@moraya/core/adapters/browser-media-resolver'
import {diff} from '/src/lib/share-merge/diff.ts'
import {insertImageAtCursor,insertImageAtPos} from '/src/lib/attachment-insert.ts'
import {TextSelection,NodeSelection} from 'prosemirror-state'
import {closeHistory,undoDepth,redoDepth} from 'prosemirror-history'
const mediaResolver=new BrowserMediaResolver(),fallbackImage=mediaResolver.loadLocalImage.bind(mediaResolver)
mediaResolver.loadLocalImage=path=>path==='/__file_image.svg'?Promise.resolve(path):fallbackImage(path)
let mounted,allowed=true,changes=[],previous='',firstFrames=[],transactions=[]
window.test={
 async open(raw){if(mounted){await mounted.owner.close()}previous=raw;changes=[];firstFrames=[];transactions=[];allowed=true;
 mounted=await mountFileEditor(document.querySelector('#editor'),{file:{documentId:'browser.md',authority:crypto.randomUUID(),raw},
  adapters:{mediaResolver,frontmatterViewFactory:{render(el,yaml){firstFrames.push(yaml);el.textContent=yaml;return {destroy(){}}}}},
  policy:{acceptRawChange:(a,b)=>a===b||allowed},onChange(value){const hunks=diff(previous.split(''),value.raw.split(''));changes.push({raw:value.raw,hunks});previous=value.raw}});
 const dispatch=mounted.view.props.dispatchTransaction;mounted.view.setProps({dispatchTransaction(tr){const before=mounted.owner.snapshot().generation;dispatch.call(mounted.view,tr);if(tr.docChanged)transactions.push({steps:tr.steps.map(step=>step.toJSON()),target:tr.doc.toJSON(),before,after:mounted.owner.snapshot().generation})}});
 return this.snapshot()},
 snapshot(){return {...mounted.owner.snapshot(),changes,firstFrames,transactions,undoDepth:undoDepth(mounted.view.state),redoDepth:redoDepth(mounted.view.state),undo:mounted.owner.canUndo(),selection:mounted.view.state.selection.toJSON(),storedMarks:mounted.view.state.storedMarks?.map(mark=>mark.toJSON()),active:document.activeElement?.outerHTML,pm:mounted.view.state.doc.toJSON(),dom:document.querySelector('.ProseMirror')?.innerHTML}},
 allow(value){allowed=value},undo:()=>mounted.owner.undo(),redo:()=>mounted.owner.redo(),mode:value=>mounted.setMode(value),flush:()=>mounted.owner.flush(),
 command:value=>mounted.owner.execute(value),
 select:(from,to=from)=>mounted.view.dispatch(mounted.view.state.tr.setSelection(TextSelection.create(mounted.view.state.doc,from,to))),
 image:(src,pos)=>pos===undefined?insertImageAtCursor(mounted.view,src):insertImageAtPos(mounted.view,src,pos),
 resize:(pos,title)=>mounted.view.dispatch(mounted.view.state.tr.setNodeMarkup(pos,undefined,{...mounted.view.state.doc.nodeAt(pos).attrs,title})),
 nodeSelect:pos=>{mounted.view.dispatch(mounted.view.state.tr.setSelection(NodeSelection.create(mounted.view.state.doc,pos)));mounted.view.focus()},
 separate:()=>mounted.view.dispatch(closeHistory(mounted.view.state.tr)),
 readonly:value=>mounted.owner.setReadOnly(value),
 stored:kind=>{mounted.view.dispatch(mounted.view.state.tr.setStoredMarks(kind?[mounted.view.state.schema.marks[kind].create()]:[]));mounted.view.focus()},
 baseline:raw=>mounted.owner.installBaseline({documentId:'browser.md',authority:crypto.randomUUID(),raw}),
}
document.querySelector('#source').onclick=()=>mounted.setMode('source')
document.querySelector('#rich').onclick=()=>mounted.setMode('rich')
document.querySelector('#save').onclick=async()=>{try{document.querySelector('#saved').textContent=(await mounted.owner.flush()).raw}catch{document.querySelector('#saved').textContent='pending'}}
await test.open('A');window.ready=true
</script></body></html>`
const recoveryFixture=`<!doctype html><html><head><meta charset="utf-8"><style>#editor{height:450px;width:700px;margin:20px}.ProseMirror{min-height:250px}</style></head><body><input id="search"><div id="editor"></div><script type="module">
import {createShareFileSession} from '/src/share-editor/file-session.ts'
import {BrowserMediaResolver} from '@moraya/core/adapters/browser-media-resolver'
import {routeFileHistory,observeFileHistoryRoute} from '/src/lib/file-history-focus.ts'
let session,durable,release,route;let live={v:2,lineageId:'browser',snapshotId:'S',base:{},after:{},annotationKinds:{}}
observeFileHistoryRoute(value=>route=value)
window.test={
 async open(){session=await createShareFileSession({path:'a.md',snapshotId:'S',raw:'Alpha',draft:live,policy:{acceptRawChange:()=>true},adapters:{mediaResolver:new BrowserMediaResolver()},mountTarget:document.querySelector('#editor'),saveDraft:async d=>{const clone=structuredClone(d);if(this.hold)await new Promise(r=>release=r);durable=clone;return clone}})},
 snapshot(){return {...session.mounted.owner.snapshot(),saved:session.saved(),route,live:structuredClone(live),durable}},
 mode:mode=>session.mounted.setMode(mode),undo:()=>routeFileHistory('undo'),redo:()=>routeFileHistory('redo'),
 save(){this.pending=session.save();return true},async finish(){release();await this.pending},
 async reopen(){await session.mounted.owner.close();live=structuredClone(durable);await this.open()},
 async close(){await session.close()},hold:false
};await test.open();window.ready=true
</script></body></html>`
const fixture=caseName==='recovery'?recoveryFixture:['mount','image','cjk','checkbox'].includes(caseName)?mountFixture:resizeFixture
writeFileSync(resolve(outputDir,`${caseName}-fixture.html`),fixture)
const output={case:caseName,environment:{node:process.version,playwright:process.env.PLAYWRIGHT_MODULE,core:realpathSync('node_modules/@moraya/core'),coreSha256:createHash('sha256').update(readFileSync('node_modules/@moraya/core/dist/index.js')).digest('hex')},pageErrors:[],console:[],cases:[],platformLimitations:['Synthetic Chromium mouse/pointer tests are not native iOS/Android touch or Safari/IME device acceptance.']}
const server=await createServer({root:process.cwd(),configFile:false,envDir:resolve(own,'empty-env'),cacheDir,resolve:{dedupe:['prosemirror-model','prosemirror-state','prosemirror-transform','prosemirror-view','prosemirror-history']},optimizeDeps:{include:['@moraya/core','@moraya/core/schema','@moraya/core/commands','@moraya/core/source-history','@moraya/core/plugins/session-table-view','prosemirror-model','prosemirror-state','prosemirror-transform','prosemirror-view','prosemirror-history','prosemirror-commands','prosemirror-schema-list']},server:{host:'127.0.0.1',port:0,hmr:false,watch:null},plugins:[...(caseName!=='resize'?[svelte()]:[]),{name:'file-resize-fixture',configureServer(vite){vite.middlewares.use('/__file_image.svg',(_req,res)=>{res.setHeader('Content-Type','image/svg+xml');res.end('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="#5370d4"/></svg>')});vite.middlewares.use('/src/editor-kit-v2/editor-kit-v1.css',(_req,res)=>{res.statusCode=302;res.setHeader('Location','/src/editor-kit/kit.css');res.end()});vite.middlewares.use('/__file_resize',async(_req,res,next)=>{try{res.setHeader('Content-Type','text/html; charset=utf-8');res.end(await vite.transformIndexHtml('/__file_resize',fixture))}catch(error){next(error)}})}}]})
let browser,page
try{
 await server.listen();browser=await chromium.launch({headless:true});output.environment.browser=browser.version();page=await browser.newPage({viewport:{width:1000,height:700}})
 page.on('pageerror',e=>output.pageErrors.push(e.stack??String(e)));page.on('console',message=>output.console.push({type:message.type(),text:message.text()}))
 await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__file_resize`);await page.waitForFunction(()=>window.ready)
 if(caseName==='checkbox'){await checkCheckbox(page,output,outputDir);output.status='PASS';console.log('PASS: checkbox actual mouse/source/history')}else if(caseName==='cjk'){await checkCjk(page,output,outputDir);output.status='PASS';console.log('PASS: CJK strong rendering, actual keyboard edits, source/save and history')}else if(caseName==='image'){await checkImage(page,output,outputDir);output.status='PASS';console.log('PASS: actual image helper/controller/history browser acceptance')}else if(caseName==='recovery'){await checkRecovery(page,output);output.status='PASS';console.log('PASS: actual recovery/save/focus browser acceptance')}else if(caseName==='mount'){await checkMount(page,output,outputDir);output.status='PASS';console.log('PASS: actual mount/source/rich browser acceptance')}else{
 const snapshot=()=>page.evaluate(()=>test.snapshot())
 const drag=async(column,dx,finish=true)=>{
  const box=await page.locator('.column-resize-handle').nth(column).boundingBox();assert.ok(box,'real handle rectangle')
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2+dx,box.y+box.height/2,{steps:8});if(finish)await page.mouse.up()
 }
 await page.evaluate(()=>test.select());const before=await snapshot()
 await drag(0,45);const first=await snapshot();assert.equal(first.undo,1);assert.equal(first.raw,before.raw);assert.deepEqual(first.selection,before.selection);assert.ok(parseFloat(first.cols[0])>=25);assert.notEqual(first.cols[0],'')
 await drag(1,35);const second=await snapshot();assert.equal(second.undo,2);assert.ok(parseFloat(second.cols[1])>=25)
 assert.equal(await page.evaluate(()=>test.undo()),true);assert.deepEqual((await snapshot()).cols,first.cols)
 assert.equal(await page.evaluate(()=>test.redo()),true);assert.deepEqual((await snapshot()).cols,second.cols)
 output.cases.push({name:'two real mouse drags and undo redo',before,first,second})
 for(const reason of ['escape','pointercancel','lostpointercapture','readonly','composing','blur']){
  const start=await snapshot();await drag(0,25,false)
  if(reason==='escape')await page.keyboard.press('Escape')
  else if(reason==='readonly')await page.evaluate(()=>test.readonly(true))
  else if(reason==='composing')await page.evaluate(()=>test.composing(true))
  else if(reason==='blur')await page.evaluate(()=>window.dispatchEvent(new Event('blur')))
  else await page.evaluate(kind=>test.cancel(kind),reason)
  await page.mouse.up();await page.evaluate(()=>{test.readonly(false);test.composing(false)})
  const after=await snapshot();assert.deepEqual(after,start,`cancel ${reason}`);output.cases.push({name:reason,after})
 }
 const start=await snapshot();await drag(0,25,false);await page.evaluate(()=>test.type());const typed=await snapshot();await page.mouse.up();assert.deepEqual(await snapshot(),typed);assert.equal(typed.undo,start.undo+1);assert.notEqual(typed.raw,start.raw);assert.deepEqual(typed.cols,start.cols)
 await page.evaluate(()=>test.undo());await page.evaluate(()=>test.select());assert.equal(await page.evaluate(()=>test.command('add-column')),true)
 const added=await snapshot();assert.equal(added.cols.length,3);assert.deepEqual(added.layout[0][1].widths,[second.layout[0][1].widths[0],null,second.layout[0][1].widths[1]])
 assert.equal(await page.evaluate(()=>test.command('delete-column')),true);assert.equal((await snapshot()).cols.length,2)
 assert.equal(await page.evaluate(()=>test.remove()),true);assert.equal((await snapshot()).cols.length,0)
 assert.equal(await page.evaluate(()=>test.undo()),true);assert.equal((await snapshot()).cols.length,2)
 output.cases.push({name:'input cancels gesture and real table column/delete history',added,after:await snapshot()})
 // Drag ordinary cell text, outside the 5px handles: native selection remains active.
 const cells=page.locator('th'),a=await cells.nth(0).boundingBox(),b=await cells.nth(1).boundingBox();assert.ok(a&&b)
 await page.mouse.move(a.x+10,a.y+a.height/2);await page.mouse.down();await page.mouse.move(b.x+b.width/2,b.y+b.height/2,{steps:10});await page.mouse.up()
 const selected=await page.evaluate(()=>getSelection()?.toString());assert.ok(selected?.length,'native cross-cell text selection')
 const touchAction=await page.locator('.column-resize-handle').first().evaluate(el=>getComputedStyle(el).touchAction);assert.equal(touchAction,'none')
 output.cases.push({name:'handle exterior preserves native selection',selected,touchAction})
 assert.deepEqual(output.pageErrors,[]);await page.screenshot({path:resolve(outputDir,'resize.png')});output.status='PASS';console.log('PASS: actual EditorView pointer resize, col DOM, native history and cancellation')}
}catch(error){output.error=String(error);if(page)await page.screenshot({path:resolve(outputDir,`${caseName}-failure.png`)}).catch(()=>{});throw error}
finally{writeFileSync(resolve(outputDir,`${caseName}-results.json`),JSON.stringify(output,null,2)+'\n');await browser?.close();await server.close()}

async function checkMount(page,output,outputDir){
 const snapshot=()=>page.evaluate(()=>test.snapshot())
 const rich=page.locator('.ProseMirror'),source=page.locator('.kit-source-ta')
 await page.waitForFunction(()=>[...document.styleSheets].some(sheet=>sheet.href?.endsWith('/src/editor-kit-v2/editor-kit-v1.css')))
 assert.equal(await page.locator('link[href$="editor-kit-v1.css"]').count(),1)
 for(const raw of ['\ufeff---\r\ntitle: Hello\r\n---\r\n\r\nBody\r\n','---\r\n---\r\n','\ufeffA\r\nkeep\nA\rTail 😀']){
  await page.evaluate(raw=>test.open(raw),raw);const initial=await snapshot()
  for(let i=0;i<3;i++){await page.click('#source');await source.waitFor({state:'visible'});assert.equal(await source.evaluate(el=>getComputedStyle(el).position),'absolute');assert.ok((await source.boundingBox()).height>200);assert.equal(await source.inputValue(),raw.replace(/\r\n?/g,'\n'));await page.click('#rich');await rich.waitFor({state:'visible'})}
  await page.click('#save');assert.equal(await page.locator('#saved').textContent(),raw)
  const after=await snapshot();assert.equal(after.raw,raw);assert.equal(after.generation,0);assert.equal(after.undo,false);assert.deepEqual(after.changes,[])
  if(raw.includes('---'))assert.deepEqual(initial.firstFrames,[raw.includes('title')?'title: Hello':''])
  output.cases.push({name:'first frame and three no-op switches',initial,after})
 }
 await page.click('#source');await source.focus();await source.press('ControlOrMeta+Home');await source.press('ArrowRight');await page.keyboard.type('Z')
 let one=await snapshot();assert.equal(one.raw,'\ufeffZA\r\nkeep\nA\rTail 😀');assert.equal(one.changes.at(-1).hunks.length,1)
 await source.press('ControlOrMeta+z');assert.equal((await snapshot()).raw,'\ufeffA\r\nkeep\nA\rTail 😀')
 await source.fill('\ufeffZ\nkeep\nZ\nTail 😀');assert.equal((await snapshot()).raw,'\ufeffZ\r\nkeep\nZ\rTail 😀')
 await source.press('ControlOrMeta+End');await source.press('Enter');await page.keyboard.insertText('新😀');assert.equal((await snapshot()).raw,'\ufeffZ\r\nkeep\nZ\rTail 😀\r\n新😀')
 await source.press('Backspace');await source.press('Backspace');await source.press('Backspace');assert.equal((await snapshot()).raw,'\ufeffZ\r\nkeep\nZ\rTail 😀')
 output.cases.push({name:'display coordinates, single hunk, disjoint EOL and emoji/newline edits',one,after:await snapshot()})
 await page.evaluate(()=>test.allow(false));await source.press('ControlOrMeta+End');await page.keyboard.type('draft');await page.click('#save');assert.equal(await page.locator('#saved').textContent(),'pending');await page.click('#rich');await source.waitFor({state:'visible'})
 assert.ok((await source.inputValue()).endsWith('draft'));await page.getByRole('button',{name:'Discard unsaved changes',exact:true}).click();await page.evaluate(()=>test.allow(true));await page.click('#rich');await rich.waitFor({state:'visible'})
 output.cases.push({name:'rejected visible source draft, flush blocks switch, explicit discard',after:await snapshot()})
 for(const [kind,marker] of [['bold','**'],['italic','*']]){
  await page.evaluate(()=>test.open(''));await rich.click();assert.equal(await page.evaluate(kind=>test.command({kind}),kind),true)
  assert.equal((await snapshot()).raw,'');await page.keyboard.type('Alpha');await rich.press(kind==='bold'?'ControlOrMeta+b':'ControlOrMeta+i');await page.keyboard.type('!')
  const after=await snapshot();assert.equal(after.raw,marker+'Alpha'+marker+'!');assert.ok(!after.raw.includes('\u200b'))
  await page.click('#source');assert.equal(await source.inputValue(),after.raw);await page.click('#rich');await rich.click();await rich.press('ControlOrMeta+z');assert.notEqual((await snapshot()).raw,after.raw);await rich.press('ControlOrMeta+Shift+z');assert.equal((await snapshot()).raw,after.raw)
  output.cases.push({name:'empty '+kind+' stored mark, continued typing, Source and native undo',after})
 }
 await page.evaluate(()=>test.open(''));await rich.click();const typing=[];for(const key of '**bold**!'){await page.keyboard.type(key);typing.push({key,...await snapshot()})}output.cases.push({name:'typing trace',typing});await page.click('#save');let formatted=await snapshot();assert.equal(formatted.raw,'**bold!**');await rich.focus();await rich.press('ControlOrMeta+b');output.cases.push({name:'strong exit before x',after:await snapshot()});await page.keyboard.type('x');output.cases.push({name:'strong exit diagnostic',after:await snapshot()});assert.equal((await snapshot()).raw,'**bold!**&#120;');await page.click('#source');assert.equal(await source.inputValue(),'**bold!**&#120;');await page.click('#rich');assert.ok(!formatted.raw.includes('\u200b'))
 output.cases.push({name:'real inline InputRules and continued typing',after:formatted})
 await page.evaluate(()=>test.open('| Alpha | Beta |\n| --- | --- |\n| Gamma | Delta |'));const tableBefore=await snapshot()
 const handle=await page.locator('.column-resize-handle').first().boundingBox();assert.ok(handle)
 const columns=()=>page.locator('.ProseMirror col').evaluateAll(cols=>cols.map(col=>col.style.width)),widthsBefore=await columns()
 await page.mouse.move(handle.x+handle.width/2,handle.y+handle.height/2);await page.mouse.down();await page.mouse.move(handle.x+handle.width/2+45,handle.y+handle.height/2,{steps:8});await page.mouse.up()
 const tableAfter=await snapshot(),widthsAfter=await columns();assert.equal(tableAfter.raw,tableBefore.raw);assert.equal(tableAfter.undo,true);assert.notDeepEqual(widthsAfter,widthsBefore)
 assert.equal(await page.evaluate(()=>test.undo()),true);assert.deepEqual(await columns(),widthsBefore);assert.equal((await snapshot()).raw,tableBefore.raw)
 assert.equal(await page.evaluate(()=>test.redo()),true);assert.deepEqual(await columns(),widthsAfter);assert.equal((await snapshot()).raw,tableBefore.raw)
 output.cases.push({name:'public mount real table handle and owner layout undo redo',before:tableBefore,after:tableAfter,widthsBefore,widthsAfter})
 // Exercise the public factory with real Chromium pointer capture and DOM text input.
 // Composition events are synthetic; this is not a system IME acceptance test.
 await page.evaluate(()=>test.open('| Alpha | Beta |\n| --- | --- |\n| Gamma | Delta |'))
 await page.evaluate(()=>test.select(4));await rich.focus()
 const compositionBefore=await snapshot(),compositionWidths=await columns()
 const pendingHandle=await page.locator('.column-resize-handle').first().boundingBox();assert.ok(pendingHandle)
 await page.mouse.move(pendingHandle.x+pendingHandle.width/2,pendingHandle.y+pendingHandle.height/2);await page.mouse.down()
 await page.mouse.move(pendingHandle.x+pendingHandle.width/2+35,pendingHandle.y+pendingHandle.height/2,{steps:4})
 assert.notDeepEqual(await columns(),compositionWidths);assert.equal((await snapshot()).generation,compositionBefore.generation)
 await rich.evaluate(el=>el.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true})))
 assert.deepEqual(await columns(),compositionWidths);assert.equal(await page.locator('.column-resize-handle').count(),0)
 await page.mouse.move(pendingHandle.x+80,pendingHandle.y+pendingHandle.height/2);await page.mouse.up()
 assert.equal((await snapshot()).generation,compositionBefore.generation);assert.equal((await snapshot()).undoDepth,0)
 await page.keyboard.insertText('中');assert.equal((await snapshot()).raw,compositionBefore.raw.replace('Alpha','中Alpha'))
 const endWindow=await rich.evaluate(async el=>{
  let resolved=false;const flush=test.flush().then(value=>{resolved=true;return value});await Promise.resolve()
  const pending=!resolved
  el.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}))
  const blocked=el.querySelectorAll('.column-resize-handle').length===0&&!resolved
  el.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,isPrimary:true,button:0,pointerId:1,clientX:300}))
  return {pending,blocked,flushed:await flush}
 })
 assert.equal(endWindow.pending,true);assert.equal(endWindow.blocked,true);assert.equal(endWindow.flushed.raw,compositionBefore.raw.replace('Alpha','中Alpha'))
 assert.equal(await page.locator('.column-resize-handle').count(),4);assert.equal((await snapshot()).undoDepth,1)
 assert.equal(await page.evaluate(()=>test.undo()),true);assert.equal((await snapshot()).raw,compositionBefore.raw)
 assert.equal(await page.evaluate(()=>test.redo()),true)
 const resumedHandle=await page.locator('.column-resize-handle').first().boundingBox();assert.ok(resumedHandle)
 await page.mouse.move(resumedHandle.x+resumedHandle.width/2,resumedHandle.y+resumedHandle.height/2);await page.mouse.down()
 await page.mouse.move(resumedHandle.x+resumedHandle.width/2+25,resumedHandle.y+resumedHandle.height/2,{steps:4});await page.mouse.up()
 assert.notDeepEqual(await columns(),compositionWidths);assert.equal((await snapshot()).undoDepth,2)
 assert.equal(await page.evaluate(()=>test.undo()),true);assert.deepEqual(await columns(),compositionWidths)
 assert.equal((await snapshot()).raw,endWindow.flushed.raw)
 output.cases.push({name:'public factory synthetic Rich composition cancels real pointer preview, blocks tail commit, admits text/flush/history and resumes resize',before:compositionBefore,endWindow,after:await snapshot()})
 for(const initial of ['[link](https://example.com)\n','']){
  await page.evaluate(raw=>test.open(raw),initial);await rich.click()
  if(!initial)assert.equal(await page.evaluate(()=>test.command({kind:'link',href:'https://example.com',text:'link'})),true)
  await rich.focus();await rich.press('ControlOrMeta+End');const before=await snapshot();await page.keyboard.type('!');await page.click('#save');const link=await snapshot()
  assert.equal(link.raw,'[link](https://example.com)!'+(initial?'\n':''));assert.ok(link.generation>before.generation);assert.ok(link.changes.length>before.changes.length)
  assert.equal(link.pm.content[0].content[0].text,'link');assert.equal(link.pm.content[0].content[0].marks[0].type,'link');assert.equal(link.pm.content[0].content[0].marks[0].attrs.href,'https://example.com');assert.equal(link.pm.content[0].content[1].text,'!');assert.ok(!link.pm.content[0].content[1].marks?.length)
  assert.equal(await page.locator('#saved').textContent(),link.raw);assert.ok(!link.raw.includes('\u200b'));assert.ok(!link.raw.includes('\\['))
  await page.click('#source');assert.equal(await source.inputValue(),link.raw);await page.click('#rich');await rich.focus();await rich.press('ControlOrMeta+z');assert.notEqual((await snapshot()).raw,link.raw);await rich.press('ControlOrMeta+Shift+z');assert.equal((await snapshot()).raw,link.raw)
  output.cases.push({name:initial?'existing link continued input':'public link command complete label and continued input',before,after:link})
 }
 assert.deepEqual(output.pageErrors,[]);await page.screenshot({path:resolve(outputDir,'mount.png')})
}

async function checkRecovery(page,output){
 const snapshot=()=>page.evaluate(()=>test.snapshot())
 await page.evaluate(()=>test.mode('source'));const source=page.locator('textarea');await source.fill('Beta')
 await page.waitForFunction(()=>test.snapshot().raw==='Beta')
 await page.evaluate(()=>{test.hold=true;test.save()});await page.waitForFunction(()=>test.pending!==undefined)
 await source.fill('Gamma');await page.evaluate(()=>test.finish())
 let value=await snapshot();assert.equal(value.raw,'Gamma');assert.equal(value.saved.generation,1);assert.equal(value.durable.after['a.md'],'Beta');assert.equal(value.live.after['a.md'],'Gamma')
 await page.evaluate(async()=>{test.hold=false;test.save();await test.pending})
 const saved=await snapshot();assert.equal(saved.saved.hash,saved.sourceHash)
 await source.focus();await page.keyboard.press('Home');await page.keyboard.down('Shift');await page.keyboard.press('ArrowRight');await page.keyboard.press('ArrowRight');await page.keyboard.up('Shift')
 await page.evaluate(()=>document.activeElement.blur());assert.equal(await page.evaluate(()=>test.undo()),true)
 assert.deepEqual(await source.evaluate(el=>[el.selectionStart,el.selectionEnd]),[0,2]);assert.equal((await snapshot()).raw,'Alpha')
 assert.equal(await page.evaluate(()=>test.redo()),true);await source.focus();await page.keyboard.press('ControlOrMeta+z');assert.equal((await snapshot()).raw,'Alpha');assert.deepEqual(await source.evaluate(el=>[el.selectionStart,el.selectionEnd]),[0,2]);await page.keyboard.press('ControlOrMeta+Shift+z');assert.equal((await snapshot()).raw,'Gamma')
 await page.evaluate(()=>test.reopen());value=await snapshot();assert.equal(value.raw,'Gamma');assert.deepEqual(value.bindings,saved.bindings);assert.equal(value.generation,0)
 await page.locator('.ProseMirror').click();await page.keyboard.press('End');await page.keyboard.type('X')
 await page.waitForFunction(()=>test.snapshot().raw==='GammaX')
 await page.evaluate(()=>document.activeElement.blur());assert.equal(await page.evaluate(()=>test.undo()),true);assert.equal((await snapshot()).raw,'Gamma')
 assert.equal(await page.evaluate(()=>test.redo()),true);assert.equal((await snapshot()).raw,'GammaX')
 await page.locator('#search').focus();assert.equal(await page.evaluate(()=>test.undo()),false);assert.equal((await snapshot()).route.active,false)
 await page.evaluate(()=>test.close());assert.equal(await page.locator('.ProseMirror').count(),0)
 output.cases.push({name:'real source input B/C exact durable, restored first frame bindings, native-route focus and close',saved,value})
 assert.deepEqual(output.pageErrors,[])
}

async function checkImage(page,output,dir){
 const snapshot=()=>page.evaluate(()=>test.snapshot()),raw='__Keep__ AB\r\n',src='/__file_image.svg'
 await page.evaluate(raw=>test.open(raw),raw);const before=await snapshot()
 await page.evaluate(src=>{test.select(6,8);test.image(src)},src)
 await page.waitForFunction(()=>document.querySelector('.image-node img')?.naturalWidth===120);const rendered=await page.locator('.image-node img').evaluate(img=>({src:img.src,width:img.naturalWidth,height:img.naturalHeight,displayWidth:img.getBoundingClientRect().width}));assert.equal(rendered.height,60);assert.ok(rendered.displayWidth>0);output.cases.push({name:'test media adapter loads actual local SVG response (not native Tauri IO)',rendered})
 const inserted=await snapshot();assert.equal(inserted.raw,'__Keep__ ![]('+src+')\r\n');assert.equal(inserted.undoDepth,1)
 await page.evaluate(()=>{test.separate();test.resize(6,'width=50%')})
 const resized=await snapshot();assert.equal(resized.raw,'__Keep__ ![]('+src+' "width=50%")\r\n');assert.equal(resized.undoDepth,2)
 await page.evaluate(()=>{test.separate();test.nodeSelect(6)})
 await page.keyboard.press('Backspace');const deleted=await snapshot();assert.equal(deleted.raw,'__Keep__&#32;\r\n');assert.equal(deleted.undoDepth,3)
 for(const expected of [resized.raw,inserted.raw,raw]){assert.equal(await page.evaluate(()=>test.undo()),true);assert.equal((await snapshot()).raw,expected)}
 for(const expected of [inserted.raw,resized.raw,deleted.raw]){assert.equal(await page.evaluate(()=>test.redo()),true);assert.equal((await snapshot()).raw,expected)}
 await page.click('#source');await page.waitForSelector('textarea');assert.equal(await page.locator('textarea').inputValue(),'__Keep__&#32;\n')
 await page.click('#save');assert.equal(await page.locator('#saved').textContent(),deleted.raw)
 await page.click('#rich');await page.waitForSelector('.ProseMirror:visible');const saved=await snapshot();assert.equal(saved.undoDepth,3);assert.deepEqual(saved.bindings,before.bindings)
 output.cases.push({name:'actual helper insert / setNodeMarkup resize / keyboard delete / independent undo redo / Source save',before,inserted,resized,deleted,saved})
 await page.evaluate(()=>test.readonly(true));await page.evaluate(src=>test.image(src),src);assert.equal((await snapshot()).generation,saved.generation);await page.evaluate(()=>test.readonly(false));await page.evaluate(()=>test.allow(false));await page.evaluate(src=>test.image(src),src);assert.equal((await snapshot()).generation,saved.generation)
 await page.evaluate(()=>test.allow(true));await page.evaluate(src=>test.image(src,6),src);assert.equal((await snapshot()).raw,'__Keep__&#32;![]('+src+')\r\n')
 await page.screenshot({path:resolve(dir,'image-history.png')});assert.deepEqual(output.pageErrors,[])
 output.cases.push({name:'readonly and policy zero-write followed by legal pos helper',snapshot:await snapshot()})
 for(const kind of ['strong','em']){
  const wrapper=kind==='strong'?'**':'*';await page.evaluate(()=>test.open('AB'));await page.evaluate(kind=>{test.select(1);test.stored(kind)},kind);await page.evaluate(src=>test.image(src),src)
  const inserted=wrapper+'![]('+src+')'+wrapper+'&#65;B';assert.equal((await snapshot()).raw,inserted)
  await page.evaluate(()=>{test.separate();test.stored(null)});await page.keyboard.press('End');await page.waitForFunction(()=>test.snapshot().selection.anchor===4);await page.keyboard.press('ArrowLeft');await page.keyboard.press('ArrowLeft');await page.waitForFunction(()=>test.snapshot().selection.anchor===2);await page.evaluate(()=>test.stored(null));assert.deepEqual((await snapshot()).storedMarks,[]);await page.keyboard.insertText('中𐐀')
  const typed=wrapper+'![]('+src+')'+wrapper+'&#20013;𐐀&#65;B';assert.equal((await snapshot()).raw,typed);assert.equal((await snapshot()).undoDepth,2)
  for(const expected of [inserted,'AB']){assert.equal(await page.evaluate(()=>test.undo()),true);assert.equal((await snapshot()).raw,expected)}
  for(const expected of [inserted,typed]){assert.equal(await page.evaluate(()=>test.redo()),true);assert.equal((await snapshot()).raw,expected)}
  output.cases.push({name:kind+' image helper and native text input endpoint history',snapshot:await snapshot()})
 }
 assert.deepEqual(output.pageErrors,[])

}

async function checkCjk(page,output,outputDir){
 const sentence='用户怎么用 Tower.md，我们预测不了；人脑在哪里会出错，我们预测得了。',tail='所以核心不预设任何场景，',raw='**'+sentence+'**'+tail
 const rich=page.locator('.ProseMirror'),source=page.locator('.kit-source-ta'),snapshot=()=>page.evaluate(()=>test.snapshot())
 const verifySaved=async expected=>{
  await page.click('#save');assert.equal(await page.locator('#saved').textContent(),expected)
  await page.click('#source');assert.equal(await source.inputValue(),expected)
  await page.click('#rich');await rich.waitFor({state:'visible'});assert.equal((await snapshot()).raw,expected)
 }
 await page.evaluate(raw=>test.open(raw),raw)
 assert.equal(await rich.locator('strong').innerText(),sentence)
 assert.equal((await snapshot()).pm.content[0].content[1].text,tail)
 assert.equal((await snapshot()).generation,0)
 assert.equal(await rich.locator('strong').evaluate(el=>Number(getComputedStyle(el).fontWeight)>=600),true)
 await page.screenshot({path:resolve(outputDir,'cjk-strong.png')})
 await verifySaved(raw)
 for(const operation of ['delete punctuation','insert space','insert bold space','remove strong']){
  await page.evaluate(raw=>test.open(raw),raw)
  const end=1+sentence.length
  if(operation==='remove strong'){
   await page.evaluate(end=>test.select(1,end),end);await rich.focus();await rich.press('ControlOrMeta+b')
  }else{
   await page.evaluate(end=>test.select(end),end);await rich.focus()
   if(operation==='delete punctuation')await page.keyboard.press('Backspace')
   else{if(operation==='insert space')await page.evaluate(()=>test.stored(null));await page.keyboard.type(' ')}
  }
  const expected=operation==='delete punctuation'?raw.replace('。',''):operation==='insert space'?raw.replace('**所以','** 所以'):operation==='insert bold space'?raw.replace('。**所','。&#32;**&#25152;'):sentence+tail
  const after=await snapshot();assert.equal(after.raw,expected);assert.ok(after.generation>0);assert.equal(after.changes.at(-1).raw,expected)
  await verifySaved(expected)
  await rich.focus();await rich.press('ControlOrMeta+z');assert.equal((await snapshot()).raw,raw)
  await rich.press('ControlOrMeta+Shift+z');assert.equal((await snapshot()).raw,expected)
  await page.evaluate(raw=>test.open(raw),expected);assert.equal((await snapshot()).raw,expected)
  output.cases.push({name:operation,after})
 }
 // The same production owner and keyboard path for every supported delimiter.
 for(const [marker,mark,command,tag] of [['**','strong','bold','strong'],['__','strong','bold','strong'],['*','em','italic','em'],['_','em','italic','em'],['~~','strike_through','strikethrough','del'],['==','highlight','highlight','mark'],['^^','highlight','highlight','mark']]){
  for(const operation of ['insert inside space','insert outside space','delete punctuation','replace with space','delete first word','delete last word','remove formatting']){
   const body=operation.includes('word')?'甲 乙':'重点。',raw=marker+body+marker+'后文',end=1+body.length
   await page.evaluate(raw=>test.open(raw),raw)
   assert.equal(await rich.locator(tag).innerText(),body)
   if(mark==='em')assert.equal(await rich.locator(tag).evaluate(el=>getComputedStyle(el).fontStyle),'italic')
   if(mark==='strike_through')assert.ok((await rich.locator(tag).evaluate(el=>getComputedStyle(el).textDecorationLine)).includes('line-through'))
   if(mark==='highlight')assert.notEqual(await rich.locator(tag).evaluate(el=>getComputedStyle(el).backgroundColor),'rgba(0, 0, 0, 0)')
   let text=body+'后文'
   if(operation==='remove formatting'){
    await page.evaluate(end=>test.select(1,end),end);assert.equal(await page.evaluate(kind=>test.command({kind}),command),true)
   }else if(operation==='delete first word'){
    await page.evaluate(()=>test.select(1,2));await rich.focus();await page.keyboard.press('Backspace');text=body.slice(1)+'后文'
   }else if(operation==='delete last word'||operation==='delete punctuation'){
    await page.evaluate(end=>test.select(end),end);await rich.focus();await page.keyboard.press('Backspace');text=body.slice(0,-1)+'后文'
   }else{
    await page.evaluate(({end,replace})=>test.select(replace?end-1:end,end),{end,replace:operation==='replace with space'});await rich.focus()
    if(operation==='insert outside space')await page.evaluate(()=>test.stored(null))
    await page.keyboard.type(' ');text=(operation==='replace with space'?body.slice(0,-1):body)+' 后文'
   }
   const after=await snapshot();assert.ok(after.generation>0,marker+' '+operation);assert.equal(after.changes.at(-1).raw,after.raw)
   assert.equal(after.pm.content[0].content.map(n=>n.text??'').join(''),text)
   if(operation==='remove formatting'){assert.equal(await rich.locator(tag).count(),0);assert.equal(after.raw,body+'后文')}
   else assert.ok(after.pm.content[0].content.some(n=>n.marks?.some(m=>m.type===mark)))
   await verifySaved(after.raw);await rich.focus();await rich.press('ControlOrMeta+z');assert.equal((await snapshot()).raw,raw)
   await rich.press('ControlOrMeta+Shift+z');assert.equal((await snapshot()).raw,after.raw)
   await page.evaluate(raw=>test.open(raw),after.raw);assert.equal((await snapshot()).raw,after.raw)
   output.cases.push({name:marker+' '+operation,after})
  }
 }
 await page.evaluate(raw=>test.open(raw),['**','__','*','_','~~','==','^^'].map(marker=>'前'+marker+'“重点。”'+marker+'后').join('\n\n'))
 await page.screenshot({path:resolve(outputDir,'cjk-all-formats.png')})
 // Invalid markers remain ordinary editable text; remove each visible star by
 // a real Backspace, with each case starting from the same untouched source.
 const literal='**重点。 **后'
 for(const offset of [0,1,literal.indexOf('**',2),literal.indexOf('**',2)+1]){
  await page.evaluate(raw=>test.open(raw),literal);assert.equal(await rich.locator('strong').count(),0)
  await page.evaluate(at=>test.select(at),offset+2);await rich.focus();await page.keyboard.press('Backspace')
  const after=await snapshot();assert.equal(after.pm.content[0].content.map(n=>n.text??'').join(''),literal.slice(0,offset)+literal.slice(offset+1));assert.ok(after.generation>0)
  await verifySaved(after.raw);await rich.focus();await rich.press('ControlOrMeta+z');assert.equal((await snapshot()).raw,literal)
  output.cases.push({name:'delete literal star '+offset,after})
 }
 assert.deepEqual(output.pageErrors,[])
}

async function checkCheckbox(page,output,outputDir){
 const snapshot=()=>page.evaluate(()=>test.snapshot())
 const fixtures=[
  ['simple','- [ ] buy milk\n',0],
  ['consecutive-footnotes','- [ ] A\n\n[^a]: note\n[^b]: note\n',0],
  ['unused-reference','- [ ] task\n\n[id]: /target\n',0],
  ['reference','- [ ] [reference][id]\n\n[id]: /target "title"\n',0],
  ['footnote','Summary[^source]\n\n- [ ] __中文任务。__\n  - Detail\n\n[^source]: Evidence.\n',0],
  ['table','- [ ] task\n\n  | A | B |\n  | - | - |\n  | C | D |\n',0],
  ['nested','- [ ] parent\n  + [ ] __child__\n  + [X] sibling\n\n[id]: /target\n',1],
  ['ordered','3) [ ] __ordered__\n4) ordinary\n',0],
  ['crlf','\uFEFF> + [ ] __中文__ &amp; \\*\r\n>   continuation\r\n\r\n[id]: /target\r\n',0],
  ['checked','- [X] __already checked__\r\n',0],
  ['empty','- [ ]\n',0],
 ]
 // Use both real bundled themes; keep their font CDN requests outside this test.
 await page.route('https://**/*',route=>route.request().resourceType()==='stylesheet'?route.fulfill({status:200,contentType:'text/css',body:''}):route.abort())
 const markerClick=async(index=0,button='left')=>{
  const li=page.locator('li[data-item-type="task"]').nth(index);await li.scrollIntoViewIfNeeded()
  const point=await li.evaluate(el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el,'::before');return {x:r.left+parseFloat(s.left)+parseFloat(s.width)/2,y:r.top+parseFloat(s.top)+parseFloat(s.height)/2}})
  await page.mouse.click(point.x,point.y,{button})
 }
 for(const theme of ['default','effie'])for(const scheme of ['light','dark']){
  await page.emulateMedia({colorScheme:scheme})
  await page.evaluate(async theme=>{let link=document.querySelector('#checkbox-theme');if(!link){link=document.createElement('link');link.id='checkbox-theme';link.rel='stylesheet';document.head.append(link)}const href='/src-tauri/resources/themes/'+theme+'.css';if(link.getAttribute('href')===href)return;await new Promise((resolve,reject)=>{link.onload=resolve;link.onerror=reject;link.href=href})},theme)
  for(const [name,raw,index] of fixtures){
   await page.evaluate(raw=>test.open(raw),raw)
   const checked=name==='checked',changed=index?raw.replace('[ ] __child__','[x] __child__'):raw.replace(/\[[ xX]\]/,checked?'[ ]':'[x]')
   await markerClick(index);const after=await snapshot();assert.equal(after.raw,changed,`${theme}/${scheme}/${name}`);assert.equal(after.undoDepth,1);assert.equal(after.changes.length,1)
   const li=page.locator('li[data-item-type="task"]').nth(index);assert.equal(await li.getAttribute('data-checked'),String(!checked))
   await page.locator('#source').click();assert.equal(await page.locator('textarea').inputValue(),changed.replace(/\r\n?/g,'\n'))
   await page.locator('#save').click();await page.waitForFunction(expected=>document.querySelector('#saved').textContent===expected,changed)
   await page.locator('#rich').click();await page.locator('.ProseMirror').focus();await page.keyboard.press('ControlOrMeta+z');assert.equal((await snapshot()).raw,raw)
   await page.keyboard.press('ControlOrMeta+Shift+z');assert.equal((await snapshot()).raw,changed)
   await page.evaluate(()=>test.separate());await markerClick(index);assert.equal((await snapshot()).undoDepth,2)
   assert.equal(await page.evaluate(()=>test.undo()),true);assert.equal((await snapshot()).raw,changed)
   await page.evaluate(raw=>test.open(raw),changed);assert.equal(await page.locator('li[data-item-type="task"]').nth(index).getAttribute('data-checked'),String(!checked))
   output.cases.push({name:`${theme}/${scheme}/${name}`,raw:changed,changes:after.changes,undoDepth:after.undoDepth})
  }
  await page.evaluate(()=>test.open('# Task review\n\n- [ ] __中文任务。__\n  + [ ] child\n  + [X] checked sibling\n\n[^a]: First note.\n[^b]: Second note.\n'));await markerClick();assert.equal((await snapshot()).raw.includes('- [x] __中文任务。__'),true)
  await page.screenshot({path:resolve(outputDir,`checkbox-${theme}-${scheme}.png`)})
 }
 const raw='- [ ] __task__\n\n[id]: /target\n';await page.evaluate(raw=>test.open(raw),raw)
 const textBox=await page.locator('li > p').first().boundingBox();await page.mouse.click(textBox.x+40,textBox.y+10);assert.equal((await snapshot()).raw,raw)
 await markerClick(0,'right');assert.equal((await snapshot()).raw,raw);await page.keyboard.press('Escape')
 await page.evaluate(()=>test.readonly(true));await markerClick();assert.equal((await snapshot()).raw,raw)
 await page.evaluate(()=>{test.readonly(false);test.allow(false)});await markerClick();assert.equal((await snapshot()).raw,raw);assert.equal((await snapshot()).undoDepth,0)
 await page.evaluate(()=>test.allow(true));await markerClick();assert.equal((await snapshot()).raw,raw.replace('[ ]','[x]'))
 await page.setViewportSize({width:390,height:700});await page.addStyleTag({content:'#editor{width:auto;margin:12px}'});await page.evaluate(raw=>test.open(raw),raw);await markerClick();assert.equal((await snapshot()).raw,raw.replace('[ ]','[x]'))
 await page.screenshot({path:resolve(outputDir,'checkbox-narrow.png')});output.cases.push({name:'text/right-click/readonly/policy/retry/narrow',passed:true});assert.deepEqual(output.pageErrors,[])
}
