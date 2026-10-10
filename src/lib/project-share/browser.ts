/** Serialized into the static bundle. Keep every runtime dependency inside this function. */
export async function projectShareBrowser(parser: any): Promise<void> {
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
  const say = (message: string) => { status.textContent = message }
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
    saving = saving.catch(() => {}).then(() => request('readwrite', key, value)).then(() => {})
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
      if(!allowed.has(element.tagName)) { element.remove(); continue }
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
  const currentText = () => state.drafts[path] ?? files.get(path)?.markdown ?? ''
  const comments = () => {
    $('comments').replaceChildren()
    for(const item of state.annotations.filter((item:any)=>item.path===path)) {
      const block=document.createElement('blockquote'); block.textContent=item.quote+'\n'+item.comment; $('comments').append(block)
    }
  }
  const render = () => {
    $('title').textContent=path
    editor.value=currentText()
    article.replaceChildren(sanitize(parser.parse(baseline ? files.get(path).markdown : currentText(),{async:false})))
    let count=0
    for(const heading of Array.from(article.querySelectorAll('h1,h2,h3,h4,h5,h6'))) {
      heading.id=(heading.textContent??'').trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu,'').replace(/\s+/g,'-') || 'heading-'+(++count)
    }
    editor.hidden=!editing
    article.hidden=editing
    editButton.textContent=editing?'预览':'编辑 Markdown'
    $('baseline').textContent=baseline?'查看我的修改':'查看发布原文'
    editButton.disabled=!token || !initialized
    submit.disabled=!token || !ready || busy;
    ($('annotate') as HTMLButtonElement).disabled=!token || !ready
    comments()
  }
  const navigate = () => {
    const params=new URLSearchParams(location.hash.slice(1))
    const target=params.get('doc')
    if(target && files.get(target)?.markdown!==undefined) path=target
    render()
    const heading=params.get('heading')
    if(heading) document.getElementById(heading)?.scrollIntoView?.()
  }
  for(const file of docs) {
    const button=document.createElement('button'); button.textContent=file.path
    button.onclick=()=> { location.hash='doc='+encodeURIComponent(file.path) }
    $('files').append(button)
  }
  editButton.onclick=()=> { editing=!editing; baseline=false; render() }
  $('baseline').onclick=()=> { baseline=!baseline; editing=false; render() }
  editor.oninput=()=> {
    state.drafts[path]=editor.value
    say('正在保存草稿…')
    void save().then(()=>say('草稿已保存到本浏览器')).catch(error=>say('草稿未保存：'+error.message+'；请导出备份'))
  }
  $('annotate').onclick=async()=> {
    if(!baseline && currentText()!==files.get(path).markdown) { say('标注基于发布时的原文；请先点击“查看发布原文”再选文'); return }
    const quote=editing ? editor.value.slice(editor.selectionStart,editor.selectionEnd) : window.getSelection()?.toString()??''
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
  render()
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
    say(state.pending && !state.pending.delivered ? '有待确认的提交，点击提交重试原包' : token?'草稿只保存在本浏览器；点击提交自动回传':'只读链接')
  } catch(error:any) { say('本地存储不可用：'+error.message+'；无法持久保存，修改请导出备份') }
  initialized=true
  navigate()
}
