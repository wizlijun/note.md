#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
const files=process.argv.slice(2)
if(!files.length)throw new Error('Usage: node scripts/sumi/summarize.mjs report.json ...')
const rows=[]
for(const file of files){
 const report=JSON.parse(await readFile(file,'utf8'))
 if(report.identity?.source_stable===false)throw new Error(`Source changed during measurement: ${file}`)
 for(const run of report.programmatic??report.repeats??[]){
  const fixture=run.fixture??report.fixture
  rows.push({file,mode:run.mode??report.mode,utf16:fixture.utf16_units,corpus_sha256:fixture.sha256,repeat:run.repeat,warmup:run.warmup,samples:run.samples,mount_ms:run.mount_ms,core_open_ms:run.core_open_ms??null,synchronous_p95_ms:(run.synchronous_dispatch_ms??run.insertText_return_ms)?.p95,render_opportunity_p95_ms:(run.dispatch_to_raf_opportunity_ms??run.insertText_plus_viewport_layout_ms)?.p95,render_metric:run.dispatch_to_raf_opportunity_ms?'dispatch_to_next_raf_before_paint':'hidden_AppKit_insertText_plus_viewport_layout',correctness:run.correctness,physical_input_to_frame_gate:'NOT_MEASURED',host_memory_gate:'NOT_MEASURED'})
 }
}
console.log(JSON.stringify({scope:'Proxy metrics only; do not use as physical input-to-frame acceptance',rows},null,2))
