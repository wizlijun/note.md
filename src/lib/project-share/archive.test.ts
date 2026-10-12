import {describe,it,expect} from 'vitest'
import {unzipSync} from 'fflate'
import {buildProjectArchive} from './archive'
import {buildProjectBundle} from './bundle'
import type {ProjectFile,ProjectSnapshot} from './types'
async function file(path:string,content:string|Uint8Array):Promise<ProjectFile>{
  const bytes=typeof content==='string'?new TextEncoder().encode(content):content
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(bytes).buffer)),byte=>byte.toString(16).padStart(2,'0')).join('')
  return {path,hash,bytes:bytes.length,...(typeof content==='string'?{markdown:content}:{dataUrl:'data:application/octet-stream;base64,'+btoa(String.fromCharCode(...content))})}
}
async function snapshot():Promise<ProjectSnapshot>{return {schemaVersion:1,project_id:'project_1',snapshotId:'snapshot_2',entry:'入口.md',files:[await file('入口.md','# 中文\n'),await file('目录/empty.md',''),await file('附件/图片.bin',new Uint8Array([0,1,254,255]))]}}
describe('frozen project ZIP',()=>{
  it.each(['source','legacy'] as const)('keeps local metadata out of %s archives while preserving original bytes',async format=>{
    const data=await snapshot()
    const local={...data,schemaVersion:2 as const,parentSnapshotId:'private-parent',createdAt:'private-created',
      git:{snapshotCommit:'private-oid',headAtFreeze:'private-head',prefix:'private-prefix',repoRoot:'/private/repo'},gitError:'private-error',futureMetadata:'private-future',
      files:data.files.map(file=>({...file,localPath:'/private/file',futureFile:'private-file-future'}))}
    const html=buildProjectBundle(local,'https://share.example/feedback/test')
    const archive=unzipSync(await buildProjectArchive(local,html,format))
    expect(new TextDecoder().decode(archive['入口.md'])).toBe('# 中文\n')
    expect(Array.from(archive['附件/图片.bin'])).toEqual([0,1,254,255])
    expect(archive['目录/empty.md'].length).toBe(0)
    if(format==='source') expect(Object.keys(archive)).toEqual(['入口.md','目录/empty.md','附件/图片.bin'])
    else {
      const manifest=JSON.parse(new TextDecoder().decode(archive['.__notemd-snapshot_2/manifest.json']))
      expect(Object.keys(manifest).sort()).toEqual(['entry','files','htmlPath','project_id','schemaVersion','snapshotId'])
      expect(manifest.schemaVersion).toBe(1)
      expect(manifest.files.every((file:object)=>Object.keys(file).sort().join(',')==='bytes,hash,path')).toBe(true)
      expect(new TextDecoder().decode(archive[manifest.htmlPath])).toBe(html)
    }
    const text=Object.values(archive).map(bytes=>new TextDecoder().decode(bytes)).join('\n')
    for(const secret of ['private-parent','private-created','private-oid','private-head','private-prefix','/private/repo','private-error','private-future','/private/file','private-file-future']) expect(text).not.toContain(secret)
  })
  it('reproduces exact bytes and includes original files and the pre-rendered publication in one upload',async()=>{
    const data=await snapshot(),html='<html>冻结图表</html>'
    const first=await buildProjectArchive(data,html,'legacy')
    expect(await buildProjectArchive(data,html,'legacy')).toEqual(first)
    const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(first).buffer)),byte=>byte.toString(16).padStart(2,'0')).join('')
    expect(hash).toBe('2bda1b991f9bc75deb1fc20622d98d875bc2157ddd98dcceff85fe0aca2f412f')
    const archive=unzipSync(first)
    expect(new TextDecoder().decode(archive['入口.md'])).toBe('# 中文\n')
    expect(Array.from(archive['附件/图片.bin'])).toEqual([0,1,254,255])
    expect(archive['目录/empty.md'].length).toBe(0)
    const manifest=JSON.parse(new TextDecoder().decode(archive['.__notemd-snapshot_2/manifest.json']))
    expect(manifest).toMatchObject({project_id:'project_1',snapshotId:'snapshot_2',entry:'入口.md',files:data.files.map(({path,hash,bytes})=>({path,hash,bytes}))})
    expect(new TextDecoder().decode(archive[manifest.htmlPath])).toBe(html)
  })
  it('defaults to a deterministic source-only download without reader or metadata',async()=>{
    const data=await snapshot()
    const zip=await buildProjectArchive(data,'<html>reader</html>')
    expect(await buildProjectArchive(data,'different reader')).toEqual(zip)
    expect(Object.keys(unzipSync(zip))).toEqual(data.files.map(file=>file.path))
    expect(new TextDecoder().decode(unzipSync(zip)['入口.md'])).toBe('# 中文\n')
  })
  it('rejects hidden management files in every source path in both formats',async()=>{
    const data=await snapshot()
    for(const path of ['.notemd/state.json','folder/.notemd/file.md','folder/.NOTEMD/cache','folder/.DS_Store','folder/.hidden.md']) {
      for(const format of ['source','legacy'] as const) {
        await expect(buildProjectArchive({...data,files:[...data.files,await file(path,'private')]},'html',format)).rejects.toThrow('路径')
      }
    }
  })
  it('rejects changed frozen bytes, traversal, missing entry and duplicate names',async()=>{
    const data=await snapshot()
    await expect(buildProjectArchive({...data,files:[{...data.files[0],markdown:'changed'}]},'html')).rejects.toThrow('校验')
    for(const path of ['../secret','/absolute','a\\b','a/./b','a//b','A.md','a.md']){
      const files=path==='a.md'?[...data.files,await file('A.md','a'),await file(path,'a')]:[...data.files,await file(path,'a')]
      if(path==='A.md')continue
      await expect(buildProjectArchive({...data,files},'html')).rejects.toThrow('路径')
    }
    await expect(buildProjectArchive({...data,entry:'missing.md'},'html')).rejects.toThrow('入口')
    await expect(buildProjectArchive(data,'x'.repeat(25*1024*1024+1),'legacy')).rejects.toThrow('25 MiB')
  })
})
