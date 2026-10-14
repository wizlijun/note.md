import type { ShareEditorHandle, ShareEditorHost, ShareEditorModule } from '../../share-editor/contract'
import type { DraftV2, ProjectAnnotationV2 } from './types'

/** Serialized into the static bundle. Keep every runtime dependency inside this function. */
export async function projectShareBrowser(parser: any, zipper?: any, scanCritic?: (raw: string) => { raw: string }[]): Promise<void> {
  const data = JSON.parse(document.getElementById('project-data')!.textContent!)
  const snapshot = data.snapshot
  const files = new Map<string, any>(snapshot.files.map((file: any) => [file.path, file]))
  const docs = snapshot.files.filter((file: any) => typeof file.markdown === 'string')
  const $ = (id: string) => document.getElementById(id)!
  const editor = $('editor') as HTMLTextAreaElement
  const name = $('name') as HTMLInputElement
  const status = $('status')
  const article = $('document')
  const submit = $('submit') as HTMLButtonElement
  const editButton = $('edit') as HTMLButtonElement
  let path = snapshot.entry
  let editing = false
  let baseline = false
  let handle: ShareEditorHandle | undefined
  let editorHost: ShareEditorHost | undefined
  let loadEpoch = 0
  let loading: Promise<void> | undefined
  let cancelLoad = () => {}
  const enhanced = document.createElement('section'); enhanced.id='enhanced-editor'; enhanced.hidden=true; editor.after(enhanced)
  const continueCurrent=document.createElement('button');continueCurrent.className='reader-button';continueCurrent.textContent='在新版本上继续';continueCurrent.hidden=true;$('old-drafts').append(continueCurrent)
  const badges = new Map<string, {changed:boolean;annotations:number}>()
  const durablePending = new Map<string, NonNullable<DraftV2['pending']>>()
  const providedToken = new URLSearchParams(location.hash.slice(1)).get('feedback') ?? ''
  let token = providedToken
  let db: IDBDatabase | undefined
  let ready = false
  let initialized = false
  const fresh = (): DraftV2 => ({v:2,lineageId:crypto.randomUUID(),snapshotId:snapshot.snapshotId,base:{},after:{},annotationKinds:{}})
  let draft = fresh()
  let notes: ProjectAnnotationV2[] = []
  let submitted: string[] = []
  let sentMarker: { submissionId: string; contentHash: string } | undefined
  let restoredContentHash: string | undefined
  let rejectedPending: DraftV2['pending']
  const rejectedBodies = new Map<string, NonNullable<DraftV2['pending']>>()
  let revoked = false
  const prefix = snapshot.project_id + ':'
  const legacy = new Map<string, any>()
  const drafts = new Map<string, DraftV2>()
  const oldDraftLabels = new Map<string, Text>()
  const state = { get drafts() { return draft.after }, get annotations() { return notes }, get pending() { return draft.pending } }

  let saving = Promise.resolve()
  let busy = false
  let transitioning = 0
  const draftKey = () => prefix+'draft2:'+draft.lineageId
  const notesKey = () => prefix+'draft2-notes:'+draft.lineageId
  const sentKey = () => prefix+'draft2-sent:'+draft.lineageId
  const expanded = new Set<string>()
  const panel = $('file-panel')
  const fileToggle = $('file-toggle')
  const menu = $('file-menu')
  let menuTarget: HTMLElement | undefined
  let downloadPath = ''
  const download = (bytes: Uint8Array, filename: string) => {
    const url=URL.createObjectURL(new Blob([new Uint8Array(bytes).buffer],{type:'application/octet-stream'}))
    const link=document.createElement('a'); link.href=url; link.download=filename; link.click()
    setTimeout(()=>URL.revokeObjectURL(url),1000)
  }
  const fileBytes = (file:any): Uint8Array => {
    if(typeof file.markdown==='string') return new TextEncoder().encode(file.markdown)
    const raw=atob(file.dataUrl.slice(file.dataUrl.indexOf(',')+1))
    return Uint8Array.from(raw,char=>char.charCodeAt(0))
  }
  const closeMenu = (restoreFocus=false) => {
    menu.hidden=true
    if(restoreFocus) menuTarget?.focus()
  }
  const openMenu = (event: MouseEvent | KeyboardEvent, row:HTMLElement, filePath:string) => {
    event.preventDefault(); menuTarget=row; downloadPath=filePath; menu.hidden=false
    const rect=row.getBoundingClientRect()
    const x=event instanceof MouseEvent && event.clientX ? event.clientX : rect.left
    const y=event instanceof MouseEvent && event.clientY ? event.clientY : rect.bottom
    menu.style.left=Math.max(4,Math.min(x,innerWidth-menu.offsetWidth-4))+'px'
    menu.style.top=Math.max(4,Math.min(y,innerHeight-menu.offsetHeight-4))+'px'
    $('download-file').focus()
  }
  $('download-file').onclick=()=> { download(fileBytes(files.get(downloadPath)),downloadPath.split('/').pop()!); closeMenu(true) }
  $('download-all').onclick=()=> {
    try {
      if(data.publicationPending) return
      if(data.archiveUrl) {
        const link=document.createElement('a'); link.href=data.archiveUrl; link.download=''; link.click()
        return
      }
      const chunks: Uint8Array[]=[]
      const archive=new zipper.Zip((error:Error|null,chunk:Uint8Array)=> { if(error) throw error; chunks.push(chunk) })
      for(const file of snapshot.files) {
        if(!file.path || /[\\:\0]/.test(file.path) || file.path.split('/').some((part:string)=>!part || part==='.' || part==='..')) throw new Error('无效的分享文件路径')
        const entry=new zipper.ZipPassThrough(file.path)
        if(Number.isSafeInteger(file.modifiedAt) && file.modifiedAt>=0) {
          const time=new Date(file.modifiedAt)
          if(time.getFullYear()>=1980 && time.getFullYear()<=2099) entry.mtime=time
        }
        archive.add(entry); entry.push(fileBytes(file),true)
      }
      const filename=(data.title || 'project').replace(/[\\/:*?"<>|\x00-\x1f]/g,'_').replace(/[. ]+$/g,'') || 'project'
      archive.end()
      const bytes=new Uint8Array(chunks.reduce((size,chunk)=>size+chunk.length,0))
      let offset=0
      for(const chunk of chunks) { bytes.set(chunk,offset); offset+=chunk.length }
      download(bytes,filename+'.zip')
    } catch(error:any) { say('下载失败：'+error.message) }
  }
  document.addEventListener('click',event=> { if(!menu.contains(event.target as Node)) closeMenu() })
  document.addEventListener('scroll',()=>closeMenu(),true)
  const mobile = () => window.matchMedia('(max-width: 650px)').matches
  const say = (message: string) => { status.textContent = message }
  if(data.publicationPending) {
    const downloadAll=$('download-all') as HTMLButtonElement
    downloadAll.disabled=true; downloadAll.textContent='下载全部（同步中）'
    say('入口已可阅读，其余分享文件正在同步。')
  }
  const uuid = () => crypto.randomUUID()
  const escape = (value: string) => value.replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!))
  const request = (mode: IDBTransactionMode, key: string, value?: unknown): Promise<any> => new Promise((resolve,reject) => {
    if (!db) { reject(new Error('浏览器本地存储不可用')); return }
    const tx = db.transaction('data', mode)
    const op = value === undefined ? tx.objectStore('data').get(key) : tx.objectStore('data').put(value, key)
    tx.oncomplete = () => resolve(op.result)
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('本地保存失败'))
  })
  const atomic = (writes: [string, unknown][], deletes: string[] = []): Promise<void> => new Promise((resolve,reject)=> {
    if(!db) { reject(new Error('浏览器本地存储不可用')); return }
    const tx=db.transaction('data','readwrite'), store=tx.objectStore('data')
    for(const [key,value] of writes) store.put(value,key)
    for(const key of deletes) store.delete(key)
    tx.oncomplete=()=>resolve()
    tx.onabort=tx.onerror=()=>reject(tx.error??new Error('本地保存失败'))
  })
  const save = (owner=draft, ownerNotes=notes, guard?: () => boolean, installed?: () => void): Promise<Readonly<DraftV2>> => {
    // Bind ownership now, but read that lineage's live contents when writing.
    // This retains in-flight input without crossing an asynchronous switch or
    // reviving pending after that lineage's durable submission completes.
    const operation=saving.catch(()=>{}).then(async()=> {
      if((!installed && ((drafts.get(prefix+'draft2:'+owner.lineageId)??draft)!==owner || owner===draft && ownerNotes!==notes)) || (guard && !guard())) throw Object.assign(Error('草稿身份已变化'), { staleDraft:true })
      const durable=structuredClone(owner), durableNotes=structuredClone(ownerNotes)
      await atomic([[prefix+'draft2:'+owner.lineageId,durable],[prefix+'draft2-notes:'+owner.lineageId,durableNotes]])
      installed?.()
      if(!installed) drafts.set(prefix+'draft2:'+owner.lineageId,owner)
      if(owner===draft) renderTree()
      return durable
    }).catch(error=> {if(!error?.staleDraft) {ready=false;render()}throw error})
    saving=operation.then(()=>{},()=>{})
    return operation
  }
  const saveMessage = (value: string) => {
    const initial=draft, lineage=initial.lineageId
    draft.message=value;labelOldDraft()
    // A description is a field edit, not permission to save a captured old
    // aggregate. Resolve its current identity inside the same FIFO slot.
    const operation=saving.catch(()=>{}).then(async()=> {
      const owner=drafts.get(prefix+'draft2:'+lineage)??initial
      owner.message=value
      await atomic([[prefix+'draft2:'+lineage,structuredClone(owner)]])
    }).catch(error=> {if(!error?.staleDraft) {ready=false;render()}throw error})
    saving=operation.then(()=>{},()=>{})
    return operation
  }
  const original = (filePath: string) => draft.base[filePath]?.markdown ?? (draft.snapshotId===snapshot.snapshotId ? files.get(filePath)?.markdown : undefined)
  const ensureBase = () => {
    if(draft.base[path]) return true
    if(draft.snapshotId!==snapshot.snapshotId) { say('此文件没有旧版本原文，无法加入旧草稿；请导出旧稿后在当前版本开始新草稿'); return false }
    const file=files.get(path)
    draft.base[path]={hash:file.hash,markdown:file.markdown}
    return true
  }
  const selector = (text: string, exact: string, start?: number, end?: number) => {
    if(start===undefined || end!==start+exact.length || text.slice(start,end)!==exact) {
      start=text.indexOf(exact)
      if(start<0 || text.indexOf(exact,start+1)>=0) return null
      end=start+exact.length
    }
    return {exact,start,end,prefix:text.slice(Math.max(0,start-32),start),suffix:text.slice(end,end!+32)}
  }
  const formNote = (note: any, base: DraftV2['base']) => {
    const source=base[note.path]?.markdown
    if(source===undefined) return undefined
    const anchor=selector(source,note.quote,note.start,note.end)
    return {annotation:{path:note.path,selector:anchor??{exact:note.quote},comment:note.comment,kind:'comment' as const},located:!!anchor}
  }
  // Local notes refer to their retained base. Wire selectors always refer to
  // this submission's text; an old offset is never evidence in changed text.
  const wireNote = (note: ProjectAnnotationV2, target: DraftV2) => {
    const source=target.base[note.path]?.markdown ?? (target.snapshotId===snapshot.snapshotId?files.get(note.path)?.markdown:undefined)
    if(typeof source!=='string' || typeof note.selector?.exact!=='string') return null
    const local=selector(source,note.selector.exact,note.selector.start,note.selector.end)
    if(!local) return null
    const text=target.after[note.path]??source
    if(text===source) return {...note,selector:{...note.selector,...local}}
    let found=-1, count=0, only=-1, matches=0
    for(let at=text.indexOf(local.exact);at>=0;at=text.indexOf(local.exact,at+1)) {
      count++;only=at
      if((local.prefix || local.suffix)
        && text.slice(Math.max(0,at-local.prefix.length),at)===local.prefix
        && text.slice(at+local.exact.length,at+local.exact.length+local.suffix.length)===local.suffix) {
        found=at;matches++
        if(matches>1) return null
      }
      if(at===text.length) break
    }
    // A unique quote in both texts is usable without ranking approximate
    // context. Duplicates require exactly one complete context match.
    if(matches!==1) {
      if(count!==1 || source.indexOf(local.exact)!==source.lastIndexOf(local.exact)) return null
      found=only
    }
    return {...note,selector:{...note.selector,...selector(text,local.exact,found,found+local.exact.length)!}}
  }
  const content = (target=draft, annotations=notes, strict=false) => ({
    snapshotId:target.snapshotId,
    edits:Object.entries(target.after).filter(([filePath,text])=>text!==target.base[filePath]?.markdown).map(([filePath,text])=>({path:filePath,baseHash:target.base[filePath]?.hash,afterMarkdown:text})),
    annotations:annotations.map(note=> {
      const mapped=wireNote(note,target)
      if(!mapped && strict) throw Error('批注无法在提交正文中唯一定位：'+note.path+'。请恢复对应正文，或在批注下点击“移除批注”后重新选文；批注仍已保留')
      return mapped??note
    }),
    message:target.message,
  })
  // The serialized runtime cannot import the Worker validator. Keep this
  // boundary aligned with protocol §6.3; validate the actual JSON wire object.
  const invalidV2 = (value: any): string | undefined => {
    const object=(v:any)=>v!==null && typeof v==='object' && !Array.isArray(v)
    const keys=(v:any,allowed:string[])=>object(v) && Object.keys(v).every(key=>allowed.includes(key))
    const optional=(v:any,key:string,check:(value:any)=>boolean)=>!Object.hasOwn(v,key) || check(v[key])
    const text=(v:any,max:number,min=0)=>typeof v==='string' && v.length>=min && v.length<=max
    const id=(v:any)=>typeof v==='string' && /^[a-zA-Z0-9_-]{1,128}$/.test(v)
    const relative=(v:any)=>typeof v==='string' && v.length>0 && !/^[\/]|[\\:\0]/.test(v) && v.split('/').every((part:string)=>part && part!=='.' && part!=='..')
    const offset=(v:any)=>Number.isSafeInteger(v) && v>=0
    if(!keys(value,['schemaVersion','project_id','snapshotId','submissionId','supersedes','rebasedFrom','message','contributor','client','edits','annotations'])
      || value.schemaVersion!==2 || !id(value.project_id) || !id(value.snapshotId) || !id(value.submissionId)
      || !optional(value,'supersedes',v=>id(v) && v!==value.submissionId)
      || !optional(value,'rebasedFrom',v=>id(v) && v!==value.snapshotId)) return '提交标识或格式无效，请导出备份'
    if(!optional(value,'contributor',v=>keys(v,['name','aiAssisted']) && optional(v,'name',n=>text(n,80) && !/\p{Cc}/u.test(n)) && optional(v,'aiAssisted',a=>typeof a==='boolean'))) return '署名最多 80 个 UTF-16 单位，且不能含控制字符，请修改署名'
    if(!optional(value,'message',v=>text(v,2000) && !v.includes('\0'))) return '说明最多 2000 个 UTF-16 单位，且不能含空字符，请修改说明'
    if(!optional(value,'client',v=>keys(v,['kind','version']) && optional(v,'kind',k=>['browser','browser-fallback','notemd'].includes(k)) && optional(v,'version',v=>text(v,32)))) return '客户端格式无效，请导出备份'
    if(!Array.isArray(value.edits) || value.edits.length>2000) return '修改文件不能超过 2000 项，请减少修改或导出备份'
    const seen=new Set<string>()
    for(const edit of value.edits) {
      if(!keys(edit,['path','baseHash','afterMarkdown']) || !relative(edit.path) || typeof edit.baseHash!=='string' || !/^[a-f0-9]{64}$/.test(edit.baseHash) || typeof edit.afterMarkdown!=='string' || seen.has(edit.path)) return '修改文件的路径、原文哈希或格式无效，请导出备份'
      seen.add(edit.path)
    }
    if(!Array.isArray(value.annotations) || value.annotations.length>2000) return '批注不能超过 2000 项，请移除部分批注'
    for(const note of value.annotations) {
      if(!keys(note,['path','selector','comment','kind']) || !relative(note.path) || !text(note.comment,10000,1) || !optional(note,'kind',k=>['comment','question','blocker'].includes(k))) return '批注评论须为 1–10000 个 UTF-16 单位，且格式有效；请移除该批注后重新添加'
      const anchor=note.selector
      if(!keys(anchor,['exact','prefix','suffix','start','end']) || !text(anchor.exact,2000)
        || !optional(anchor,'prefix',v=>text(v,64)) || !optional(anchor,'suffix',v=>text(v,64))
        || (!anchor.exact.length && !text(anchor.prefix,64,1) && !text(anchor.suffix,64,1))
        || !optional(anchor,'start',offset) || !optional(anchor,'end',offset)
        || (anchor.start!==undefined && anchor.end!==undefined && anchor.end-anchor.start!==anchor.exact.length)) return '批注选文最多 2000 个 UTF-16 单位，且定位格式须有效；请移除该批注后重新选文'
    }
  }
  const invalidFrozenV2 = (body: string) => {
    try { const value=JSON.parse(body);return value.schemaVersion===2?invalidV2(value):undefined } catch { return undefined }
  }
  const labelOldDraft = (sent=false) => {
    const label=oldDraftLabels.get(draft.lineageId)
    if(label) label.textContent=(sent?'你在旧版本上有已提交的草稿':'你在旧版本上有未提交的修改')+'（'+draft.snapshotId+'） '
  }
  const contentHash = async (value: any): Promise<string> => {
    // Legacy wire bytes remain frozen. Only this local comparison projection
    // converts trusted v1 anchors using the same transformation as migration.
    const legacyTarget=value.schemaVersion===1?{...draft,after:Object.fromEntries(value.edits.map((edit:any)=>[edit.path,edit.afterMarkdown]))}:undefined
    const annotations=legacyTarget?value.annotations.map((note:any)=> {
      const converted=formNote(note,draft.base)
      return converted?.located?(wireNote(converted.annotation,legacyTarget)??note):note
    }):value.annotations
    const bytes=new TextEncoder().encode(JSON.stringify({snapshotId:value.snapshotId,edits:value.edits,annotations,message:value.message}))
    const digest=await crypto.subtle.digest('SHA-256',bytes)
    return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('')
  }
  let lastVersionCheck = -Infinity
  const checkVersion = async (forced=false) => {
    if(!data.versionUrl || (!forced && Date.now()-lastVersionCheck<60000)) return
    lastVersionCheck=Date.now()
    try {
      const response=await fetch(data.versionUrl,{cache:'no-store'})
      if(response.status===410) {revoked=true;const panel=$('version-notice');panel.hidden=false;panel.textContent='分享已失效；草稿仍可编辑和导出';say('分享已失效；草稿仍可编辑和导出');render();return}
      if(!response.ok) return
      const version=await response.json()
      if(version.snapshotId && version.snapshotId!==snapshot.snapshotId) {
        const panel=$('version-notice');panel.hidden=false;panel.replaceChildren(document.createTextNode('分享者已发布新版本 '))
        const button=document.createElement('button');button.className='reader-button';button.textContent='刷新到新版本';button.onclick=()=>location.reload();panel.append(button)
      }
    } catch { /* Offline and old services do not discard local work. */ }
  }
  document.addEventListener('visibilitychange',()=> {if(document.visibilityState==='visible') void checkVersion()})
  const receipts = async () => {
    if(!token) return
    const panel=$('my-submissions'), list=$('receipts')
    const ids=submitted.slice(-20).reverse();panel.hidden=!ids.length;list.replaceChildren()
    let index=0
    await Promise.all(Array.from({length:Math.min(4,ids.length)},async()=> {
      while(index<ids.length) {
        const id=ids[index++], row=document.createElement('p');row.textContent=id+'：已送达，待处理';list.append(row)
        try {
          const response=await fetch(data.feedbackUrl+'/receipt/'+encodeURIComponent(id),{headers:{'X-Feedback-Token':token},cache:'no-store'})
          if(!response.ok) { if(response.status===403) row.textContent=id+'：权限不足'; if(response.status===410) row.textContent=id+'：分享已失效'; continue }
          const receipt=await response.json()
          if(receipt.submissionId && receipt.submissionId!==id) continue
          if(receipt.project_id && receipt.project_id!==snapshot.project_id) continue
          const accepted=(receipt.files??[]).reduce((n:number,file:any)=>n+file.accepted,0)
          const total=(receipt.files??[]).reduce((n:number,file:any)=>n+file.total,0)
          const label=receipt.outcome==='accepted' || receipt.outcome==='partial'?'已合入 '+accepted+'/'+total+' 处':({forwarded:'已转入团队评审',rejected:'未采纳',superseded:'已被你的新提交取代'} as Record<string,string>)[receipt.outcome]??'已送达，待处理'
          row.textContent=id+'：'+label+(typeof receipt.reply==='string'?'\n'+receipt.reply:'')
        } catch { /* A missing reply is still a delivered submission. */ }
      }
    }))
  }
  const normalize = (from: string, raw: string): {path:string; fragment:string} | null => {
    if (/^(\/|\\|[a-z][\w+.-]*:)/i.test(raw)) return null
    const [url, rawFragment=''] = raw.split('#', 2)
    let fragment = rawFragment
    try { fragment = decodeURIComponent(rawFragment) } catch { /* Preserve malformed fragments as literal IDs. */ }
    if(!url) return {path:from, fragment}
    let decoded: string
    try { decoded=decodeURIComponent(url.split('?')[0]) } catch { return null }
    if(decoded.startsWith('/') || /[\\:\0]/.test(decoded)) return null
    const parts=from.split('/').slice(0,-1)
    for(const part of decoded.split('/')) {
      if(!part || part==='.') continue
      if(part==='..') { if(!parts.length) return null; parts.pop() }
      else parts.push(part)
    }
    return {path:parts.join('/'), fragment}
  }
  const wiki = (target: string): string => {
    const resolved=normalize(path,target)
    if(!resolved) return ''
    if(files.has(resolved.path)) return resolved.path+(resolved.fragment?'#'+resolved.fragment:'')
    if(files.has(resolved.path+'.md')) return resolved.path+'.md'+(resolved.fragment?'#'+resolved.fragment:'')
    const title=target.split('#')[0].replace(/\.(md|markdown|mdown|mkd|mdx)$/i,'')
    const matches=docs.filter((file:any)=>file.path.split('/').pop().replace(/\.(md|markdown|mdown|mkd|mdx)$/i,'')===title)
    return matches.length===1 ? matches[0].path+(resolved.fragment?'#'+resolved.fragment:'') : ''
  }
  parser.use({extensions:[{
    name:'projectWiki', level:'inline', start(src:string) { return src.indexOf('[[') },
    tokenizer(src:string) { const match=/^!?\[\[([^\]\n]+)\]\]/.exec(src); return match ? {type:'projectWiki',raw:match[0],target:match[1].split('|')[0].trim(),label:match[1].split('|')[1]??match[1]} : undefined },
    renderer(node:any) { const wikiTarget=wiki(node.target); const target=wikiTarget ? '../'.repeat(path.split('/').length-1)+wikiTarget : ''; return target ? '<a data-project-path="'+escape(target)+'">'+escape(node.label)+'</a>' : '<span class="unshared">'+escape(node.label)+'（未共享引用）</span>' },
  }]})
  const sanitize = (html: string): DocumentFragment => {
    const template=document.createElement('template')
    template.innerHTML=html
    const allowed=new Set('P BR HR H1 H2 H3 H4 H5 H6 EM STRONG DEL S BLOCKQUOTE PRE CODE UL OL LI TABLE THEAD TBODY TR TH TD A IMG DETAILS SUMMARY SUP SUB DIV SPAN INPUT'.split(' '))
    for(const element of Array.from(template.content.querySelectorAll('*'))) {
      if(!allowed.has(element.tagName)) {
        if(['SCRIPT','STYLE','IFRAME','OBJECT','EMBED','SVG','MATH','FORM'].includes(element.tagName)) element.remove()
        else element.replaceWith(...Array.from(element.childNodes))
        continue
      }
      for(const attribute of Array.from(element.attributes)) {
        if(!['href','src','alt','title','data-project-path','type','checked','disabled','colspan','rowspan','start','align'].includes(attribute.name)) element.removeAttribute(attribute.name)
      }
      if(element.tagName==='INPUT') { element.setAttribute('type','checkbox'); element.setAttribute('disabled','') }
      if(element.tagName==='A') {
        const href=element.getAttribute('href')
        element.removeAttribute('href')
        if(href && /^https?:\/\//i.test(href)) { element.setAttribute('href',href); element.setAttribute('target','_blank'); element.setAttribute('rel','noopener noreferrer') }
        else if(href && /^(mailto:|tel:)/i.test(href)) element.setAttribute('href',href)
        else if(href) element.setAttribute('data-project-path',href)
        const raw=element.getAttribute('data-project-path')
        if(raw) {
          const resolved=normalize(path,raw)
          const file=resolved && files.get(resolved.path)
          if(file?.markdown !== undefined) {
            element.setAttribute('href','#doc='+encodeURIComponent(resolved!.path)+'&heading='+encodeURIComponent(resolved!.fragment))
          } else if(file?.dataUrl) {
            element.removeAttribute('data-project-path')
            element.setAttribute('href',file.dataUrl)
            element.setAttribute('download',resolved!.path.split('/').pop()!)
          } else { element.removeAttribute('data-project-path'); element.className='unshared'; element.append('（未共享引用）') }
        }
      }
      if(element.tagName==='IMG') {
        const src=element.getAttribute('src')??''
        const resolved=normalize(path,src)
        const file=resolved && files.get(resolved.path)
        if(file?.dataUrl && /^data:image\//i.test(file.dataUrl)) element.setAttribute('src',file.dataUrl)
        else if(!/^https?:\/\//i.test(src) && !/^data:image\/(png|jpeg|gif|webp|avif|bmp);base64,/i.test(src)) { element.removeAttribute('src'); element.setAttribute('alt','未共享图片') }
      }
    }
    return template.content
  }
  // Published HTML has already been sanitized by the host; retain generated SVG,
  // MathML and theme classes while resolving only the snapshot resource table.
  const publishedContent = (html: string): DocumentFragment => {
    const template=document.createElement('template')
    template.innerHTML=html
    for(const element of Array.from(template.content.querySelectorAll('[data-project-resource]'))) {
      const resource=files.get(element.getAttribute('data-project-resource')!)
      const image=element.tagName.toLowerCase()==='img' || element.tagName.toLowerCase()==='image'
      if(resource?.dataUrl && (!image || /^data:image\//i.test(resource.dataUrl))) {
        element.setAttribute(image && element.tagName.toLowerCase()==='img'?'src':'href',resource.dataUrl)
      } else {
        element.removeAttribute('src'); element.removeAttribute('href'); element.removeAttribute('xlink:href')
        if(image) element.setAttribute('alt','未共享图片')
      }
      element.removeAttribute('data-project-resource')
    }
    for(const element of Array.from(template.content.querySelectorAll('[data-project-path]'))) {
      const raw=element.getAttribute('data-project-path')!
      const separator=raw.indexOf('#')
      const target=separator<0?raw:raw.slice(0,separator)
      const heading=separator<0?'':raw.slice(separator+1)
      const file=files.get(target || path)
      if(file?.markdown!==undefined) element.setAttribute('href','#doc='+encodeURIComponent(target || path)+'&heading='+encodeURIComponent(heading))
      else if(file?.dataUrl) { element.setAttribute('href',file.dataUrl); element.setAttribute('download',target.split('/').pop()!) }
      else { element.removeAttribute('href'); element.classList.add('unshared'); element.append('（未共享引用）') }
      element.removeAttribute('data-project-path')
    }
    for(const element of Array.from(template.content.querySelectorAll('a[href^="#"]'))) {
      const href=element.getAttribute('href')!
      if(href.startsWith('#doc=')) continue
      let heading=href.slice(1)
      try { heading=decodeURIComponent(heading) } catch { /* Keep literal malformed heading IDs. */ }
      element.setAttribute('href','#doc='+encodeURIComponent(path)+'&heading='+encodeURIComponent(heading))
    }
    return template.content
  }
  const revealCurrent = () => {
    const parts=path.split('/').slice(0,-1)
    for(let index=1;index<=parts.length;index++) expanded.add(parts.slice(0,index).join('/'))
  }
  const treeForDraft = () => {
    const tree: any = {children:new Map<string,any>()}
    const missing=Object.keys(draft.base).filter(filePath=>!files.has(filePath)).map(path=>({path}))
    for(const file of [...docs,...missing]) {
      let parent=tree
      const parts=file.path.split('/')
      for(let index=0;index<parts.length;index++) {
        const nodePath=parts.slice(0,index+1).join('/')
        if(!parent.children.has(parts[index])) parent.children.set(parts[index],{name:parts[index],path:nodePath,folder:index<parts.length-1,children:new Map<string,any>(),modifiedAt:undefined})
        const node=parent.children.get(parts[index])
        const time=Number.isSafeInteger(file.modifiedAt) && file.modifiedAt>=0?file.modifiedAt:undefined
        if(time!==undefined && (node.modifiedAt===undefined || time>node.modifiedAt)) node.modifiedAt=time
        parent=node
      }
    }
    return tree
  }
  const icon = (folder:boolean): string => '<svg class="file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+(folder?'<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>':'<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>')+'</svg>'
  const setPanel = (open:boolean,restoreFocus=false) => {
    panel.hidden=!open
    $('file-backdrop').hidden=!open || !mobile()
    fileToggle.setAttribute('aria-expanded',String(open))
    fileToggle.setAttribute('aria-label',open?'收起文件导航':'展开文件导航')
    fileToggle.setAttribute('title',open?'收起文件导航':'展开文件导航')
    document.querySelector('.layout')!.classList.toggle('files-open',open)
    if(restoreFocus) fileToggle.focus()
  }
  const renderTree = () => {
    if(!handle && !loading) {badges.clear();for(const p of new Set([...Object.keys(draft.after),...notes.map(note=>note.path)])) badges.set(p,{changed:draft.after[p]!==undefined && draft.after[p]!==original(p),annotations:notes.filter(note=>note.path===p).length})}
    const tree=treeForDraft()
    const append = (parent:any,list:HTMLElement,depth:number) => {
      const nodes=Array.from(parent.children.values()) as any[]
      nodes.sort((a,b)=>Number(b.folder)-Number(a.folder) || (b.modifiedAt??-1)-(a.modifiedAt??-1) || a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
      for(const node of nodes) {
        if(($('changed-only') as HTMLInputElement | null)?.checked && !node.folder && !badges.get(node.path)?.changed && !badges.get(node.path)?.annotations) continue
        const item=document.createElement('li')
        const button=document.createElement('button')
        button.className='file-row'; button.style.paddingLeft=(8+depth*14)+'px'; button.title=node.name
        button.innerHTML=(node.folder?'<svg class="chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>':'<span class="chevron"></span>')+icon(node.folder)
        const label=document.createElement('span'); label.className='file-label'; label.textContent=node.name+(!node.folder && !files.has(node.path)?'（旧版本）':''); button.append(label)
        if(!node.folder) { const badge=badges.get(node.path); if(badge?.changed || badge?.annotations) { const mark=document.createElement('span');mark.className='file-badge';mark.textContent=(badge.changed?'● ':'')+(badge.annotations?String(badge.annotations):'');button.append(mark) } }
        if(node.folder) {
          button.setAttribute('data-folder',node.path); button.setAttribute('aria-expanded',String(expanded.has(node.path)))
          const children=document.createElement('ul'); children.hidden=!expanded.has(node.path)
          button.onclick=()=> {
            const open=!expanded.has(node.path)
            if(open) expanded.add(node.path); else expanded.delete(node.path)
            button.setAttribute('aria-expanded',String(open)); children.hidden=!open
          }
          item.append(button,children); append(node,children,depth+1)
        } else {
          button.setAttribute('data-file',node.path)
          if(files.has(node.path)) {
            button.setAttribute('aria-haspopup','menu')
            button.oncontextmenu=event=>openMenu(event,button,node.path)
            button.onkeydown=event=> { if(event.key==='ContextMenu' || (event.key==='F10' && event.shiftKey)) openMenu(event,button,node.path) }
          }
          if(node.path===path) button.setAttribute('aria-current','page')
          button.onclick=()=> {
            const params=new URLSearchParams(location.hash.slice(1)); params.set('doc',node.path); params.delete('heading')
            history.pushState(null,'','#'+params.toString()); navigate()
            if(mobile()) { setPanel(false); (editing?editor:article).focus() }
            else (Array.from($('files').querySelectorAll('[data-file]')).find(row=>row.getAttribute('data-file')===node.path) as HTMLElement|undefined)?.focus()
          }
          item.append(button)
        }
        list.append(item)
      }
    }
    $('files').replaceChildren(); append(tree,$('files'),0)
  }
  const currentText = () => state.drafts[path] ?? original(path) ?? files.get(path)?.markdown ?? ''
  const comments = () => {
    $('comments').replaceChildren()
    for(const item of state.annotations.filter((item:any)=>item.path===path)) {
      const block=document.createElement('blockquote'); block.textContent=item.selector.exact+'\n'+item.comment
      const remove=document.createElement('button');remove.className='reader-button';remove.textContent='移除批注';remove.disabled=busy || !!transitioning
      remove.onclick=async()=> {
        if(busy || transitioning || !notes.includes(item)) return
        notes.splice(notes.indexOf(item),1);labelOldDraft();comments()
        try {await save();say('批注已移除；待确认的原包仍保持不变')} catch(error:any) {say('批注修改未保存：'+error.message+'；请导出备份')}
      }
      block.append(remove);$('comments').append(block)
    }
  }
  const render = () => {
    editor.value=currentText()
    const publishedOriginal=(baseline?original(path):currentText())===files.get(path)?.markdown
    const published=data.presentation?.documents[path]
    $('reader').setAttribute('data-theme',data.presentation?.themeId??'')
    article.setAttribute('data-theme',data.presentation?.themeId??'')
    article.replaceChildren(publishedOriginal && published!==undefined ? publishedContent(published) : sanitize(parser.parse(baseline?(original(path)??files.get(path)?.markdown??''):currentText(),{async:false,breaks:true})))
    if(!(publishedOriginal && published!==undefined)) {
      const headings=new Map<string,number>()
      for(const heading of Array.from(article.querySelectorAll('h1,h2,h3,h4,h5,h6'))) {
        const slug=(heading.textContent??'').trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu,'').replace(/\s+/g,'-') || 'heading'
        const count=headings.get(slug)??0; headings.set(slug,count+1); heading.id=slug+(count?'-'+count:'')
      }
      if(!publishedOriginal && /^ {0,3}(`{3,}|~{3,})(mermaid|dot|graphviz|circo|neato|fdp|sfdp|twopi)\b/im.test(currentText())) {
        const hint=document.createElement('p'); hint.className='draft-diagram-note'; hint.textContent='草稿图表显示源代码；主人合入并重新发布后完整渲染。'; article.prepend(hint)
      }
    }
    editor.hidden=!editing || !!handle
    enhanced.hidden=!editing || !handle
    article.hidden=editing
    editButton.textContent=editing?'预览':'编辑 Markdown'
    $('baseline').textContent=baseline?'查看我的修改':'查看发布原文'
    document.title=data.title+' · '+(token?'可编辑':'只读')
    $('collaboration').hidden=!token
    editButton.disabled=!token || !initialized || !!loading || (draft.snapshotId!==snapshot.snapshotId && !draft.base[path])
    ;($('baseline') as HTMLButtonElement).disabled=!token || !initialized || !!loading
    ;($('export') as HTMLButtonElement).disabled=!token || !initialized
    ;(name as HTMLInputElement).disabled=!token || !initialized
    submit.disabled=!token || !ready || busy || revoked
    ;($('annotate') as HTMLButtonElement).disabled=!token || !initialized || !!transitioning
    if(token && initialized && draft.snapshotId!==snapshot.snapshotId && !draft.base[path]) say('此文件没有旧版本原文，无法加入旧草稿；请导出备份后刷新到当前版本')
    correctRejected.hidden=!rejectedPending || rejectedPending!==draft.pending
    correctRejected.disabled=busy || !ready
    continueCurrent.hidden=!initialized || draft.snapshotId===snapshot.snapshotId || oldDraftLabels.has(draft.lineageId)
    continueCurrent.disabled=busy || !token
    if(!continueCurrent.hidden) $('old-drafts').hidden=false
    comments()
  }
  let navigating=Promise.resolve(), mounting=false
  const navigate = () => {
    const params=new URLSearchParams(location.hash.slice(1)), target=params.get('doc')
    if(handle && target && target!==path && (files.get(target)?.markdown!==undefined || draft.base[target])) {
      const current=handle
      navigating=navigating.catch(()=>{}).then(async()=> {
        if(current!==handle) return
        try { await current.switchFile(target); if(current===handle) {path=target;renderNavigation()} }
        catch { say('切换前保存失败，当前编辑已保留；请重试或导出') }
      }); return
    }
    renderNavigation()
  }
  const renderNavigation = () => {
    const params=new URLSearchParams(location.hash.slice(1))
    const target=params.get('doc')
    if(!handle && !mounting && target && (files.get(target)?.markdown!==undefined || draft.base[target])) path=target
    revealCurrent(); renderTree(); render()
    const heading=params.get('heading')
    if(heading) Array.from(article.querySelectorAll('[id]')).find(element=>element.id===heading)?.scrollIntoView?.()
  }
  fileToggle.onclick=()=> { setPanel(panel.hidden); if(!panel.hidden) (panel.querySelector('[aria-current="page"]') as HTMLElement|null)?.focus() }
  $('file-backdrop').onclick=()=>setPanel(false,true)
  window.addEventListener('resize',()=> { setPanel(!panel.hidden); closeMenu() })
  document.addEventListener('keydown',event=> {
    if(event.key!=='Escape') return
    if(!menu.hidden) { event.preventDefault(); closeMenu(true) }
    else if(!panel.hidden) { event.preventDefault(); setPanel(false,true) }
  })
  let mermaidLoading: Promise<{render(code:string, appearance:import('../../share-editor/contract').ShareMermaidAppearance):Promise<string>}> | undefined
  const loadMermaid: NonNullable<ShareEditorHost['loadMermaid']> = () => {
    if(mermaidLoading) return mermaidLoading
    const resource=data.editorKit?.mermaid
    mermaidLoading=new Promise((resolve,reject)=> {
      if(!resource || new URL(resource.url).origin!==location.origin || !/^sha384-[A-Za-z0-9+/=]+$/.test(resource.integrity)) {reject(Error('图表资源不可用'));return}
      const script=document.createElement('script')
      const timer=setTimeout(()=>fail(),15000)
      const fail=()=> {clearTimeout(timer);script.remove();reject(Error('图表加载失败，源码已保留'))}
      script.src=resource.url;script.integrity=resource.integrity;script.crossOrigin='anonymous'
      script.onerror=fail;script.onload=()=> {
        clearTimeout(timer)
        const module=(globalThis as typeof globalThis & {NotemdShareMermaid?:Awaited<ReturnType<NonNullable<ShareEditorHost['loadMermaid']>>>}).NotemdShareMermaid
        if(!module || typeof module.render!=='function') {fail();return}
        resolve(module)
      }
      document.head.append(script)
    })
    mermaidLoading.catch(()=> {mermaidLoading=undefined})
    return mermaidLoading
  }
  const hostFor = (owner: DraftV2, ownerNotes: ProjectAnnotationV2[]): ShareEditorHost => ({
    apiVersion:1, snapshot, theme:{themeId:data.presentation?.themeId??''},
    ...(data.editorKit?.mermaid ? {loadMermaid} : {}),
    loadDraft:async()=>owner,
    loadAnnotations:async()=>structuredClone(ownerNotes),
    saveDraft:live=> save(live,ownerNotes,()=>live===owner && owner===draft),
    transitionDraft:async(expected,next,noteChange)=> {
      const explicitNotes=!!noteChange
      noteChange??={expectedAnnotations:structuredClone(ownerNotes),annotations:structuredClone(ownerNotes)}
      const valid=()=> {
        if(expected!==owner || owner!==draft || next.lineageId!==owner.lineageId || owner.pending || next.pending) return false
        if(Object.keys(next).some(key=>!['v','lineageId','snapshotId','base','after','editorFiles','annotationKinds','message','lastSubmissionId','rebasedFrom','previous','rebaseRecovery'].includes(key))) return false
        if(!noteChange || JSON.stringify(noteChange.expectedAnnotations)!==JSON.stringify(ownerNotes) || !Array.isArray(noteChange.annotations) || noteChange.annotations.length>2000) return false
        const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b)
        const object=(value:any):value is Record<string,any> => !!value && typeof value==='object' && !Array.isArray(value)
        const keys=(value:any,allowed:string[]) => object(value) && Object.keys(value).every(key=>allowed.includes(key))
        const strings=(value:any) => object(value) && Object.values(value).every(item=>typeof item==='string')
        const kinds=(value:any) => object(value) && Object.values(value).every(item=>['comment','question','blocker'].includes(item as string))
        const bases=(value:any) => object(value) && Object.values(value).every(base=>keys(base,['hash','markdown']) && typeof (base as any).hash==='string' && typeof (base as any).markdown==='string')
        const annotations=(value:any) => Array.isArray(value) && value.length<=2000 && value.every(note=>keys(note,['path','selector','comment','kind'])
          && typeof note.path==='string' && typeof note.comment==='string' && (note.kind===undefined || ['comment','question','blocker'].includes(note.kind))
          && keys(note.selector,['exact','prefix','suffix','start','end']) && typeof note.selector.exact==='string'
          && ['prefix','suffix'].every(key=>note.selector[key]===undefined || typeof note.selector[key]==='string')
          && ['start','end'].every(key=>note.selector[key]===undefined || Number.isSafeInteger(note.selector[key]) && note.selector[key]>=0))
        const previous=(value:any) => keys(value,['snapshotId','base','after','annotationKinds','rebasedFrom','annotations']) && typeof value.snapshotId==='string'
          && bases(value.base) && strings(value.after) && (value.annotationKinds===undefined || kinds(value.annotationKinds))
          && (value.rebasedFrom===undefined || typeof value.rebasedFrom==='string') && (value.annotations===undefined || annotations(value.annotations))
        const draftFields=(value:DraftV2) => value.v===2 && kinds(value.annotationKinds)
          && ['message','lastSubmissionId','rebasedFrom'].every(key=>(value as any)[key]===undefined || typeof (value as any)[key]==='string')
          && (value.editorFiles===undefined || object(value.editorFiles) && Object.entries(value.editorFiles).every(([path,file])=>Object.hasOwn(value.base,path)
            && keys(file,['v','sourceHash','sourceRevision','bindings']) && file.v===1 && typeof file.sourceHash==='string' && Number.isSafeInteger(file.sourceRevision) && file.sourceRevision>=0
            && Array.isArray(file.bindings) && file.bindings.every(row=>keys(row,['rootOrdinal','id']) && Number.isSafeInteger(row.rootOrdinal) && row.rootOrdinal>=0 && typeof row.id==='string')))
        if(!draftFields(next)) return false
        const prior=next.previous
        if(prior && !previous(prior)) return false
        const matchesPrevious=(prior:any,target:DraftV2,annotations:readonly ProjectAnnotationV2[]) => previous(prior) && prior.snapshotId===target.snapshotId
          && same(prior.base,target.base) && same(prior.after,target.after) && same(prior.annotationKinds??{},target.annotationKinds)
          && prior.rebasedFrom===target.rebasedFrom && same(prior.annotations??[],annotations)
        const publicBase=(value:DraftV2) => bases(value.base) && strings(value.after)
          && Object.entries(value.base).every(([path,base])=>snapshot.files.some((file:any)=>file.path===path && file.hash===base.hash && file.markdown===base.markdown))
          && Object.keys(value.after).every(path=>Object.hasOwn(value.base,path))
        const forward=next.snapshotId===snapshot.snapshotId && !expected.previous && matchesPrevious(prior,expected,explicitNotes?ownerNotes:prior?.annotations??[])
        const reverse=expected.previous?.snapshotId===next.snapshotId && !next.previous && matchesPrevious(expected.previous,next,explicitNotes?noteChange.annotations:expected.previous.annotations??[])
        const cleared={...expected};delete cleared.rebaseRecovery
        const clearRecovery=!!expected.rebaseRecovery && !next.rebaseRecovery && same(cleared,next) && same(noteChange.annotations,ownerNotes)
        if(!forward && !reverse && !clearRecovery) return false
        if(explicitNotes && forward && noteChange.annotations.length) return false
        if(forward && !publicBase(next)) return false
        const recovery=next.rebaseRecovery
        if(recovery) {
          const candidate=recovery.candidate, publicSnapshot=recovery.snapshot
          const expectedCandidate={...expected};delete expectedCandidate.rebaseRecovery;delete expectedCandidate.pending
          if(!keys(recovery,['snapshot','candidate']) || !keys(publicSnapshot,['schemaVersion','project_id','snapshotId','entry','files'])
            || !same(publicSnapshot,snapshot) || !Array.isArray(publicSnapshot.files)
            || publicSnapshot.files.some(file=>!keys(file,['path','hash','markdown','dataUrl','bytes','modifiedAt']))
            || !keys(candidate,['v','lineageId','snapshotId','base','after','editorFiles','annotationKinds','message','lastSubmissionId','rebasedFrom','previous'])
            || !draftFields(candidate) || candidate.lineageId!==next.lineageId || candidate.snapshotId!==snapshot.snapshotId
            || !publicBase(candidate) || !matchesPrevious(candidate.previous,next,noteChange.annotations)
            || !same(candidate,expectedCandidate)) return false
        }
        return true
      }
      const nextNotes=structuredClone([...noteChange.annotations])
      transitioning++;comments();($('annotate') as HTMLButtonElement).disabled=true
      try { return await save(next,nextNotes,valid,()=> {owner=next;draft=next;ownerNotes=nextNotes;notes=nextNotes;drafts.set(prefix+'draft2:'+next.lineageId,next)}) }
      finally {transitioning--;comments();($('annotate') as HTMLButtonElement).disabled=!token || !initialized || !!transitioning}
    },
    submit:async(body,id)=> {
      const pending=durablePending.get(owner.lineageId)
      if(!ready || owner!==draft || pending?.body!==body || pending?.submissionId!==id || owner.pending?.body!==body || owner.pending.submissionId!==id) throw Error('提交尚未完成本机保存')
      await checkVersion(true)
      if(revoked) return {ok:false,status:410,message:'分享已失效'}
      const response=await fetch(data.feedbackUrl,{method:'POST',headers:{'Content-Type':'application/json','X-Feedback-Token':token},body})
      if(!response.ok) return {ok:false,status:response.status,message:'HTTP '+response.status}
      await response.json();return {ok:true}
    },
    notify:say,
    openFile:next=> {const params=new URLSearchParams(location.hash.slice(1));params.set('doc',next);params.delete('heading');history.pushState(null,'','#'+params.toString());navigate()},
    setFileBadges:rows=> {if(owner!==draft)return;badges.clear();for(const row of rows)badges.set(row.path,row);renderTree()},
  })
  const loadEditor = (): Promise<void> => {
    if(loading) return loading
    if(handle || !data.editorKit) return Promise.resolve()
    const owner=draft, ownerNotes=notes, epoch=++loadEpoch, kit=data.editorKit
    loading=(async()=> {
      const script=document.createElement('script'), css=document.createElement('link')
      let timer: ReturnType<typeof setTimeout> | undefined, rejectLoad: (error:Error)=>void=()=>{}
      const dispose=()=> {clearTimeout(timer);script.onload=script.onerror=css.onload=css.onerror=null;script.remove();css.remove()}
      cancelLoad=()=> {rejectLoad(Error('cancelled'));dispose()}
      try {
        await new Promise<void>((resolve,reject)=> {
          rejectLoad=reject;let loaded=0
          const done=()=> {if(++loaded===2)resolve()}
          script.onload=css.onload=done;script.onerror=css.onerror=()=>reject(Error('kit-unavailable'))
          timer=setTimeout(()=>reject(Error('kit-timeout')),15000)
          if(new URL(kit.js.url).origin!==location.origin || new URL(kit.css.url).origin!==location.origin) {reject(Error('kit-origin'));return}
          css.rel='stylesheet';css.href=kit.css.url;css.integrity=kit.css.integrity;css.crossOrigin='anonymous'
          script.src=kit.js.url;script.integrity=kit.js.integrity;script.crossOrigin='anonymous'
          document.head.append(css,script)
        })
        clearTimeout(timer);script.onload=script.onerror=css.onload=css.onerror=null
        const module=(globalThis as typeof globalThis & {NotemdShareEditor?:ShareEditorModule}).NotemdShareEditor
        if(epoch!==loadEpoch || owner!==draft || !editing) {dispose();return}
        if(module?.apiVersion!==1) throw Error('kit-version')
        const host=hostFor(owner,ownerNotes)
        mounting=true
        const mounted=await module.mount(enhanced,host,{path})
        while(epoch===loadEpoch && owner===draft && editing) {
          const params=new URLSearchParams(location.hash.slice(1)), target=params.get('doc')
          if(!target || target===path || !(files.get(target)?.markdown!==undefined || draft.base[target])) break
          try { await mounted.switchFile(target); path=target }
          catch {
            params.set('doc',path);params.delete('heading');history.replaceState(null,'','#'+params.toString())
            say('切换前保存失败，当前编辑已保留；请重试或导出');break
          }
        }
        if(epoch!==loadEpoch || owner!==draft || !editing) {await mounted.destroy();dispose();return}
        handle=mounted;editorHost=host;renderNavigation()
      } catch (error:any) {
        dispose()
        if(epoch===loadEpoch && owner===draft) {const params=new URLSearchParams(location.hash.slice(1));params.set('doc',path);params.delete('heading');history.replaceState(null,'','#'+params.toString());say('增强编辑器不可用，已切换到基础编辑'+(error?.unsavedDraft?'；草稿未保存，输入仍保留，请重试或导出':''));render();editor.focus()}
      } finally {mounting=false;if(epoch===loadEpoch) {loading=undefined;cancelLoad=()=>{};render()}}
    })()
    return loading
  }
  const continueDraft = async () => {
    if(busy || !token || !initialized) return
    if(draft.pending) {say('请先发送或导出冻结提交包，再迁移版本');return}
    editing=true;baseline=false;render();await loadEditor()
    if(!handle) {say('迁移需要增强编辑器；旧草稿已保留，可导出备份');return}
    busy=true;render()
    try { const result=await handle.rebase(snapshot,draft);if(result.status==='applied') {restoredContentHash=await contentHash(content());say('已迁移到新版本；提交后才能开始下一次迁移')} }
    catch(error:any) {say('迁移未完成：'+error.message)}
    finally {busy=false;render()}
  }
  continueCurrent.onclick=continueDraft
  editButton.onclick=async()=> {
    if(!token || !initialized) return
    if(editing && handle) {try {await handle.buildSubmission({})} catch {say('预览前保存失败，当前编辑已保留');return}}
    editing=!editing;baseline=false
    if(!editing && loading) {++loadEpoch;cancelLoad();loading=undefined}
    render();if(editing) {if(!handle) editor.focus();const pending=loadEditor();render();await pending}
  }
  $('changed-only')?.addEventListener('change',renderTree)
  $('baseline').onclick=async()=> { if(editing && handle) {try {await handle.buildSubmission({})} catch {say('预览前保存失败，当前编辑已保留');return}} baseline=!baseline; editing=false;if(loading){++loadEpoch;cancelLoad();loading=undefined} render() }
  editor.oninput=()=> {
    if(!ensureBase()) { render(); return }
    state.drafts[path]=editor.value
    delete draft.editorFiles?.[path]
    labelOldDraft()
    say('正在保存草稿…')
    void save().then(()=> {if(!busy && !revoked && status.textContent==='正在保存草稿…') say('草稿已保存到本浏览器')}).catch(error=>say('草稿未保存：'+error.message+'；请导出备份'))
  }
  $('annotate').onclick=async()=> {
    if(!baseline && currentText()!==(original(path)??files.get(path)?.markdown??'')) { say('标注基于发布时的原文；请先点击“查看发布原文”再选文'); return }
    if(!token || !initialized || transitioning) return
    const selection=window.getSelection()
    if(editing || !selection?.rangeCount || Array.from({length:selection.rangeCount},(_,index)=>selection.getRangeAt(index)).some(range=>!article.contains(range.startContainer) || !article.contains(range.endContainer))) { say('请在发布原文的正文中选中要标注的文字'); return }
    const quote=selection.toString()
    if(!quote) { say('请先选中要标注的文字'); return }
    if(quote.length>2000) {say('批注选文最多 2000 个 UTF-16 单位，请缩短选文');return}
    if(notes.length>=2000) {say('批注不能超过 2000 项，请先移除部分批注');return}
    const comment=window.prompt('评论')
    if(!comment?.trim()) return
    if(comment.trim().length>10000) {say('批注评论最多 10000 个 UTF-16 单位，请缩短评论后重新添加');return}
    if(!ensureBase()) return
    const anchor=selector(original(path)!,quote)
    if(!anchor) { say('选文在原文中存在多处或无法定位，请选择唯一的原文片段');return }
    state.annotations.push({path,selector:anchor,comment:comment.trim(),kind:'comment'})
    labelOldDraft()
    comments()
    try { await save(); say('标注已保存到本浏览器') } catch(error:any) { say('标注未保存：'+error.message+'；请导出备份') }
  }
  $('export').onclick=()=> {
    const blob=new Blob([JSON.stringify({project_id:snapshot.project_id,draft,annotations:notes,legacy:Array.from(legacy.entries()),rejected:Array.from(rejectedBodies.entries())},null,2)],{type:'application/json'})
    const url=URL.createObjectURL(blob); const a=document.createElement('a');a.href=url;a.download='project-draft.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)
  }
  name.oninput=()=> { void request('readwrite',prefix+'nickname',name.value).catch(()=>say('署名未保存；草稿仍可导出')) }
  ;($('message') as HTMLInputElement).oninput=()=> {void saveMessage(($('message') as HTMLInputElement).value).catch(error=>say('说明未保存：'+error.message))}
  const correctRejected=document.createElement('button');correctRejected.id='correct-rejected';correctRejected.className='reader-button';correctRejected.textContent='纠正已拒收的提交';correctRejected.hidden=true;status.after(correctRejected)
  correctRejected.onclick=async()=> {
    const pending=draft.pending
    if(busy || !ready || !pending || rejectedPending!==pending || !invalidFrozenV2(pending.body)) return
    busy=true;render()
    try {
      saving=saving.catch(()=>{}).then(async()=> {
        const next=structuredClone(draft);delete next.pending
        // One immutable rejected body per lineage, replaced only by another
        // explicit correction. The export includes this recovery copy.
        await atomic([[draftKey(),next],[notesKey(),structuredClone(notes)],[prefix+'draft2-rejected:'+draft.lineageId,pending]])
        delete draft.pending;durablePending.delete(draft.lineageId);rejectedBodies.set(draft.lineageId,pending);rejectedPending=undefined
      }).catch(error=>{ready=false;throw error})
      await saving;say('已解除冻结，原拒收包已保留供导出；请纠正输入后提交')
    } catch(error:any) {say('纠正未保存：'+error.message+'；原包仍保留')}
    finally {busy=false;render()}
  }
  submit.onclick=async()=> {
    if(busy || !ready || !token || revoked) return
    const owner=draft, ownerNotes=notes, ownerSnapshot=owner.snapshotId
    busy=true;render()
    try {
      await checkVersion(true)
      if(revoked) return
      let pending=owner.pending
      if(!pending) {
        let body: string, submissionId: string
        if(handle) {
          await navigating
          const result=await handle.buildSubmission({message:owner.message,name:name.value,aiAssisted:($('ai-assisted') as HTMLInputElement | null)?.checked??false})
          if(owner!==draft || owner.snapshotId!==ownerSnapshot) throw Error('草稿已切换，本次提交已取消')
          const payload=JSON.parse(result.body)
          const clean={...owner,after:{...Object.fromEntries(Object.entries(owner.base).map(([p,b])=>[p,b.markdown])),...Object.fromEntries(payload.edits.map((e:any)=>[e.path,e.afterMarkdown]))}}
          payload.annotations.push(...content(clean,ownerNotes,true).annotations)
          body=JSON.stringify(payload);submissionId=result.submissionId
        } else {
          const guestCritic=Object.entries(owner.after).some(([p,raw])=> {
            const base=owner.base[p]?.markdown??''
            if(raw===base || !/\{>>|\{==/.test(raw)) return false
            // Old direct callers without the scanner must fail closed for Critic.
            if(!scanCritic) return true
            const remaining=new Map<string,number>()
            for(const row of scanCritic(base)) remaining.set(row.raw,(remaining.get(row.raw)??0)+1)
            return scanCritic(raw).some(row=> {const count=remaining.get(row.raw)??0;if(count)remaining.set(row.raw,count-1);return !count})
          })
          if(guestCritic) throw Error('增强批注草稿已保留；请恢复增强编辑器或导出备份后提交')
          const candidate=content(owner,ownerNotes,true)
          submissionId=uuid()
          body=JSON.stringify({schemaVersion:2,project_id:snapshot.project_id,...candidate,submissionId,client:{kind:'browser-fallback'},contributor:{name:name.value,aiAssisted:($('ai-assisted') as HTMLInputElement | null)?.checked??false},supersedes:owner.lastSubmissionId,rebasedFrom:owner.rebasedFrom})
        }
        const payload=JSON.parse(body)
        if(!payload.edits.length && !payload.annotations.length) {say('没有新的修改或标注');return}
        const invalid=invalidV2(payload)
        if(invalid) {say(invalid);return}
        if(new TextEncoder().encode(body).byteLength>5*1024*1024) {say('修改包超过 5 MiB，请导出备份并联系主人');return}
        const hash=await contentHash(payload)
        if(owner!==draft || owner.snapshotId!==ownerSnapshot) throw Error('草稿已切换，本次提交已取消')
        if(sentMarker?.submissionId===owner.lastSubmissionId && sentMarker?.contentHash===hash) {say('没有新的修改或标注');return}
        if(owner.lastSubmissionId && !sentMarker && restoredContentHash===hash) {say('已有提交，但缺少本机内容记录；请编辑后再提交或导出备份');return}
        pending={submissionId,body}
        const frozen=pending
        const operation=saving.catch(()=>{}).then(async()=> {
          if(owner!==draft || owner.snapshotId!==ownerSnapshot) throw Error('草稿已切换，本次提交已取消')
          const next=structuredClone(owner);next.pending=frozen
          await atomic([[prefix+'draft2:'+owner.lineageId,next],[prefix+'draft2-notes:'+owner.lineageId,structuredClone(ownerNotes)]])
          owner.pending=frozen;durablePending.set(owner.lineageId,frozen)
        }).catch(error=>{ready=false;throw error})
        saving=operation.then(()=>{},()=>{});await operation
      }
      say('提交中…')
      const response=await (editorHost??hostFor(owner,ownerNotes)).submit(pending.body,pending.submissionId)
      if(!response.ok) {
        const invalid=response.status===400?invalidFrozenV2(pending.body):undefined
        if(invalid) {rejectedPending=pending;say('已明确拒收（HTTP 400）：'+invalid+'。点击“纠正已拒收的提交”解除冻结；原包仍保留');return}
        throw new Error(response.message)
      }
      const marker={submissionId:pending.submissionId,contentHash:await contentHash(JSON.parse(pending.body))}
      const markDelivered = (target: DraftV2) => {
        target.lastSubmissionId=pending!.submissionId
        if(target.pending?.submissionId===pending!.submissionId && target.pending.body===pending!.body) delete target.pending
        delete target.previous
        delete target.rebaseRecovery
      }
      const operation=saving.catch(()=>{}).then(async()=> {
        const next=structuredClone(owner)
        const nextSubmitted=[...submitted.filter(id=>id!==pending!.submissionId),pending!.submissionId].slice(-200)
        markDelivered(next)
        await atomic([[prefix+'draft2:'+owner.lineageId,next],[prefix+'draft2-notes:'+owner.lineageId,structuredClone(ownerNotes)],[prefix+'draft2-sent:'+owner.lineageId,marker],[prefix+'submitted',nextSubmitted]])
        markDelivered(owner);durablePending.delete(owner.lineageId);submitted=nextSubmitted;sentMarker=marker
      }).catch(error=> {ready=false;throw error})
      saving=operation.then(()=>{},()=>{});await operation
      labelOldDraft(marker.contentHash===await contentHash(content()))
      $('my-submissions').hidden=false
      const row=document.createElement('p');row.textContent=pending.submissionId+'：已送达，待处理';$('receipts').prepend(row)
      say('已送达，等待主人审阅；页面正文需主人重新发布后更新')
    } catch(error:any) {say(owner.pending?'结果未知或未送达：'+error.message+'；草稿已保留，点击提交重试原包':'无法提交：'+error.message)}
    finally {busy=false;render()}
  }
  window.addEventListener('hashchange',navigate)
  window.addEventListener('popstate',navigate)
  navigate()
  try {
    db=await new Promise<IDBDatabase>((resolve,reject)=> {
      const op=indexedDB.open('notemd-project-sharing',1)
      op.onupgradeneeded=()=>op.result.createObjectStore('data')
      op.onsuccess=()=>resolve(op.result)
      op.onerror=()=>reject(op.error)
      op.onblocked=()=>reject(new Error('本地存储被其他窗口阻塞'))
    })
    const params=new URLSearchParams(location.hash.slice(1))
    const provided=providedToken
    if(provided) {
      token=provided
      await request('readwrite',snapshot.project_id+':token',token)
      params.delete('feedback')
      history.replaceState(null,'',location.pathname+location.search+(params.size?'#'+params.toString():''))
    } else token=await request('readonly',snapshot.project_id+':token') ?? ''
    const keys: IDBValidKey[]=await new Promise((resolve,reject)=> {
      const tx=db!.transaction('data','readonly'),op=tx.objectStore('data').getAllKeys()
      tx.oncomplete=()=>resolve(op.result);tx.onerror=()=>reject(tx.error)
    })
    for(const rawKey of keys) {
      const key=String(rawKey)
      if(!key.startsWith(prefix)) continue
      const value=await request('readonly',key)
      if(key.startsWith(prefix+'draft2-rejected:')) rejectedBodies.set(key.slice((prefix+'draft2-rejected:').length),value)
      else if(key.startsWith(prefix+'draft2:') && value?.v===2) drafts.set(key,value)
      else if(value?.drafts && Array.isArray(value.annotations)) {
        if(key===prefix+snapshot.snapshotId) {
          legacy.set(key,value)
          const migrated=fresh(), annotations: ProjectAnnotationV2[]=[]
          for(const [filePath,text] of Object.entries(value.drafts)) {
            const file=files.get(filePath)
            if(!file || typeof file.markdown!=='string') throw new Error('旧草稿文件原文不可用，原草稿已保留')
            migrated.base[filePath]={hash:file.hash,markdown:file.markdown};migrated.after[filePath]=text as string
          }
          for(const note of value.annotations) {
            const file=files.get(note.path)
            if(!file || typeof file.markdown!=='string') throw new Error('旧批注原文不可用，原草稿已保留')
            migrated.base[note.path]={hash:file.hash,markdown:file.markdown}
            // Ambiguous legacy quotes retain exact text without invented offsets.
            annotations.push(formNote(note,migrated.base)!.annotation)
          }
          if(value.pending && !value.pending.delivered) {
            const body=value.pending.body??(value.pending.payload?JSON.stringify(value.pending.payload):undefined)
            if(body) migrated.pending={submissionId:JSON.parse(body).submissionId,body}
          }
          if(value.pending?.delivered) {
            migrated.lastSubmissionId=value.pending.payload?.submissionId
          }
          const key2=prefix+'draft2:'+migrated.lineageId
          legacy.set(key,value);draft=migrated;notes=annotations
          await atomic([[key2,migrated],[prefix+'draft2-notes:'+migrated.lineageId,annotations]],[key])
          legacy.delete(key);drafts.set(key2,migrated)
        } else legacy.set(key,value)
      }
    }
    for(const candidate of drafts.values()) if(candidate.pending) durablePending.set(candidate.lineageId,candidate.pending)
    draft=Array.from(drafts.values()).find(value=>value.snapshotId===snapshot.snapshotId)??Array.from(drafts.values())[0]??draft
    if(draft.snapshotId!==snapshot.snapshotId && !draft.base[path]) path=Object.keys(draft.base)[0]??path
    notes=await request('readonly',notesKey())??[]
    submitted=await request('readonly',prefix+'submitted')??[]
    sentMarker=await request('readonly',sentKey())
    restoredContentHash=await contentHash(content())
    name.value=await request('readonly',prefix+'nickname')??''
    ;($('message') as HTMLInputElement).value=draft.message??''
    const oldPanel=$('old-drafts')
    const choose=(candidate:DraftV2)=>async()=> {
      candidate=drafts.get(prefix+'draft2:'+candidate.lineageId)??candidate
      if(busy || candidate===draft) return
      busy=true;render()
      try {
        if(handle) {await handle.destroy();handle=undefined;editorHost=undefined;enhanced.replaceChildren()}
        const previousLoad=loading
        ++loadEpoch;cancelLoad();if(previousLoad) await previousLoad;loading=undefined
        await saving.catch(()=>{})
        const nextNotes=await request('readonly',prefix+'draft2-notes:'+candidate.lineageId)??[]
        const nextMarker=await request('readonly',prefix+'draft2-sent:'+candidate.lineageId)
        const nextHash=await contentHash(content(candidate,nextNotes))
        // Switch the aggregate only after every companion read succeeds. Inputs
        // while loading continue to belong to the original active lineage.
        draft=candidate;notes=nextNotes;sentMarker=nextMarker;restoredContentHash=nextHash
        ;($('message') as HTMLInputElement).value=draft.message??''
        if(!draft.base[path]) path=Object.keys(draft.base)[0]??snapshot.entry
        navigate();say('继续旧版本草稿；提交将保留原版本基线')
      } catch(error:any) {ready=false;say('草稿恢复失败：'+error.message+'；请导出备份')}
      finally {busy=false;render()}
    }
    for(const candidate of drafts.values()) if(candidate.snapshotId!==snapshot.snapshotId) {
      oldPanel.hidden=false
      const candidateNotes=await request('readonly',prefix+'draft2-notes:'+candidate.lineageId)??[]
      const marker=await request('readonly',prefix+'draft2-sent:'+candidate.lineageId)
      const sent=marker?.submissionId===candidate.lastSubmissionId && marker?.contentHash===await contentHash(content(candidate,candidateNotes))
      const row=document.createElement('p'),label=document.createTextNode((sent?'你在旧版本上有已提交的草稿':'你在旧版本上有未提交的修改')+'（'+candidate.snapshotId+'） ')
      oldDraftLabels.set(candidate.lineageId,label);row.append(label)
      const button=document.createElement('button');button.className='reader-button';button.textContent='按旧版本提交';button.onclick=choose(candidate)
      const exportButton=document.createElement('button');exportButton.className='reader-button';exportButton.textContent='导出草稿';exportButton.onclick=async()=> {await choose(candidate)();$('export').click()}
      const rebaseButton=document.createElement('button');rebaseButton.className='reader-button';rebaseButton.textContent='在新版本上继续'
      rebaseButton.onclick=async()=> {
        if(busy) return
        await choose(drafts.get(prefix+'draft2:'+candidate.lineageId)??candidate)()
        if(draft.lineageId!==candidate.lineageId) return
        await continueDraft()
      }
      row.append(button,rebaseButton,exportButton);oldPanel.append(row)
    }
    for(const [key,value] of legacy) {
      oldPanel.hidden=false
      const row=document.createElement('p');row.textContent='无法取得旧版本原文；仅可导出备份。 '
      const exportButton=document.createElement('button');exportButton.textContent='导出草稿';exportButton.className='reader-button';exportButton.onclick=()=>$('export').click();row.append(exportButton)
      const body=!value.pending?.delivered?(value.pending?.body??(value.pending?.payload?JSON.stringify(value.pending.payload):undefined)):undefined
      if(body && !submitted.includes(JSON.parse(body).submissionId)) {
        row.firstChild!.textContent='旧版本有冻结提交，可重试原包。 '
        const button=document.createElement('button');button.textContent='按旧版本提交';button.className='reader-button'
        button.onclick=async()=> {
          if(busy || !ready || !token || revoked) return
          busy=true;render()
          try {
            await checkVersion(true);if(revoked) return
            const response=await fetch(data.feedbackUrl,{method:'POST',headers:{'Content-Type':'application/json','X-Feedback-Token':token},body})
            if(!response.ok) throw Error('HTTP '+response.status)
            await response.json()
            const id=JSON.parse(body).submissionId, next=[...submitted.filter(item=>item!==id),id].slice(-200)
            await atomic([[prefix+'submitted',next]]);submitted=next;button.disabled=true
            say('已送达，等待主人审阅')
          } catch(error:any) {say('结果未知或未送达：'+error.message+'；原包已保留')}
          finally {busy=false;render()}
        }
        row.append(button)
      }
      oldPanel.append(row)
    }
    ready=true
    say(state.pending ? '有待确认的提交，点击提交重试原包' : data.publicationPending ? '入口已可阅读，其余分享文件正在同步。' : '')
  } catch(error:any) { say('本地存储不可用：'+error.message+'；无法持久保存，修改请导出备份') }
  initialized=true
  navigate()
  void checkVersion()
  void receipts()
  if(data.publicationPending && data.archiveUrl) {
    const downloadAll=$('download-all') as HTMLButtonElement
    const check=async()=> {
      try {
        const response=await fetch(data.archiveUrl,{method:'HEAD',cache:'no-store'})
        if(response.ok) {
          data.publicationPending=false
          downloadAll.disabled=false; downloadAll.textContent='下载全部'
          if(!editing && !Object.keys(state.drafts).length && !state.annotations.length && !state.pending) location.reload()
          else say('完整项目已同步，刷新页面后可查看全部文件。请先导出当前入口草稿备份，再刷新页面。')
          return
        }
        if(response.status===410 || response.status===404) return
      } catch { /* Retain the readable entry while the owner retries the full package. */ }
      setTimeout(check,3000)
    }
    setTimeout(check,3000)
  }
}
