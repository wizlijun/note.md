import markedSource from 'marked?raw'
import { projectShareBrowser } from './browser'
import type { ProjectSnapshot } from './types'

/** One self-contained page, published through the existing HTML share endpoint. */
export function buildProjectBundle(snapshot: ProjectSnapshot, feedbackUrl: string): string {
  const endpoint = new URL(feedbackUrl)
  if(!['http:','https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error('Invalid feedback endpoint')
  const exports=markedSource.match(/export\s*\{([^}]+)\}/)?.[1]
  const constructor=exports?.match(/(\w+)\s+as\s+Marked\b/)?.[1]
  if(!constructor) throw new Error('Cannot bundle the installed Markdown renderer')
  const renderer=markedSource.replace(/export\s*\{[^}]+\}\s*;?/,'')
  const script=`(()=>{${renderer}\n(${projectShareBrowser.toString()})(new ${constructor}());})();`.replace(/<\/script/gi,'<\\/script')
  const payload=JSON.stringify({snapshot,feedbackUrl:endpoint.href}).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029')
  const nonce=crypto.randomUUID().replace(/-/g,'')
  const origin=endpoint.origin.replace(/&/g,'&amp;').replace(/"/g,'&quot;')
  const html=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data: https: http:; connect-src ${origin}; base-uri 'none'; form-action 'none'"><title>note.md 项目分享</title><style>
*{box-sizing:border-box}body{margin:0;font:15px/1.7 system-ui,sans-serif;color:#222;background:#fff}header{padding:12px 20px;border-bottom:1px solid #ddd}header p{margin:4px 0;color:#666;font-size:13px}.layout{display:flex;min-height:80vh}nav{width:230px;flex-shrink:0;padding:16px;border-right:1px solid #ddd;overflow-wrap:anywhere}nav button{display:block;width:100%;text-align:left;border:0;background:transparent;padding:8px;cursor:pointer}main{padding:20px;max-width:1000px;flex:1;min-width:0}.toolbar{display:flex;gap:8px;flex-wrap:wrap}button,input{font:inherit;padding:5px 10px}button{cursor:pointer}button:disabled{cursor:default;opacity:.5}#title{overflow-wrap:anywhere}#editor{width:100%;min-height:55vh;font:14px/1.6 ui-monospace,monospace;padding:12px}#status{white-space:pre-wrap}#document img{max-width:100%}#document pre{overflow:auto;padding:12px;background:#f5f5f5}blockquote{border-left:3px solid #ccc;margin:16px 0;padding-left:16px;white-space:pre-wrap}table{border-collapse:collapse}th,td{border:1px solid #ccc;padding:5px}.unshared{color:#888}a{color:#1769c2;text-decoration:underline} [hidden]{display:none!important}@media(max-width:650px){.layout{display:block}nav{width:100%;border-right:0;border-bottom:1px solid #ddd;display:flex;overflow:auto;padding:4px}nav button{width:auto;white-space:nowrap}main{padding:14px}}
</style></head><body><header><strong>note.md 项目分享</strong><p>个人草稿与标注由主人审阅后合入原件；重新发布后更新页面。</p><div id="status" role="status">正在打开…</div></header><div class="layout"><nav id="files" aria-label="文档"></nav><main><h2 id="title"></h2><div class="toolbar"><button id="edit">编辑 Markdown</button><button id="baseline">查看发布原文</button><button id="annotate">标注选文</button><input id="name" placeholder="署名（选填）" aria-label="署名"><button id="submit">提交修改</button><button id="export">导出草稿备份</button></div><article id="document"></article><textarea id="editor" aria-label="Markdown" hidden></textarea><section id="comments" aria-label="我的标注"></section></main></div><script id="project-data" type="application/json">${payload}</script><script nonce="${nonce}">${script}</script></body></html>`
  if(new TextEncoder().encode(html).byteLength>25*1024*1024) throw new Error('分享包超过 25 MiB，请减少分享文件或资源')
  return html
}
