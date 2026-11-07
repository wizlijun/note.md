// @vitest-environment jsdom
// Functional smoke only: jsdom has no real layout, fonts, paint or input latency.
import { afterEach, expect, it, vi } from 'vitest'
import { corpus } from './corpus.mjs'
// Real Tauri globals are read-only. Unit tests use the same isolated adapter as
// the benchmark-only Vite transform, without mutating the host-owned object.
vi.mock('@tauri-apps/api/core', async () => {
 const { isolatedInternals } = await import('./browser/prelude')
 return { ...isolatedInternals, isTauri: () => true }
})
const realInternals={metadata:{currentWindow:{label:'acceptance'},currentWebview:{label:'acceptance'}},invoke(){throw new Error('Real host IPC must never be called')}}
Object.defineProperty(window,'__TAURI_INTERNALS__',{value:realInternals,writable:false,configurable:true})
let running=true
vi.stubGlobal('requestAnimationFrame',(fn:FrameRequestCallback)=>setTimeout(()=>{if(running)fn(performance.now())},5))
vi.stubGlobal('cancelAnimationFrame',(id:number)=>clearTimeout(id))
vi.stubGlobal('ResizeObserver',class {observe(){}unobserve(){}disconnect(){}})
vi.stubGlobal('IntersectionObserver',class {observe(){}unobserve(){}disconnect(){}})
Object.defineProperty(document,'fonts',{configurable:true,value:{ready:Promise.resolve(),add(){},check(){return true}}})
Element.prototype.scrollIntoView=()=>{}
window.scrollBy=()=>{}
Range.prototype.getClientRects=()=>[] as unknown as DOMRectList
Range.prototype.getBoundingClientRect=()=>new DOMRect(0,0,900,30)
vi.stubGlobal('fetch',vi.fn(async(input:string)=>{
 const url=new URL(String(input),location.href)
 if(url.pathname.endsWith('/fonts/manifest.json'))return new Response(JSON.stringify({assets:[]}))
 if(url.pathname.endsWith('/identity.json'))return new Response(JSON.stringify({test:true,not_performance_evidence:true}))
 if(url.pathname.endsWith('/corpus/10000.json'))return new Response(JSON.stringify(corpus(10000)))
 throw new Error(`unexpected benchmark fetch ${input}`)
}))
afterEach(()=>{running=false;vi.unstubAllGlobals()})
it('mounts the actual full Rich frontend and minimal PM, inserts through each owner and never reports physical frame latency',async()=>{
 document.body.innerHTML='<main id="app"></main>'
 await import('./browser/main')
 expect((window as any).__TAURI_INTERNALS__).toBe(realInternals)
 await vi.waitFor(()=>expect(document.querySelector('#status')?.textContent).toContain('编辑器挂载'),{timeout:15000})
 expect(document.querySelector('.ProseMirror')).not.toBeNull()
 const api=(window as any).sumiBenchmark
 await api.run(1,2,2)
 let report=api.report()
 expect(report.programmatic).toHaveLength(1)
 expect(report.programmatic[0].correctness.exact_text).toBe(true)
 expect(report.programmatic[0].plugin_count).toBeGreaterThan(2)
 expect(report.physical_input_to_frame_ms).toBeNull()
 const select=document.querySelector<HTMLSelectElement>('#mode')!;select.value='minimal'
 await api.load();await api.run(1,2,2)
 report=api.report()
 expect(report.programmatic).toHaveLength(2)
 expect(report.programmatic[1].mode).toBe('minimal')
 expect(report.programmatic[1].correctness.exact_text).toBe(true)
 expect(report.programmatic[1].plugin_count).toBe(0)
 expect(report.trusted_input_events).toHaveLength(0)
},30000)
