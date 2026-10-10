import { marked } from 'marked'
import type { ProjectFile } from './types'

export interface ReferenceIssue { from: string; target: string; kind: 'outside' | 'private' | 'ambiguous' | 'missing'; message: string; severity?: 'warning' | 'error' }
export type ReferenceResult = {kind:'path'; path:string; fragment:string} | {kind:'skip'} | {kind:'outside'; severity:'warning'|'error'}

/** Unclassified legacy read/path issues keep their previous conservative gate. */
export function isBlockingReferenceIssue(issue: ReferenceIssue): boolean {
  return issue.severity ? issue.severity === 'error' : issue.kind === 'missing' || issue.kind === 'outside'
}

/** Markdown URLs are POSIX paths; never let a reference choose a host path. */
export function resolveReference(from: string, target: string): ReferenceResult {
  if (!target || target.startsWith('#') || /^(https?:|mailto:|tel:|data:)/i.test(target)) return {kind:'skip'}
  if (/^(\/|\\|[a-z][\w+.-]*:)/i.test(target)) return {kind:'outside',severity:'error'}
  const [raw, fragment = ''] = target.split('#', 2)
  let decoded: string
  try { decoded = decodeURIComponent(raw.split('?')[0]) } catch { return {kind:'outside',severity:'error'} }
  if (decoded.startsWith('/') || /[\\:\0]/.test(decoded)) return {kind:'outside',severity:'error'}
  const parts = from.split('/').slice(0,-1)
  for (const part of decoded.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') { if (!parts.length) return {kind:'outside',severity:'warning'}; parts.pop() }
    else parts.push(part)
  }
  return parts.length ? {kind:'path', path:parts.join('/'), fragment} : {kind:'skip'}
}

export function privateProjectPath(path: string): boolean {
  return path.split('/').some(p=>p.startsWith('.') || /^(node_modules|target|dist)$/i.test(p))
    || /\.note\.md$/i.test(path) || /(^|\/)(credentials|id_rsa|id_ed25519)(\.|$)/i.test(path)
}

/** Extract from lexer nodes, not source regexes: code must never add documents. */
function links(markdown: string): {target:string; wiki:boolean}[] {
  const result: {target:string; wiki:boolean}[] = []
  const decoded = (value: string): string => {
    const textarea = document.createElement('textarea')
    textarea.innerHTML = value
    return textarea.value
  }
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(visit); return }
    if (!node || typeof node !== 'object') return
    const token = node as Record<string, unknown>
    if (token.type === 'code' || token.type === 'codespan') return
    if ((token.type === 'link' || token.type === 'image') && typeof token.href === 'string') result.push({target:decoded(token.href),wiki:false})
    if (token.type === 'text' && !Array.isArray(token.tokens) && typeof token.text === 'string') {
      for(const match of token.text.matchAll(/!?\[\[([^\]\n]+)\]\]/g)) result.push({target:match[1].split('|')[0].trim(),wiki:true})
    }
    if (token.type === 'html' && typeof token.text === 'string') {
      const template = document.createElement('template')
      template.innerHTML = token.text
      for(const element of template.content.querySelectorAll('a[href], img[src]')) {
        result.push({target:element.getAttribute(element.tagName === 'A' ? 'href' : 'src')!,wiki:false})
      }
    }
    for(const key of ['tokens','items','header','rows']) visit(token[key])
  }
  visit(marked.lexer(markdown))
  return result
}

export async function scanProject(
  entry: string,
  candidates: string[],
  read: (path:string)=>Promise<ProjectFile>,
): Promise<{files:ProjectFile[]; issues:ReferenceIssue[]}> {
  const files: ProjectFile[] = [], issues: ReferenceIssue[] = []
  const seen = new Set<string>()
  const queue: {path:string; from:string; target:string}[] = [{path:entry,from:entry,target:entry}]
  const addIssue = (from:string,target:string,kind:ReferenceIssue['kind'],message:string,severity:'warning'|'error') => issues.push({from,target,kind,message,severity})
  while(queue.length) {
    const item = queue.shift()!
    if(seen.has(item.path)) continue
    seen.add(item.path)
    if(privateProjectPath(item.path)) { addIssue(item.from,item.target,'private','个人手记或管理文件不参与分享',item.path === entry ? 'error' : 'warning'); continue }
    let file: ProjectFile
    try { file = await read(item.path) } catch(e) {
      const message = e instanceof Error ? e.message : String(e)
      const missingReference = item.path !== entry && message.startsWith('NOT_FOUND:')
      addIssue(item.from,item.target,'missing',String(e),missingReference ? 'warning' : 'error')
      continue
    }
    files.push(file)
    if(file.markdown === undefined) continue
    for(const link of links(file.markdown)) {
      let resolved = resolveReference(file.path,link.target)
      if(resolved.kind === 'skip') continue
      if(resolved.kind === 'outside') {
        addIssue(file.path,link.target,'outside',resolved.severity === 'warning' ? '引用越过项目基准目录，未包含在分享中' : '引用包含绝对本机地址或不安全路径，请修改后分享',resolved.severity)
        continue
      }
      if(link.wiki) {
        const withoutFragment = link.target.split('#')[0]
        if(!withoutFragment) continue
        const withExtension = /\.(md|markdown|mdown|mkd|mdx)$/i.test(resolved.path) ? resolved.path : resolved.path+'.md'
        if(candidates.includes(withExtension)) resolved = {...resolved,path:withExtension}
        else if(!withoutFragment.includes('/')) {
          const name = withoutFragment.replace(/\.(md|markdown|mdown|mkd|mdx)$/i,'')
          const matches = candidates.filter(p=>p.split('/').pop()!.replace(/\.(md|markdown|mdown|mkd|mdx)$/i,'')===name)
          if(matches.length > 1) { addIssue(file.path,link.target,'ambiguous',`同名文档：${matches.join('、')}`,'warning'); continue }
          resolved = {...resolved,path:matches[0]??withExtension}
        } else resolved = {...resolved,path:withExtension}
      }
      queue.push({path:resolved.path,from:file.path,target:link.target})
    }
  }
  return {files,issues}
}
