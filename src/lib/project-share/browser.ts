/** Serialized into the static bundle. Keep every runtime dependency inside this function. */
export async function projectShareBrowser(parser: any, zipper?: any): Promise<void> {
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
  const providedToken = new URLSearchParams(location.hash.slice(1)).get('feedback') ?? ''
  let token = providedToken
  let db: IDBDatabase | undefined
  let ready = false
  let initialized = false
  let state: any = { drafts: {}, annotations: [], pending: null }
  let saving = Promise.resolve()
  let busy = false
  const key = snapshot.project_id + ':' + snapshot.snapshotId
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
  const save = (): Promise<void> => {
    const value = JSON.parse(JSON.stringify(state))
    saving = saving.catch(() => {}).then(() => request('readwrite', key, value)).then(() => {}, error => { ready=false; render(); throw error })
    return saving
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
  const tree: any = {children:new Map<string,any>()}
  for(const file of docs) {
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
    const append = (parent:any,list:HTMLElement,depth:number) => {
      const nodes=Array.from(parent.children.values()) as any[]
      nodes.sort((a,b)=>Number(b.folder)-Number(a.folder) || (b.modifiedAt??-1)-(a.modifiedAt??-1) || a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
      for(const node of nodes) {
        const item=document.createElement('li')
        const button=document.createElement('button')
        button.className='file-row'; button.style.paddingLeft=(8+depth*14)+'px'; button.title=node.name
        button.innerHTML=(node.folder?'<svg class="chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>':'<span class="chevron"></span>')+icon(node.folder)
        const label=document.createElement('span'); label.className='file-label'; label.textContent=node.name; button.append(label)
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
          button.setAttribute('aria-haspopup','menu')
          button.oncontextmenu=event=>openMenu(event,button,node.path)
          button.onkeydown=event=> { if(event.key==='ContextMenu' || (event.key==='F10' && event.shiftKey)) openMenu(event,button,node.path) }
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
  const currentText = () => state.drafts[path] ?? files.get(path)?.markdown ?? ''
  const comments = () => {
    $('comments').replaceChildren()
    for(const item of state.annotations.filter((item:any)=>item.path===path)) {
      const block=document.createElement('blockquote'); block.textContent=item.quote+'\n'+item.comment; $('comments').append(block)
    }
  }
  const render = () => {
    editor.value=currentText()
    const original=baseline || currentText()===files.get(path).markdown
    const published=data.presentation?.documents[path]
    $('reader').setAttribute('data-theme',data.presentation?.themeId??'')
    article.setAttribute('data-theme',data.presentation?.themeId??'')
    article.replaceChildren(original && published!==undefined ? publishedContent(published) : sanitize(parser.parse(baseline?files.get(path).markdown:currentText(),{async:false,breaks:true})))
    if(!(original && published!==undefined)) {
      const headings=new Map<string,number>()
      for(const heading of Array.from(article.querySelectorAll('h1,h2,h3,h4,h5,h6'))) {
        const slug=(heading.textContent??'').trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu,'').replace(/\s+/g,'-') || 'heading'
        const count=headings.get(slug)??0; headings.set(slug,count+1); heading.id=slug+(count?'-'+count:'')
      }
      if(!original && /^ {0,3}(`{3,}|~{3,})(mermaid|dot|graphviz|circo|neato|fdp|sfdp|twopi)\b/im.test(currentText())) {
        const hint=document.createElement('p'); hint.className='draft-diagram-note'; hint.textContent='草稿图表显示源代码；主人合入并重新发布后完整渲染。'; article.prepend(hint)
      }
    }
    editor.hidden=!editing
    article.hidden=editing
    editButton.textContent=editing?'预览':'编辑 Markdown'
    $('baseline').textContent=baseline?'查看我的修改':'查看发布原文'
    document.title=data.title+' · '+(token?'可编辑':'只读')
    $('collaboration').hidden=!token
    editButton.disabled=!token || !initialized
    ;($('baseline') as HTMLButtonElement).disabled=!token || !initialized
    ;($('export') as HTMLButtonElement).disabled=!token || !initialized
    ;(name as HTMLInputElement).disabled=!token || !initialized
    submit.disabled=!token || !ready || busy
    ;($('annotate') as HTMLButtonElement).disabled=!token || !initialized
    comments()
  }
  const navigate = () => {
    const params=new URLSearchParams(location.hash.slice(1))
    const target=params.get('doc')
    if(target && files.get(target)?.markdown!==undefined) path=target
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
  editButton.onclick=()=> { if(!token || !initialized) return; editing=!editing; baseline=false; render(); if(editing) editor.focus() }
  $('baseline').onclick=()=> { baseline=!baseline; editing=false; render() }
  editor.oninput=()=> {
    state.drafts[path]=editor.value
    say('正在保存草稿…')
    void save().then(()=>say('草稿已保存到本浏览器')).catch(error=>say('草稿未保存：'+error.message+'；请导出备份'))
  }
  $('annotate').onclick=async()=> {
    if(!baseline && currentText()!==files.get(path).markdown) { say('标注基于发布时的原文；请先点击“查看发布原文”再选文'); return }
    if(!token || !initialized) return
    const selection=window.getSelection()
    if(editing || !selection?.rangeCount || Array.from({length:selection.rangeCount},(_,index)=>selection.getRangeAt(index)).some(range=>!article.contains(range.startContainer) || !article.contains(range.endContainer))) { say('请在发布原文的正文中选中要标注的文字'); return }
    const quote=selection.toString()
    if(!quote) { say('请先选中要标注的文字'); return }
    const comment=window.prompt('评论')
    if(!comment?.trim()) return
    state.annotations.push({path,quote,comment:comment.trim()})
    comments()
    try { await save(); say('标注已保存到本浏览器') } catch(error:any) { say('标注未保存：'+error.message+'；请导出备份') }
  }
  $('export').onclick=()=> {
    const blob=new Blob([JSON.stringify({project_id:snapshot.project_id,snapshotId:snapshot.snapshotId,...state},null,2)],{type:'application/json'})
    const url=URL.createObjectURL(blob); const a=document.createElement('a');a.href=url;a.download='project-draft.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)
  }
  submit.onclick=async()=> {
    if(busy || !ready || !token) return
    const edits=docs.filter((file:any)=>state.drafts[file.path]!==undefined && state.drafts[file.path]!==file.markdown).map((file:any)=>({path:file.path,baseHash:file.hash,afterMarkdown:state.drafts[file.path]}))
    const signature=JSON.stringify({edits,annotations:state.annotations,name:name.value})
    let pending=state.pending
    if(!pending || pending.delivered) {
      if((!edits.length && !state.annotations.length) || state.pending?.signature===signature) { say('没有新的修改或标注');return }
      pending={payload:{schemaVersion:1,project_id:snapshot.project_id,snapshotId:snapshot.snapshotId,submissionId:uuid(),edits,annotations:JSON.parse(JSON.stringify(state.annotations)),name:name.value},signature,delivered:false}
    }
    const body=JSON.stringify(pending.payload)
    if(new TextEncoder().encode(body).byteLength>5*1024*1024) { say('修改包超过 5 MiB，请导出备份并联系主人');return }
    state.pending=pending
    busy=true;render();say('提交中…')
    try {
      await save()
      const response=await fetch(data.feedbackUrl,{method:'POST',headers:{'Content-Type':'application/json','X-Feedback-Token':token},body})
      if(!response.ok) throw new Error('HTTP '+response.status)
      await response.json()
      state.pending.delivered=true
      await save()
      say('已送达，等待主人审阅；页面正文需主人重新发布后更新')
    } catch(error:any) { say('结果未知或未送达：'+error.message+'；草稿已保留，点击提交重试原包') }
    finally { busy=false;render() }
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
    state=await request('readonly',key) ?? state
    const params=new URLSearchParams(location.hash.slice(1))
    const provided=providedToken
    if(provided) {
      token=provided
      await request('readwrite',snapshot.project_id+':token',token)
      params.delete('feedback')
      history.replaceState(null,'',location.pathname+location.search+(params.size?'#'+params.toString():''))
    } else token=await request('readonly',snapshot.project_id+':token') ?? ''
    ready=true
    say(state.pending && !state.pending.delivered ? '有待确认的提交，点击提交重试原包' : data.publicationPending ? '入口已可阅读，其余分享文件正在同步。' : '')
  } catch(error:any) { say('本地存储不可用：'+error.message+'；无法持久保存，修改请导出备份') }
  initialized=true
  navigate()
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
