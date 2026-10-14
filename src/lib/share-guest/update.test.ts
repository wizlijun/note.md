import { expect, it } from 'vitest'
import { planGuestUpdate } from './update'
import { sha256Sync } from '../share-merge/hash'
const ids = {fromSnapshotId:'S1',toSnapshotId:'S2'}
it('conflicting sentence remains untouched with the exact raw work hash',()=>{
 const work='甲！\n\n乙。\n'
 const p=planGuestUpdate({...ids,oldBase:{'a.md':'甲。\n\n乙。\n'},newBase:{'a.md':'甲？\n\n乙。\n'},work:{'a.md':work}})
 expect(p.conflicts.map(x=>x.path)).toEqual(['a.md']);expect(p.actions).toEqual([])
 expect(p.conflicts[0].expectedHash).toBe(sha256Sync(work))
})
it('retains even flagged local hunks while taking publisher-only changes',()=>{
 const p=planGuestUpdate({...ids,oldBase:{'a.md':'甲。\n\n乙。\n'},newBase:{'a.md':'甲？\n\n乙。\n'},work:{'a.md':'甲。\n\n乙！\u202e\n'}})
 expect(p.conflicts).toEqual([])
 expect(p.actions).toEqual([{kind:'write',path:'a.md',expectedHash:sha256Sync('甲。\n\n乙！\u202e\n'),content:'甲？\n\n乙！\u202e\n'}])
})
it('deletes only unchanged removed sources and keeps locally changed ones',()=>{
 const p=planGuestUpdate({...ids,oldBase:{'a.md':'A','b.md':'B'},newBase:{},work:{'a.md':'A','b.md':'edit'}})
 expect(p.actions.map(x=>[x.kind,x.path])).toEqual([['delete','a.md'],['retain-removed','b.md']])
})
it('preserves unknown names and chooses a case-fold-safe shared suffix',()=>{
 const p=planGuestUpdate({...ids,oldBase:{},newBase:{'a.md':'new'},work:{'a.md':'unknown','A.SHARED.MD':'unknown2'}})
 expect(p.actions).toEqual([{kind:'copy-base',sourcePath:'a.md',path:'a.shared-2.md',expectedHash:null}])
})
it('missing work is a file choice, never an empty merge input',()=>{
 const p=planGuestUpdate({...ids,oldBase:{'a.md':'old'},newBase:{'a.md':'new'},work:{}})
 expect(p.choices).toEqual([{path:'a.md',expectedHash:null}]);expect(p.actions).toEqual([])
})

it('raw BOM/CRLF CAS is independent of kernel EOL alignment',()=>{
 const work='甲！\n'
 const p=planGuestUpdate({...ids,oldBase:{'a.md':'\ufeff甲。\r\n'},newBase:{'a.md':'\ufeff乙。\r\n'},work:{'a.md':work}})
 expect(p.conflicts[0].expectedHash).toBe(sha256Sync(work))
 expect(p.conflicts[0].proposal.theirsHash).not.toBe(p.conflicts[0].expectedHash)
})
it('produces the real desktop update plan, all three resolutions, and S2 submission consumer fixture',async()=>{
 const {composeGuest}=await import('./update'),{buildGuestSubmission}=await import('../project-share/guest-submission')
 const oldBase={'clean.md':'甲。\n\n乙。\n','publisher.md':'甲。','mine.md':'甲。','human.md':'甲。'}
 const newBase={'clean.md':'甲？\n\n乙。\n','publisher.md':'乙。','mine.md':'乙。','human.md':'乙。'}
 const work={'clean.md':'甲。\n\n乙！\n','publisher.md':'丙。','mine.md':'丙。','human.md':'丙。'}
 const input={...ids,oldBase,newBase,work},plan=planGuestUpdate(input)
 const resolutions=plan.conflicts.map((file,i)=>({path:file.path,expectedHash:file.expectedHash,content:composeGuest(file.proposal,Object.fromEntries(file.proposal.hunks.filter(h=>h.kind==='conflict').map(h=>[h.id,{kind:'conflict' as const,choice:(['ours','theirs','edited'] as const)[i],...(i===2?{text:'人工。',source:'human' as const}:{})}])))}))
 const after=Object.fromEntries([...plan.actions.flatMap(a=>a.kind==='write'?[[a.path,a.content]]:[]),...resolutions.map(r=>[r.path,r.content])])
 const submission=buildGuestSubmission({project_id:'pid',submissionId:'new-submission',client:{kind:'notemd',version:'test'},message:'updated',name:'Guest',draft:{v:2,lineageId:'fixture',snapshotId:'S2',base:Object.fromEntries(Object.entries(newBase).map(([p,markdown])=>[p,{markdown,hash:sha256Sync(markdown)}])),after,annotationKinds:{},lastSubmissionId:'previous'}})
 const artifact={input,plan,resolutions,after,submission:submission.body}
 const fixture=await import('../../../src-tauri/src/share_guest/fixtures/update-producer.json')
 expect(artifact).toEqual(fixture.default)
 expect(JSON.parse(submission.body).snapshotId).toBe('S2');expect(JSON.parse(submission.body).supersedes).toBe('previous')
 if(process.env.GATE_LOG_DIR) await (await import('node:fs/promises')).writeFile(process.env.GATE_LOG_DIR+'/update-producer.json',JSON.stringify(artifact,null,2)+'\n')
})
