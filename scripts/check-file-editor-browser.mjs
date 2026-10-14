import assert from 'node:assert/strict'
import {mkdirSync,writeFileSync,readFileSync,realpathSync} from 'node:fs'
import {resolve,relative} from 'node:path'
import {pathToFileURL} from 'node:url'
import {createHash} from 'node:crypto'
import {createServer} from 'vite'
import {svelte} from '@sveltejs/vite-plugin-svelte'
const own=resolve('.superpowers/sdd/2026-10-14-file-bindings-history')
const caseName=process.argv[3]
assert.equal(process.argv[2],'--case');assert.ok(['resize','mount'].includes(caseName),'unknown file editor browser case')
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
let mounted,allowed=true,changes=[],previous='',firstFrames=[],transactions=[]
window.test={
 async open(raw){if(mounted){await mounted.owner.close()}previous=raw;changes=[];firstFrames=[];transactions=[];allowed=true;
 mounted=await mountFileEditor(document.querySelector('#editor'),{file:{documentId:'browser.md',authority:crypto.randomUUID(),raw},
  adapters:{mediaResolver:new BrowserMediaResolver(),frontmatterViewFactory:{render(el,yaml){firstFrames.push(yaml);el.textContent=yaml;return {destroy(){}}}}},
  policy:{acceptRawChange:(a,b)=>a===b||allowed},onChange(value){const hunks=diff(previous.split(''),value.raw.split(''));changes.push({raw:value.raw,hunks});previous=value.raw}});
 const dispatch=mounted.view.props.dispatchTransaction;mounted.view.setProps({dispatchTransaction(tr){const before=mounted.owner.snapshot().generation;dispatch.call(mounted.view,tr);if(tr.docChanged)transactions.push({steps:tr.steps.map(step=>step.toJSON()),target:tr.doc.toJSON(),before,after:mounted.owner.snapshot().generation})}});
 return this.snapshot()},
 snapshot(){return {...mounted.owner.snapshot(),changes,firstFrames,transactions,undo:mounted.owner.canUndo(),selection:mounted.view.state.selection.toJSON(),storedMarks:mounted.view.state.storedMarks?.map(mark=>mark.toJSON()),active:document.activeElement?.outerHTML,pm:mounted.view.state.doc.toJSON(),dom:document.querySelector('.ProseMirror')?.innerHTML}},
 allow(value){allowed=value},undo:()=>mounted.owner.undo(),redo:()=>mounted.owner.redo(),mode:value=>mounted.setMode(value),flush:()=>mounted.owner.flush(),
 command:value=>mounted.owner.execute(value),
 baseline:raw=>mounted.owner.installBaseline({documentId:'browser.md',authority:crypto.randomUUID(),raw}),
}
document.querySelector('#source').onclick=()=>mounted.setMode('source')
document.querySelector('#rich').onclick=()=>mounted.setMode('rich')
document.querySelector('#save').onclick=async()=>{try{document.querySelector('#saved').textContent=(await mounted.owner.flush()).raw}catch{document.querySelector('#saved').textContent='pending'}}
await test.open('A');window.ready=true
</script></body></html>`
const fixture=caseName==='mount'?mountFixture:resizeFixture
writeFileSync(resolve(outputDir,`${caseName}-fixture.html`),fixture)
const output={case:caseName,environment:{node:process.version,playwright:process.env.PLAYWRIGHT_MODULE,core:realpathSync('node_modules/@moraya/core'),coreSha256:createHash('sha256').update(readFileSync('node_modules/@moraya/core/dist/index.js')).digest('hex')},pageErrors:[],console:[],cases:[],platformLimitations:['Synthetic Chromium mouse/pointer tests are not native iOS/Android touch or Safari/IME device acceptance.']}
const server=await createServer({root:process.cwd(),configFile:false,envDir:resolve(own,'empty-env'),cacheDir,resolve:{dedupe:['prosemirror-model','prosemirror-state','prosemirror-transform','prosemirror-view','prosemirror-history']},optimizeDeps:{include:['@moraya/core','@moraya/core/schema','@moraya/core/commands','@moraya/core/source-history','@moraya/core/plugins/session-table-view','prosemirror-model','prosemirror-state','prosemirror-transform','prosemirror-view','prosemirror-history','prosemirror-commands','prosemirror-schema-list']},server:{host:'127.0.0.1',port:0,hmr:false,watch:null},plugins:[...(caseName==='mount'?[svelte()]:[]),{name:'file-resize-fixture',configureServer(vite){vite.middlewares.use('/src/editor-kit-v2/editor-kit-v1.css',(_req,res)=>{res.statusCode=302;res.setHeader('Location','/src/editor-kit/kit.css');res.end()});vite.middlewares.use('/__file_resize',async(_req,res,next)=>{try{res.setHeader('Content-Type','text/html; charset=utf-8');res.end(await vite.transformIndexHtml('/__file_resize',fixture))}catch(error){next(error)}})}}]})
let browser,page
try{
 await server.listen();browser=await chromium.launch({headless:true});output.environment.browser=browser.version();page=await browser.newPage({viewport:{width:1000,height:700}})
 page.on('pageerror',e=>output.pageErrors.push(e.stack??String(e)));page.on('console',message=>output.console.push({type:message.type(),text:message.text()}))
 await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__file_resize`);await page.waitForFunction(()=>window.ready)
 if(caseName==='mount'){await checkMount(page,output,outputDir);output.status='PASS';console.log('PASS: actual mount/source/rich browser acceptance')}else{
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
