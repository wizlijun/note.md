import './prelude'
import { hostCalls } from './prelude'
import { mount, unmount, tick } from 'svelte'
import { EditorState, TextSelection } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { schema } from 'prosemirror-schema-basic'
import RichEditor from '../../../src/components/RichEditor.svelte'
import { tabs, activeId, type Tab } from '../../../src/lib/tabs.svelte'
import { closeFileEditorSession } from '../../../src/lib/file-editor-sessions'
import '../../../src/styles/app.css'
import './style.css'

type Corpus = { markdown: string; markers: string[]; sha256: string; utf16_units: number; unicode_scalars: number; utf8_bytes: number; input_sequence: string[] }
type Mounted = { view: EditorView; destroy(): Promise<void> }
const asset = (name: string) => new URL(name, new URL('./', location.href)).href
const app = document.querySelector<HTMLElement>('#app')!
app.innerHTML = `<header><strong>Sumi 同机基准（隔离数据）</strong><select id="mode" aria-label="编辑器"><option value="rich">当前完整 RichEditor</option><option value="minimal">最小 ProseMirror</option></select><select id="size" aria-label="文档长度"><option>10000</option><option>100000</option></select><button id="load">加载语料</button><button id="run">标准 5 轮</button><button id="smoke">快速检查</button><button id="manual">记录真实输入事件</button><button id="save">保存报告</button></header><p id="status" role="status">加载字体与语料…</p><div id="editor"></div><pre id="summary"></pre>`
const status = document.querySelector<HTMLElement>('#status')!
const summary = document.querySelector<HTMLElement>('#summary')!
const holder = document.querySelector<HTMLElement>('#editor')!
const mode = document.querySelector<HTMLSelectElement>('#mode')!
const size = document.querySelector<HTMLSelectElement>('#size')!
let mounted: Mounted | undefined, fixture: Corpus, busy = false, trusted = false
let currentRepeat = -1
const reports: any[] = []
const mounts: any[] = []
const inputs: any[] = []
const frameGaps: any[] = []
let composition = false, lastFrame = 0, activeFrameProbe = false
const frame = () => new Promise<number>(resolve => requestAnimationFrame(() => resolve(performance.now())))
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
function stats(values: number[]) { if (!values.length) return null; const s = values.toSorted((a,b)=>a-b); const q=(p:number)=>s[Math.max(0,Math.ceil(s.length*p)-1)]; return { count:s.length,p50:q(.5),p95:q(.95),p99:q(.99),max:s.at(-1) } }
function frameProbe(now: number) { if (activeFrameProbe && lastFrame) frameGaps.push({ repeat: currentRepeat, ms: now-lastFrame }); lastFrame=now; requestAnimationFrame(frameProbe) }
requestAnimationFrame(frameProbe)
holder.addEventListener('compositionstart', () => { composition = true })
holder.addEventListener('compositionend', e => { composition = false; if (trusted && e.isTrusted) { const start=performance.now(); requestAnimationFrame(()=>inputs.push({metric:'compositionend_to_raf_opportunity_ms',ms:performance.now()-start,isTrusted:e.isTrusted})) } })
let beforeInput: number | undefined
holder.addEventListener('beforeinput',e=>{const event=e as InputEvent;beforeInput=trusted&&event.isTrusted&&!composition&&!event.isComposing?performance.now():undefined},true)
holder.addEventListener('input', e => {
  const event=e as InputEvent, before=beforeInput;beforeInput=undefined
  if (!trusted || !event.isTrusted || composition || event.isComposing) return
  const start=performance.now()
  requestAnimationFrame(()=>{const now=performance.now();inputs.push({metric:'input_to_raf_opportunity',input_handler_to_raf_ms:now-start,beforeinput_capture_to_raf_ms:before===undefined?null:now-before,input_event_timestamp_to_raf_ms:event.timeStamp>=0&&event.timeStamp<=now&&now-event.timeStamp<60000?now-event.timeStamp:null,inputType:event.inputType,isTrusted:event.isTrusted})})
},true)
function atMarker(view: EditorView, marker: string) {
  let found: number | undefined
  view.state.doc.descendants((node, pos) => { if (found !== undefined) return false; const at=node.isText ? node.text!.indexOf(marker) : -1; if(at>=0)found=pos+at; return true })
  if(found===undefined)throw new Error(`lost marker ${marker}`)
  return found
}
async function editor() {
  if (mounted) { await mounted.destroy(); mounted=undefined }
  holder.replaceChildren(); tabs.splice(0)
  const started=performance.now()
  if(mode.value==='minimal') {
    const doc=schema.node('doc',null,fixture.markdown.split('\n\n').map(text=>schema.node('paragraph',null,text ? schema.text(text) : undefined)))
    const view=new EditorView(holder,{state:EditorState.create({schema,doc})})
    mounted={view,async destroy(){view.destroy()}}
  } else {
    const id=`benchmark-${crypto.randomUUID()}`
    tabs.push({id,filePath:`/sumi-isolated/${id}.md`,title:'Sumi benchmark',currentContent:fixture.markdown,initialContent:fixture.markdown,mode:'rich',kind:'markdown',externalState:'fresh',externalBannerDismissed:false,lastKnownMtime:0,lastKnownHash:''} as Tab)
    activeId.value=id
    let component: ReturnType<typeof mount>
    const view=await Promise.race([new Promise<EditorView>(resolve=> { component=mount(RichEditor,{target:holder,props:{tab:tabs[0],fileBacked:true,onFileReady:(session:any)=>resolve(session.view)}}) }),delay(30000).then(()=>{throw new Error('RichEditor did not mount; inspect denied RPC/errors')})])
    mounted={view,async destroy(){await unmount(component);await closeFileEditorSession(id)}}
  }
  await tick(); await frame()
  for(const marker of fixture.markers)atMarker(mounted.view,marker)
  mounted.view.focus()
  return performance.now()-started
}
function insertion(index:number) {
  const view=mounted!.view, at=atMarker(view,fixture.markers[index%3]), text=fixture.input_sequence[index%fixture.input_sequence.length]
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc,at)).insertText(text).scrollIntoView())
}
async function load() {
  fixture=await fetch(asset(`corpus/${size.value}.json`)).then(r=>r.json())
  const ms=await editor(); mounts.push({mode:mode.value,utf16:fixture.utf16_units,corpus_sha256:fixture.sha256,ms,scope:'editor mount after fonts and harness JavaScript; not whole-app cold start'});status.textContent=`${mode.value} / ${fixture.utf16_units} UTF-16 / ${fixture.sha256.slice(0,12)} / 编辑器挂载 ${ms.toFixed(1)}ms`
}
function lock(value:boolean) { busy=value; document.querySelectorAll<HTMLButtonElement|HTMLSelectElement>('header button,header select').forEach(e=>e.disabled=value) }
async function run(repeats:number,warmup:number,samples:number) {
  if(busy)return; lock(true); trusted=false; activeFrameProbe=false
  try {
    fixture=await fetch(asset(`corpus/${size.value}.json`)).then(r=>r.json())
    for(let repeat=0;repeat<repeats;repeat++) {
      currentRepeat=repeat; const mountMs=await editor(); const originalText=mounted!.view.state.doc.textContent; const warmStarted=performance.now()
      for(let i=0;i<warmup;i++){insertion(i); if(i%25===24){status.textContent=`预热 ${repeat+1}/${repeats}: ${i+1}/${warmup}`;await frame()}}
      const warmMs=performance.now()-warmStarted
      const raw:any[]=[]; const gapStart=frameGaps.length; activeFrameProbe=true; lastFrame=0
      for(let i=0;i<samples;i++) {
        const start=performance.now(); insertion(warmup+i); const synchronous=performance.now()-start
        const raf=await frame(); raw.push({synchronous_dispatch_ms:synchronous,dispatch_to_raf_opportunity_ms:raf-start})
        status.textContent=`${mode.value} ${size.value}: 第 ${repeat+1}/${repeats} 轮 ${i+1}/${samples}`
        await delay(Math.max(0,100-(performance.now()-start)))
      }
      activeFrameProbe=false
      const doc=mounted!.view.state.doc; const plain=doc.textBetween(0,doc.content.size,'\n\n')
      // Every committed input must survive; paragraph separators are separately normalized.
      const inserted=warmup+samples
      const textGrowth=doc.textContent.length-originalText.length
      let expected=originalText;for(let i=0;i<inserted;i++)expected=expected.replace(fixture.markers[i%3],fixture.input_sequence[i%4]+fixture.markers[i%3])
      if(doc.textContent!==expected)throw new Error('exact final text differs from input sequence')
      const expectedGrowth=Array.from({length:inserted},(_,i)=>fixture.input_sequence[i%4].length).reduce((a,b)=>a+b,0)
      if(textGrowth!==expectedGrowth)throw new Error(`text growth mismatch ${textGrowth} != ${expectedGrowth}`)
      reports.push({mode:mode.value,mount_scope:'fresh editor in warm page/module/font cache; not SQLite page restore or app cold start',fixture:{...fixture,markdown:undefined},repeat,warmup,samples,mount_ms:mountMs,warmup_ms:warmMs,raw,synchronous_dispatch_ms:stats(raw.map(s=>s.synchronous_dispatch_ms)),dispatch_to_raf_opportunity_ms:stats(raw.map(s=>s.dispatch_to_raf_opportunity_ms)),frame_intervals_ms:stats(frameGaps.slice(gapStart).map(s=>s.ms)),final_text_sha256:await hash(plain),correctness:{exact_text:true,text_growth:textGrowth,expected_growth:expectedGrowth,markers_intact:fixture.markers.every(m=>plain.includes(m))},plugin_count:mounted!.view.state.plugins.length})
    }
    status.textContent='已完成。指标是程序化事务与 rAF 机会，不是物理键盘到屏幕延迟。'; renderReport()
  } catch(error) {status.textContent=String(error)} finally {activeFrameProbe=false;lock(false)}
}
async function hash(text:string) {return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(b=>b.toString(16).padStart(2,'0')).join('')}
function report() {return {schema:1,measurement_scope:'isolated production frontend or minimal PM; no disk/network; rAF is before paint, not physical input-to-photon',user_agent:navigator.userAgent,screen:{width:screen.width,height:screen.height,dpr:devicePixelRatio},viewport:{width:900,height:650,font_size:22,line_height:1.6},fonts:(window as any).sumiFonts,build:(window as any).sumiBuild,host_calls:hostCalls,editor_mounts:mounts,programmatic:reports,trusted_input_events:inputs,physical_input_to_frame_ms:null}}
function renderReport(){summary.textContent=JSON.stringify(report(),null,2)}
document.querySelector('#load')!.addEventListener('click',()=>{if(!busy){lock(true);load().catch(e=>status.textContent=String(e)).finally(()=>lock(false))}})
document.querySelector('#run')!.addEventListener('click',()=>void run(5,1000,100))
document.querySelector('#smoke')!.addEventListener('click',()=>void run(1,20,10))
document.querySelector('#manual')!.addEventListener('click',()=>{trusted=!trusted;status.textContent=trusted?'记录已开启；请在编辑器用相同系统输入法连续输入。该记录仍不是物理帧呈现证据。':'真实事件记录结束';mounted?.view.focus();renderReport()})
document.querySelector('#save')!.addEventListener('click',async()=>{
  try {
    renderReport();const content=JSON.stringify(report(),null,2)
    const bridge=(window as any).notemd
    if(bridge){
      const marker=await bridge.request('host.vault.read',{path:'.sumi-acceptance-vault'})
      if(marker?.content!=='sumi-acceptance-only\n')throw new Error('报告仅可写入标记过的隔离验收Vault')
      const path=`inbox/sumi-benchmark-results/web-${Date.now()}-${crypto.randomUUID()}.json`
      await bridge.request('host.vault.write',{path,content});status.textContent=`报告已保存：${path}`
    }else{
      const response=await fetch(asset('reports'),{method:'POST',headers:{'Content-Type':'application/json'},body:content});if(!response.ok)throw new Error(await response.text());status.textContent=await response.text()
    }
  }catch(error){status.textContent=String(error)}
})
;(window as any).sumiBenchmark={run,load,report}
async function boot(){
  lock(true)
  const fonts=await fetch(asset('fonts/manifest.json')).then(r=>r.json()); (window as any).sumiFonts=fonts
  ;(window as any).sumiBuild=await fetch(asset('identity.json')).then(r=>r.json())
  for(const [index,asset] of fonts.assets.filter((a:any)=>/\.(ttf|otf)$/.test(a.file)).entries()) {
    const data=await fetch(new URL(`fonts/${asset.file}`,new URL('./',location.href)).href).then(r=>r.arrayBuffer()); const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',data))].map(b=>b.toString(16).padStart(2,'0')).join('')
    if(digest!==asset.sha256)throw new Error(`font hash mismatch ${asset.file}`)
    const face=new FontFace(`SumiBench${index}`,data); await face.load();document.fonts.add(face)
  }
  await document.fonts.ready; await load();lock(false)
}
void boot().catch(e=>{status.textContent=String(e);lock(false)})
