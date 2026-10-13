import assert from 'node:assert/strict'
import {mkdirSync,writeFileSync,readFileSync,realpathSync} from 'node:fs'
import {resolve,relative} from 'node:path'
import {pathToFileURL} from 'node:url'
import {createHash} from 'node:crypto'
import {createServer} from 'vite'
const own=resolve('.superpowers/sdd/2026-10-14-file-bindings-history')
assert.equal(process.argv.slice(2).join(' '),'--case resize','unknown file editor browser case')
for(const name of ['FILE_PLAN_OWN','FILE_EDITOR_OUTPUT_DIR','FILE_EDITOR_CACHE_DIR','PLAYWRIGHT_MODULE'])assert.ok(process.env[name],`${name} required`)
assert.equal(resolve(process.env.FILE_PLAN_OWN),own)
const outputDir=resolve(process.env.FILE_EDITOR_OUTPUT_DIR),cacheDir=resolve(process.env.FILE_EDITOR_CACHE_DIR)
for(const dir of [outputDir,cacheDir])assert.ok(relative(own,dir)&&!relative(own,dir).startsWith('..'),'output must be inside current OWN')
mkdirSync(outputDir,{recursive:true});mkdirSync(cacheDir,{recursive:true})
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href)
const fixture=`<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/src/styles/app.css"><link rel="stylesheet" href="/src/styles/editor-base.css"><link rel="stylesheet" href="/src-tauri/resources/themes/default.css"><style>#editor{margin:40px;width:700px}.ProseMirror{min-height:300px}</style></head><body><div id="editor"></div><script type="module">
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
writeFileSync(resolve(outputDir,'resize-fixture.html'),fixture)
const output={case:'resize',environment:{node:process.version,playwright:process.env.PLAYWRIGHT_MODULE,core:realpathSync('node_modules/@moraya/core'),coreSha256:createHash('sha256').update(readFileSync('node_modules/@moraya/core/dist/index.js')).digest('hex')},pageErrors:[],cases:[],platformLimitations:['Synthetic Chromium mouse/pointer tests are not native iOS/Android touch or Safari/IME device acceptance.']}
const server=await createServer({root:process.cwd(),configFile:false,envDir:resolve(own,'empty-env'),cacheDir,resolve:{dedupe:['prosemirror-model','prosemirror-state','prosemirror-transform','prosemirror-view','prosemirror-history']},optimizeDeps:{include:['@moraya/core','@moraya/core/schema','@moraya/core/commands','@moraya/core/source-history','@moraya/core/plugins/session-table-view','prosemirror-model','prosemirror-state','prosemirror-transform','prosemirror-view','prosemirror-history','prosemirror-commands','prosemirror-schema-list']},server:{host:'127.0.0.1',port:0,hmr:false,watch:null},plugins:[{name:'file-resize-fixture',configureServer(vite){vite.middlewares.use('/__file_resize',async(_req,res,next)=>{try{res.setHeader('Content-Type','text/html; charset=utf-8');res.end(await vite.transformIndexHtml('/__file_resize',fixture))}catch(error){next(error)}})}}]})
let browser,page
try{
 await server.listen();browser=await chromium.launch({headless:true});output.environment.browser=browser.version();page=await browser.newPage({viewport:{width:1000,height:700}})
 page.on('pageerror',e=>output.pageErrors.push(e.stack??String(e)))
 await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__file_resize`);await page.waitForFunction(()=>window.ready)
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
 assert.deepEqual(output.pageErrors,[]);await page.screenshot({path:resolve(outputDir,'resize.png')});output.status='PASS';console.log('PASS: actual EditorView pointer resize, col DOM, native history and cancellation')
}catch(error){output.error=String(error);if(page)await page.screenshot({path:resolve(outputDir,'resize-failure.png')}).catch(()=>{});throw error}
finally{writeFileSync(resolve(outputDir,'resize-results.json'),JSON.stringify(output,null,2)+'\n');await browser?.close();await server.close()}
