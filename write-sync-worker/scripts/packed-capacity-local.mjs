/** Isolated local workerd capacity proof. Never contacts the Cloudflare account. */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
const root=path.resolve(import.meta.dirname,'../..'), task=path.join(root,'tasks/sumi-sync');
const endpoint='http://127.0.0.1:18788';
const sha=b=>createHash('sha256').update(b).digest('hex');
const fixture=JSON.parse(fs.readFileSync(path.join(task,'capacity-fixture.json')));
const runtimeProof=()=>Object.fromEntries(fs.readdirSync(path.join(root,'write-sync-worker/src')).filter(name=>name.endsWith('.ts')).sort().map(name=>['src/'+name,sha(fs.readFileSync(path.join(root,'write-sync-worker/src',name)))]));
const initialRuntimeHashes=runtimeProof();
async function api(route,method='GET',body,token,status=200){const r=await fetch(endpoint+route,{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(180000)});const text=await r.text();let value;try{value=JSON.parse(text);}catch{throw Error(`${route}: HTTP ${r.status} non-JSON ${text.slice(0,80)}`);}assert.equal(r.status,status,`${route}: ${JSON.stringify(value)}`);return value;}
const a=await api('/admin/provision','POST',{},'test-admin-secret',201);
await api('/v1/pages','POST',{opId:randomUUID(),pageId:fixture.pageId,localDate:'2026-11-07'},a.accessToken,201);
const before=await api('/v1/diagnostics','GET',undefined,a.accessToken);assert.equal(before.wireSchema,'packed-v1');assert.ok(before.sql);
const payload={opId:randomUUID(),epoch:1,generation:0,update:fixture.update};const t=performance.now();const ack=await api('/v1/pages/'+fixture.pageId+'/update','POST',payload,a.accessToken);const commitMs=performance.now()-t;
const after=await api('/v1/diagnostics','GET',undefined,a.accessToken);assert.equal(after.instanceId,before.instanceId);
assert.deepEqual(await api('/v1/pages/'+fixture.pageId+'/update','POST',payload,a.accessToken),ack);
const duplicate=await api('/v1/diagnostics','GET',undefined,a.accessToken);assert.equal(duplicate.sql.rowsWritten,after.sql.rowsWritten);
const backup=await api('/v1/backup','POST',{},a.accessToken);const backed=await api('/v1/diagnostics','GET',undefined,a.accessToken);
const t2=performance.now();const recovery=await api('/admin/recover','POST',{backupKey:backup.key},'test-admin-secret',201);const recoveryMs=performance.now()-t2;
const recovered=await api('/v1/diagnostics','GET',undefined,recovery.accessToken);assert.equal(recovered.wireSchema,'packed-v1');
const diff=(a,b)=>({rowsRead:b.rowsRead-a.rowsRead,rowsWritten:b.rowsWritten-a.rowsWritten});
const runtimeHashes=runtimeProof();assert.deepEqual(runtimeHashes,initialRuntimeHashes,'Runtime source changed during capacity proof');
const report={updateSha256:sha(Buffer.from(fixture.update,'base64')),bytes:Buffer.from(fixture.update,'base64').length,commitMs,recoveryMs,initial:diff(before.sql,after.sql),backup:diff(duplicate.sql,backed.sql),recovery:recovered.sql,allMeasuredWrites:backed.sql.rowsWritten+recovered.sql.rowsWritten,allMeasuredReads:backed.sql.rowsRead+recovered.sql.rowsRead,runtimeHashes,approvedForCloud:false};
// Include paired devices, small live edits, replay cursor reads and conservative safety margin.
report.estimatedCloudRowsWritten=report.allMeasuredWrites+5000;report.estimatedCloudRowsRead=report.allMeasuredReads+200000;
report.approvedForCloud=commitMs<25000&&recoveryMs<25000&&report.estimatedCloudRowsWritten<45000&&report.estimatedCloudRowsRead<2000000;
fs.writeFileSync(path.join(task,'packed-capacity-budget.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));assert.equal(report.approvedForCloud,true,'Local capacity exceeds conservative cloud budget');
