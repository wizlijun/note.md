import { Zip, ZipDeflate } from 'fflate'
import type { ProjectSnapshot } from './types'

/** Fixed metadata and entry order make retries reproduce the frozen package. */
export async function buildProjectArchive(snapshot: ProjectSnapshot, html: string): Promise<Uint8Array> {
  const encoder=new TextEncoder()
  const reader=encoder.encode(html)
  if(reader.length>25*1024*1024) throw new Error('分享页面超过 25 MiB')
  if(snapshot.files.length>512) throw new Error('分享文件超过 512 个')
  const prefix=`.__notemd-${snapshot.snapshotId}`
  const entries:Array<[string,Uint8Array]>=[]
  const seen=new Set<string>()
  let total=0
  for(const file of snapshot.files) {
    if(!file.path || /[\\:\x00-\x1f]/.test(file.path) || file.path.split('/').some(part=>!part || part==='.' || part==='..')
      || encoder.encode(file.path).length>1024 || file.path.startsWith(prefix+'/') || seen.has(file.path.toLowerCase())) throw new Error('无效或重复的分享文件路径')
    seen.add(file.path.toLowerCase())
    let bytes:Uint8Array
    if(typeof file.markdown==='string') bytes=encoder.encode(file.markdown)
    else {
      if(!file.dataUrl || !/^data:[^,]*;base64,/i.test(file.dataUrl)) throw new Error('分享附件缺少原始字节')
      bytes=Uint8Array.from(atob(file.dataUrl.slice(file.dataUrl.indexOf(',')+1)),char=>char.charCodeAt(0))
    }
    total+=bytes.length
    if(total>25*1024*1024) throw new Error('分享源文件超过 25 MiB')
    const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(bytes).buffer)),byte=>byte.toString(16).padStart(2,'0')).join('')
    if(bytes.length!==file.bytes || hash!==file.hash) throw new Error('分享快照校验失败：'+file.path)
    entries.push([file.path,bytes])
  }
  if(!snapshot.files.some(file=>file.path===snapshot.entry && typeof file.markdown==='string')) throw new Error('分享包缺少入口文档')
  const manifest=encoder.encode(JSON.stringify({schemaVersion:1,project_id:snapshot.project_id,snapshotId:snapshot.snapshotId,entry:snapshot.entry,
    htmlPath:prefix+'/reader.html',files:snapshot.files.map(({path,hash,bytes})=>({path,hash,bytes}))}))
  if(manifest.length>256*1024) throw new Error('分享文件清单过大')
  entries.push([prefix+'/manifest.json',manifest],[prefix+'/reader.html',reader])
  const chunks:Uint8Array[]=[]
  let size=0
  const archive=new Zip((error,chunk)=> {
    if(error) throw error
    size+=chunk.length
    if(size>32*1024*1024) throw new Error('压缩分享包超过 32 MiB')
    chunks.push(chunk)
  })
  for(const [path,bytes] of entries) {
    const entry=new ZipDeflate(path,{level:6})
    entry.mtime=new Date(1980,0,1)
    archive.add(entry); entry.push(bytes,true)
  }
  archive.end()
  const result=new Uint8Array(size)
  let offset=0
  for(const chunk of chunks) { result.set(chunk,offset); offset+=chunk.length }
  return result
}
