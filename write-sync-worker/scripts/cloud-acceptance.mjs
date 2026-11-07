/** Real-cloud isolated-space acceptance. Credentials only in an existing 0700 directory. */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import * as Y from '../node_modules/yjs/dist/yjs.mjs';
const require = createRequire(import.meta.url);
assert.ok(process.argv.slice(2).every(arg => ['--sequential-history','--resume-accepted-upload','--resume-after-http'].includes(arg)), 'Unknown acceptance mode');
const WebSocket = require('../../worker/node_modules/.pnpm/ws@8.18.0/node_modules/ws');
const root = path.resolve(import.meta.dirname, '../..');
const task = path.join(root, 'tasks/sumi-sync');
const privateDir = fs.readFileSync(path.join(task, 'cloud-private-dir.txt'), 'utf8').trim();
assert.equal(fs.statSync(privateDir).mode & 0o077, 0);
const endpoint = JSON.parse(fs.readFileSync(path.join(task, 'cloud-endpoint.json'))).url;
const owner = JSON.parse(fs.readFileSync(path.join(privateDir, 'admin.json')));
const sha = b => createHash('sha256').update(b).digest('hex');
const scenarioName = process.argv.includes('--sequential-history') ? 'sequential' : 'bulk';
const privateWrite = (name, data) => fs.writeFileSync(path.join(privateDir, scenarioName + '-' + name), JSON.stringify(data), {mode: 0o600});
const resumeAfterHttp = process.argv.includes('--resume-after-http');
const resume = process.argv.includes('--resume-accepted-upload') || resumeAfterHttp;
assert.ok(!resume || scenarioName === 'sequential', 'Resume only applies to the retained sequential upload');
const report = resume ? JSON.parse(fs.readFileSync(path.join(task, 'cloud-acceptance-sequential.json'))) : { endpoint, startedAt: new Date().toISOString(), isolated: true, checks: [] };
if (resume) { report.resumedAt = new Date().toISOString(); delete report.failure; }
const save = () => fs.writeFileSync(path.join(task, process.argv.includes('--sequential-history') ? 'cloud-acceptance-sequential.json' : 'cloud-acceptance.json'), JSON.stringify(report, null, 2));
function passed(name, detail = {}) { report.checks.push({name, ...detail, passed: true}); save(); console.log('PASS', name, JSON.stringify(detail)); }
const tokenOwners = new Map();
async function refreshDevice(auth) {
 const old=auth.accessToken;Object.assign(auth,await api('/v1/token','POST',auth));
 tokenOwners.set(old,auth);tokenOwners.set(auth.accessToken,auth);return auth;
}
async function api(route, method='GET', body, token, status=200) {
 const auth=tokenOwners.get(token);
 if(auth) { if(auth.expiresAt <= Math.floor(Date.now()/1000)+390) await refreshDevice(auth); token=auth.accessToken; }
 let r;
 for(let attempt=0;;attempt++) {
  try { r=await fetch(endpoint + route, {method, headers: {'content-type':'application/json', ...(token ? {authorization:'Bearer '+token}: {})}, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(route.endsWith('/update') ? Math.min(360000, 60000 + Math.ceil((body?.update?.length || 0) / 65536) * 1000) : 60000)}); break; }
  catch(error) {
   console.log('Network request failed',method,route,error.cause?.code||error.name);
   if(attempt>=1||(!body?.opId&&method!=='GET'))throw error;
   // Check this exact page after a lost response before retrying the identical opId/body.
   const pageRoute=route.match(/^(\/v1\/pages\/[^/]+)/)?.[1];
   if(pageRoute){const check=await fetch(endpoint+pageRoute,{headers:{authorization:'Bearer '+token},signal:AbortSignal.timeout(20000)});console.log('Readback before identical retry',check.status);await check.arrayBuffer();}
  }
 }
 const raw=await r.text(); let json; try { json=JSON.parse(raw); } catch { privateWrite('acceptance-non-json-response.json',{route,status:r.status,raw}); throw new Error(`${method} ${route}: HTTP ${r.status} non-JSON response; private evidence retained`); } assert.equal(r.status, status, `${method} ${route}: status ${r.status}, error ${json.error || 'none'}`); return json;
}
async function replay(auth, pageId) {
 let request = {epoch:1,stateVector:'AA=='}, parts=[], last, count=0;
 while(true) {
  last=await api(`/v1/pages/${pageId}/sync`,'POST',request,auth.accessToken);
  const bytes=Buffer.concat(last.chunks.map(c=>Buffer.from(c,'base64'))); assert.equal(sha(bytes),last.sha256);parts.push(bytes);count++;
  if(!last.hasMore)break;
  request={...request,cursor:last.cursor,throughVersion:last.throughVersion,generation:last.page.generation,quarantineRevision:last.quarantineRevision};
 }
 const stream=Buffer.concat(parts), updates=[];let at=0;
 while(at<stream.length){assert.ok(at+4<=stream.length);const n=stream.readUInt32LE(at);at+=4;assert.ok(at+n<=stream.length);updates.push(stream.subarray(at,at+n));at+=n;}
 const doc=new Y.Doc();for(const bytes of updates)Y.applyUpdate(doc,bytes);
 return {doc,last,pages:count,packedBytes:stream.length,updates};
}
class Socket {
 constructor(auth){this.queue=[];this.waiters=[];this.ws=new WebSocket(endpoint.replace('https:','wss:')+'/v1/ws',{headers:{authorization:'Bearer '+auth.accessToken}});this.ws.on('message',raw=>{const msg=JSON.parse(raw);const pending=this.waiters.shift();pending?pending.resolve(msg):this.queue.push(msg);});this.closed=new Promise(resolve=>this.ws.on('close',code=>resolve(code)));}
 async open(){await new Promise((resolve,reject)=>{this.ws.once('open',resolve);this.ws.once('error',reject);});this.send({type:'hello',protocol:1});assert.equal((await this.next()).type,'hello');}
 send(msg){this.ws.send(JSON.stringify(msg));}
 next(){if(this.queue.length)return Promise.resolve(this.queue.shift());return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('socket message timeout')),180000);this.waiters.push({resolve:v=>{clearTimeout(timer);resolve(v);}});});}
 async subscribe(pageId){this.send({type:'subscribe',pageId,epoch:1,stateVector:'AA=='});const start=await this.next();assert.equal(start.type,'sync_begin');let index=0;const parts=[];for(;;){const msg=await this.next();if(msg.type==='sync_end'){assert.equal(msg.pages,index);break;}assert.equal(msg.type,'journal_page');assert.equal(msg.index,index++);const bytes=Buffer.concat(msg.chunks.map(c=>Buffer.from(c,'base64')));assert.equal(sha(bytes),msg.sha256);parts.push(bytes);}return Buffer.concat(parts);}
 async ping(){this.send({type:'ping'});const pong=await this.next();assert.equal(pong.type,'pong');return pong.instanceId;}
}
try {
 const sequential=scenarioName==='sequential';report.scenario=sequential?'100k-sequential-edits':'100k-character-bulk';
 const fixture=JSON.parse(fs.readFileSync(path.join(task,sequential?'capacity-fixture.json':'cloud-bulk-fixture.json')));const pageId=fixture.pageId;report.pageId=pageId;
 if(sequential) {
  const proof=JSON.parse(fs.readFileSync(path.join(task,'packed-capacity-budget.json')));
  assert.equal(proof.approvedForCloud,true,'Missing locally validated cloud budget');
  assert.equal(proof.updateSha256,sha(Buffer.from(fixture.update,'base64')),'Capacity fixture changed');
  for(const [name,digest] of Object.entries(proof.runtimeHashes)) assert.equal(sha(fs.readFileSync(path.join(root,'write-sync-worker',name))),digest,'Runtime changed after capacity validation');
  const quotaPath=path.join(task,'cloud-account-quota-before.json');assert.ok(Date.now()-fs.statSync(quotaPath).mtimeMs<900000,'Refresh shared quota before stress');
  const quota=JSON.parse(fs.readFileSync(quotaPath)).viewer.accounts[0].durableObjectsPeriodicGroups.reduce((sum,row)=>({rowsWritten:sum.rowsWritten+row.sum.rowsWritten,rowsRead:sum.rowsRead+row.sum.rowsRead}),{rowsWritten:0,rowsRead:0});
  assert.ok(quota.rowsWritten+proof.estimatedCloudRowsWritten<50000,'Preserve at least half the shared daily write quota');
  assert.ok(quota.rowsRead+proof.estimatedCloudRowsRead<2500000,'Preserve at least half the shared daily read quota');
  passed('local capacity and shared quota preflight',{quota,estimatedRowsWritten:proof.estimatedCloudRowsWritten,estimatedRowsRead:proof.estimatedCloudRowsRead});
 }
 assert.equal((await api('/health')).service,'sumi-sync');await api('/v1/pages','GET',undefined,undefined,401);passed('public health and private authorization');
 let a, b;
 if(resume) {
  a=JSON.parse(fs.readFileSync(path.join(privateDir,'sequential-acceptance-device-a.json')));
  b=JSON.parse(fs.readFileSync(path.join(privateDir,'sequential-acceptance-device-b.json')));
  assert.equal(a.spaceId,report.spaceId);assert.equal(b.spaceId,a.spaceId);
  await refreshDevice(a);await refreshDevice(b);
  privateWrite('acceptance-device-a.json',a);privateWrite('acceptance-device-b.json',b);
  assert.equal((await api(`/v1/pages/${pageId}`,'GET',undefined,a.accessToken)).page.version,1);
 } else {
  a=await api('/admin/provision','POST',{},owner.PROVISION_KEY,201);privateWrite('acceptance-device-a.json',a);report.spaceId=a.spaceId;save();
  const invitation=await api('/v1/pair','POST',{},a.accessToken,201);b=await api('/v1/pair/redeem','POST',invitation,undefined,201);privateWrite('acceptance-device-b.json',b);await api('/v1/pair/redeem','POST',invitation,undefined,401);passed('one-use pairing');
  await api('/v1/pages','POST',{opId:randomUUID(),pageId,localDate:'2026-11-07'},a.accessToken,201);
 }
 tokenOwners.set(a.accessToken,a);tokenOwners.set(b.accessToken,b);
 const diagnostics=await api('/v1/diagnostics','GET',undefined,a.accessToken);assert.equal(diagnostics.wireSchema,'packed-v1','Refuse capacity traffic on a legacy index');passed('fresh space selects packed durable index');
 const update=resume ? JSON.parse(fs.readFileSync(path.join(privateDir,'curl-update.json'))) : {opId:randomUUID(),epoch:1,generation:0,update:fixture.update};
 assert.equal(update.update,fixture.update);privateWrite('initial-update.json',update);
 const began=performance.now();const ack=resume ? JSON.parse(fs.readFileSync(path.join(privateDir,'curl-update-response.json'))) : await api(`/v1/pages/${pageId}/update`,'POST',update,a.accessToken);const commitMs=resume ? Math.round(JSON.parse(fs.readFileSync(path.join(task,'cloud-large-upload-refreshed.json'))).time_total * 1000) : Math.round(performance.now()-began);assert.equal(ack.version,1);assert.equal(ack.opId,update.opId);assert.equal(ack.pageId,pageId);
 let full;
 if(resumeAfterHttp) {
  assert.ok(report.checks.some(c=>c.name==='100k text durable commit and retry'&&c.passed));
  assert.ok(report.checks.some(c=>c.name==='100k checksummed HTTP replay'&&c.passed&&c.sha256===sha(Buffer.from(fixture.update,'base64'))));
  const doc=new Y.Doc();Y.applyUpdate(doc,Buffer.from(fixture.update,'base64'));full={doc,packedBytes:Buffer.from(fixture.update,'base64').length+4};
  passed('resumed only after exact initial HTTP evidence',{sha256:sha(Buffer.from(fixture.update,'base64'))});
 } else {
  assert.deepEqual(await api(`/v1/pages/${pageId}/update`,'POST',update,a.accessToken),ack);passed('100k text durable commit and retry',{bytes:Buffer.from(fixture.update,'base64').length,commitMs});
  const before=performance.now();full=await replay(b,pageId);assert.equal([...full.doc.getText('body').toString()].length,100000);passed('100k checksummed HTTP replay',{pages:full.pages,replayMs:Math.round(performance.now()-before),sha256:sha(Y.encodeStateAsUpdate(full.doc))});
 }
 await refreshDevice(b);
 const socket=new Socket(b);await socket.open();const wsStart=performance.now();const packed=await socket.subscribe(pageId);assert.equal(packed.length,full.packedBytes);passed('100k WebSocket journal replay',{replayMs:Math.round(performance.now()-wsStart)});
 const original=await socket.ping();let current=original,idle=0;
 while(current===original&&idle<240){console.log('Waiting for real DO hibernation, elapsed',idle);await new Promise(r=>setTimeout(r,45000));idle+=45;current=await socket.ping();}
 assert.notEqual(current,original,'No actual DO rehydration observed; do not claim hibernation');passed('same WebSocket survives actual DO hibernation',{idleSeconds:idle,before:original,after:current});
 const baseVector=Y.encodeStateVector(full.doc);const second=new Y.Doc();Y.applyUpdate(second,Y.encodeStateAsUpdate(full.doc));full.doc.getText('body').insert(0,'A');second.getText('body').insert(0,'B');
 const offlineA=Y.encodeStateAsUpdate(full.doc,baseVector),offlineB=Y.encodeStateAsUpdate(second,baseVector);
 await api(`/v1/pages/${pageId}/update`,'POST',{opId:randomUUID(),epoch:1,generation:0,update:Buffer.from(offlineA).toString('base64')},a.accessToken);assert.equal((await socket.next()).type,'update');
 await api(`/v1/pages/${pageId}/update`,'POST',{opId:randomUUID(),epoch:1,generation:0,update:Buffer.from(offlineB).toString('base64')},b.accessToken);assert.equal((await socket.next()).type,'update');
 Y.applyUpdate(full.doc,offlineB);Y.applyUpdate(second,offlineA);assert.equal(full.doc.getText('body').toString(),second.getText('body').toString());const merged=await replay(a,pageId);assert.equal(merged.doc.getText('body').toString(),full.doc.getText('body').toString());passed('offline concurrent merge and live delivery after hibernation');
 const backup=await api('/v1/backup','POST',{},a.accessToken);report.backupKey=backup.key;save();
 const vector=Y.encodeStateVector(full.doc);full.doc.getText('body').insert(0,'AFTER');await api(`/v1/pages/${pageId}/update`,'POST',{opId:randomUUID(),epoch:1,generation:0,update:Buffer.from(Y.encodeStateAsUpdate(full.doc,vector)).toString('base64')},a.accessToken);assert.equal((await socket.next()).type,'update');
 socket.ws.close();
 const recovered=await api('/admin/recover','POST',{backupKey:backup.key},owner.PROVISION_KEY,201);privateWrite('acceptance-recovered.json',recovered);assert.notEqual(recovered.spaceId,a.spaceId);const recoveredState=await replay(recovered,pageId);assert.equal(recoveredState.doc.getText('body').toString(),merged.doc.getText('body').toString());passed('R2 frozen revision recovered into new credential-isolated space',{recoveredSpaceId:recovered.spaceId,backupKey:backup.key});
 await refreshDevice(b);const revocationSocket=new Socket(b);await revocationSocket.open();
 const staleInvite=await api('/v1/pair','POST',{},b.accessToken,201);await api(`/v1/devices/${b.deviceId}`,'DELETE',undefined,a.accessToken);assert.equal(await revocationSocket.closed,4001);tokenOwners.delete(b.accessToken);await api('/v1/pages','GET',undefined,b.accessToken,401);await api('/v1/token','POST',b,undefined,401);await api('/v1/pair/redeem','POST',staleInvite,undefined,401);passed('revocation closes connected device and invalidates refresh/invitation');
 report.completedAt=new Date().toISOString();report.passed=true;save();
} catch(error){report.passed=false;report.failure=String(error);save();console.error(String(error));process.exit(1);}
