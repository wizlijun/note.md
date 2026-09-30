#!/usr/bin/env node
// Real macOS WKWebView + plugin:// + production bridge/CSP/terrain Worker.
// All RPC data is synthetic. Does not start note.md or touch its settings/Vault.
import { cp, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
if (process.platform !== 'darwin') throw new Error('Native WebKit check requires macOS')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const output = await mkdtemp(join(tmpdir(), 'strata-webkit-worker-'))
const source = join(output, 'input'), served = join(output, 'served')
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', ...options })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}`)
}
console.log(`Native WebKit Worker artifacts: ${output}`)
run('pnpm', ['--filter', 'strata-plugin', 'build'])
await cp(join(root, 'plugins-src/strata/dist'), source, { recursive: true })
const worker = (await readdir(join(source, 'assets'))).find(name => /^terrain\.worker-.*\.js$/.test(name))
if (!worker) throw new Error('Production module Worker artifact missing')
const require = createRequire(import.meta.resolve('vite'))
await require('esbuild').build({ entryPoints: [join(root, 'plugins-src/strata/src/lib/terrain-renderer.ts')], bundle: true, platform: 'browser', format: 'esm', outfile: join(source, 'renderer-check.js') })
await writeFile(join(source, 'index.html'), '<!doctype html><meta charset="utf-8"><title>STRATA isolated WebKit Worker QA</title><h1>STRATA plugin:// module Worker</h1><pre id="report">Running with production CSP and bridge…</pre><script type="module" src="./probe.js"></script>')
await writeFile(join(source, 'probe.js'), `
import { createTerrain3D } from './renderer-check.js';
const report = document.getElementById('report');
const emit = value => {report.textContent += '\\n' + JSON.stringify(value); window.webkit.messageHandlers.qa.postMessage(value);};
const assert = (value,message) => {if (!value) throw new Error(message);};
let worker;
window.addEventListener('securitypolicyviolation', event => emit({kind:'csp',directive:event.violatedDirective,blockedURI:event.blockedURI}));
window.addEventListener('error',event => emit({kind:'page-error',message:event.message,filename:event.filename}));
const query = request => new Promise((resolve,reject) => {
  const timer=setTimeout(()=>reject(new Error('module Worker did not answer within 15 seconds')),15000);
  worker.onmessage=event=>{clearTimeout(timer);event.data.error?reject(new Error(event.data.error)):resolve(event.data);};
  worker.onerror=event=>{clearTimeout(timer);reject(new Error('Worker error: '+event.message+' at '+event.filename+':'+event.lineno));};
  worker.postMessage(request);
});
try {
  assert(window.notemd?.pluginId==='notemd.strata','Production bridge plugin identity missing');
  const info=await window.notemd.request('host.vault.info');
  assert(info.root==='/synthetic-strata-vault','Bridge fixture RPC mismatch');
  emit({kind:'bridge-passed',origin:location.origin,protocol:location.protocol,userAgent:navigator.userAgent});
  const url=new URL('./assets/${worker}',import.meta.url);
  emit({kind:'worker-start',url:url.href,type:'module'});
  worker=new Worker(url,{type:'module',name:'strata-terrain'});
  const nodes=Array.from({length:4},(_,i)=>({id:'synthetic-'+i,title:'Fixture knowledge '+i,features:['fixture','concept'+i],sourceGroups:[{groupId:'group-'+i,groupVersion:'v1',priority:1.25,dates:[i<2?'2026-09-01':'2026-09-30']}]}));
  const selection={from:'2026-09-01',to:'2026-09-30'};const options={width:192,height:128,contourStep:4};
  const first=await query({id:1,action:'build',nodes,epoch:'webkit-fixture-v1',selection,options});
  assert(first.id===1&&first.result.field instanceof Float32Array,'Typed-array Worker response missing');
  assert(first.result.field.length===192*128,'Worker grid differs');
  assert(first.result.visibleIds.length===4,'Synthetic nodes omitted');
  assert(first.result.field.every(v=>Number.isFinite(v)&&v>=0)&&first.result.field.some(v=>v>0),'Nonfinite/empty terrain');
  emit({kind:'worker-build-passed',fieldLength:first.result.field.length,selected:first.result.stats.selectedNodes,contours:first.result.contours.length});
  const subset=await query({id:2,action:'render',selection:{from:'2026-09-01',to:'2026-09-01'},options});
  assert(subset.result.visibleIds.length===2,'Date filter differs');
  assert(subset.result.field.every((v,i)=>v<=first.result.field[i]+1e-6),'Subset increased terrain');
  const empty=await query({id:3,action:'render',selection:{from:'2027-01-01',to:'2027-01-01'},options});
  assert(empty.result.field.every(v=>v===0)&&empty.result.visibleIds.length===0,'Empty range produced a mountain');
  const canvas=document.createElement('canvas');canvas.style.cssText='width:640px;height:400px';document.body.append(canvas);
  const palette={'--st-bg':'#f5f4ed','--st-terrain-low':'#688566','--st-terrain-mid':'#8e9d7a','--st-terrain-high':'#c1bba8','--st-border':'#d8ddd3','--st-green':'#356e58'};
  let renderer=createTerrain3D(canvas,token=>palette[token]);
  const draw=result=>renderer.render({field:result.field,grid:result.grid,contours:result.contours,levels:result.levels,view:{yaw:-.25,pitch:.85,distance:14,targetX:.5,targetY:.5},verticalScale:1,contourOpacity:.65,detail:30});
  for(const result of [first.result,subset.result,empty.result,first.result,subset.result,first.result]) {draw(result);assert(!(canvas.getContext('webgl2')||canvas.getContext('webgl')).isContextLost(),'Date redraw lost WebGL context');}
  renderer.dispose();renderer=createTerrain3D(canvas,token=>palette[token]);draw(first.result);
  assert(!(canvas.getContext('webgl2')||canvas.getContext('webgl')).isContextLost(),'Renderer recreation reused a lost context');renderer.dispose();
  emit({kind:'webgl-passed',dateRenders:6,recreatedOnSameCanvas:true});
  worker.terminate();emit({kind:'complete',ok:true,checks:['production bridge RPC','same-origin plugin scheme module Worker','typed array transfer','date subset monotonicity','empty range zero','real WebGL date redraw and same-canvas renderer recreation']});
} catch(error) {worker?.terminate();emit({kind:'complete',ok:false,name:error.name,error:error.message,stack:error.stack});}
`)
await cp(source, served, { recursive: true })
run('cargo', ['test', '--manifest-path', 'src-tauri/Cargo.toml', '--lib', 'plugin_runtime::protocol::tests::export_webkit_protocol_fixture', '--', '--exact'], {
  env: { ...process.env, NOTEMD_WEBKIT_PLUGIN_ID: 'notemd.strata', NOTEMD_WEBKIT_PLUGIN_ROOT: source, NOTEMD_WEBKIT_PROTOCOL_FIXTURE: served },
})
const digest = async path => createHash('sha256').update(await readFile(path)).digest('hex')
await writeFile(join(output, 'identity.json'), JSON.stringify({ worker, workerSha256: await digest(join(source, 'assets', worker)), bridgeSha256: await digest(join(served, '__notemd_bridge__.js')), csp: await readFile(join(served, 'plugin-csp.txt'), 'utf8') }, null, 2))
const binary = join(output, 'strata-webkit-worker')
run('xcrun', ['swiftc', join(root, 'plugins-src/strata/scripts/webkit-worker.swift'), '-o', binary])
run(binary, [output, served])
