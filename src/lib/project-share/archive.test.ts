import {describe,it,expect} from 'vitest'
import {unzipSync} from 'fflate'
import {buildProjectArchive} from './archive'
import type {ProjectFile,ProjectSnapshot} from './types'
async function file(path:string,content:string|Uint8Array):Promise<ProjectFile>{
  const bytes=typeof content==='string'?new TextEncoder().encode(content):content
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(bytes).buffer)),byte=>byte.toString(16).padStart(2,'0')).join('')
  return {path,hash,bytes:bytes.length,...(typeof content==='string'?{markdown:content}:{dataUrl:'data:application/octet-stream;base64,'+btoa(String.fromCharCode(...content))})}
}
async function snapshot():Promise<ProjectSnapshot>{return {schemaVersion:1,project_id:'project_1',snapshotId:'snapshot_2',entry:'入口.md',files:[await file('入口.md','# 中文\n'),await file('目录/empty.md',''),await file('附件/图片.bin',new Uint8Array([0,1,254,255]))]}}
describe('frozen project ZIP',()=>{
  it('reproduces exact bytes and includes original files and the pre-rendered publication in one upload',async()=>{
    const data=await snapshot(),html='<html>冻结图表</html>'
    const first=await buildProjectArchive(data,html)
    expect(await buildProjectArchive(data,html)).toEqual(first)
    const archive=unzipSync(first)
    expect(new TextDecoder().decode(archive['入口.md'])).toBe('# 中文\n')
    expect(Array.from(archive['附件/图片.bin'])).toEqual([0,1,254,255])
    expect(archive['目录/empty.md'].length).toBe(0)
    const manifest=JSON.parse(new TextDecoder().decode(archive['.__notemd-snapshot_2/manifest.json']))
    expect(manifest).toMatchObject({project_id:'project_1',snapshotId:'snapshot_2',entry:'入口.md',files:data.files.map(({path,hash,bytes})=>({path,hash,bytes}))})
    expect(new TextDecoder().decode(archive[manifest.htmlPath])).toBe(html)
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
    await expect(buildProjectArchive(data,'x'.repeat(25*1024*1024+1))).rejects.toThrow('25 MiB')
  })
})
