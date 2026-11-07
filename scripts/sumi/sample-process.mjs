#!/usr/bin/env node
// Explicit PIDs: WebKit XPC workers may be parented to launchd, not the host.
// RSS includes shared pages and is not unique physical footprint. Never auto-sum.
import { execFileSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
const [list,seconds='60',output='/tmp/sumi-process-samples.json']=process.argv.slice(2)
if(!list||!/^[0-9]+(,[0-9]+)*$/.test(list))throw new Error('Usage: node scripts/sumi/sample-process.mjs hostPID,webContentPID,... [seconds] [output.json]')
const pids=list.split(',').map(Number),duration=Number(seconds)
if(!Number.isFinite(duration)||duration<1||duration>3600)throw new Error('seconds must be 1..3600')
const samples=[];const start=Date.now()
while(Date.now()-start<duration*1000){
 const text=execFileSync('ps',['-p',pids.join(','),'-o','pid=,ppid=,rss=,%cpu=,comm='],{encoding:'utf8'})
 samples.push({elapsed_ms:Date.now()-start,processes:text.trim().split('\n').filter(Boolean).map(line=>{const m=line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.+)$/);if(!m)throw new Error('ps format');return {pid:+m[1],ppid:+m[2],rss_kib:+m[3],ps_cpu_percent:+m[4],command:m[5]}})})
 await new Promise(resolve=>setTimeout(resolve,250))
}
await writeFile(output,JSON.stringify({scope:'Explicit selected host and WebKit PIDs; process RSS includes shared pages, ps %CPU is OS-defined average; unlisted workers excluded; not unique footprint',pids,sample_interval_ms:250,samples},null,2))
console.log(output)
