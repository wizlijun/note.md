#!/usr/bin/env node
import http from 'node:http'
import path from 'node:path'
import os from 'node:os'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..')
const output=path.resolve(process.argv[2]??path.join(os.tmpdir(),'sumi-editor-benchmark'))
const port=Number(process.argv[3]??5179)
const mime={'.html':'text/html;charset=utf-8','.js':'application/javascript','.css':'text/css','.json':'application/json','.ttf':'font/ttf','.otf':'font/otf','.woff':'font/woff','.woff2':'font/woff2','.svg':'image/svg+xml'}
http.createServer(async(req,res)=>{
 try {
  const url=new URL(req.url,'http://localhost');let pathname=decodeURIComponent(url.pathname)
  if(req.method==='POST'&&pathname==='/reports'){
   // Local-only browser results; prevent cross-origin pages writing arbitrary reports.
   if(req.headers.origin!==`http://127.0.0.1:${port}`&&req.headers.origin!==`http://localhost:${port}`)throw new Error('origin denied')
   let bytes=0;const chunks=[];for await(const c of req){bytes+=c.length;if(bytes>8*1024*1024)throw new Error('report too large');chunks.push(c)}
   const report=JSON.parse(Buffer.concat(chunks).toString());await mkdir(path.join(output,'reports'),{recursive:true})
   const filename=`web-${Date.now()}-${randomUUID()}.json`;await writeFile(path.join(output,'reports',filename),JSON.stringify(report,null,2),{flag:'wx'});res.end(`报告已保存：${filename}`);return
  }
  if(req.method!=='GET')throw new Error('method denied')
  let root=path.join(output,'web')
  if(pathname==='/identity.json')root=output
  if(pathname.startsWith('/corpus/'))root=output
  if(pathname.startsWith('/fonts/')){root=path.join(repo,'src-tauri/resources/sumi');pathname=pathname.slice('/fonts'.length)}
  if(pathname==='/')pathname='/index.html'
  const filename=path.resolve(root,`.${pathname}`)
  if(!filename.startsWith(root+path.sep))throw new Error('path denied')
  res.setHeader('Content-Type',mime[path.extname(filename)]??'application/octet-stream');res.setHeader('Cache-Control','no-store');res.end(await readFile(filename))
 }catch(error){res.statusCode=400;res.end(String(error))}
}).listen(port,'127.0.0.1',()=>console.log(`Sumi benchmark: http://127.0.0.1:${port}/\nOutput: ${output}\nNo production Vault/settings are used.`))
