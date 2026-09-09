#!/usr/bin/env node
// Verify the Rust ebook generator with the exact parser used by Index Viewer.
import {spawnSync} from 'node:child_process'
import {mkdtemp,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,dirname,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import assert from 'node:assert/strict'
import {createServer} from 'vite'
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..')
const output=join(await mkdtemp(join(tmpdir(),'notemd-ebook-index-')),'fixture.json')
const result=spawnSync('cargo',['test','--manifest-path','plugins-src/ebook-import/backend/Cargo.toml','topics::index::tests::export_index_format_fixture','--','--exact'],{cwd:root,encoding:'utf8',env:{...process.env,NOTEMD_EBOOK_INDEX_FIXTURE:output}})
if(result.status!==0)throw Error(result.stdout+result.stderr)
const fixture=JSON.parse(await readFile(output,'utf8'))
const vite=await createServer({root,configFile:false,optimizeDeps:{noDiscovery:true,include:[]},server:{middlewareMode:true,watch:null},appType:'custom'})
try{
 const {parseIndex}=await vite.ssrLoadModule('/src/lib/index-format/parser.ts')
 const doc=parseIndex(fixture.content,'/vault/books/阅读.index.md')
 assert.ok(doc,'Rust output must not fall back to Markdown')
 assert.equal(doc.view,'gallery')
 assert.equal(doc.title,fixture.title)
 assert.equal(doc.rows.length,1)
 const row=doc.rows[0]
 assert.equal(row.title,fixture.bookTitle)
 assert.equal(decodeURIComponent(row.href),'./'+fixture.primary)
 assert.equal(row.cells[doc.columns.indexOf('作者')].text,fixture.author.replace(/\s+/g,' '))
 assert.deepEqual(doc.columns,['文件','作者','入库日期','封面','说明'])
 assert.equal(row.cover.href, row.href.replace('2026-09-10-summary.md','cover.jpg'))
 assert.ok(doc.sections.some(section=>section.title==='待整理'&&section.description.some(text=>text.includes('Pending'))))
 const links=row.cells.flatMap(cell=>cell.links)
 assert.ok(links.length>=5)
 assert.ok(links.every(link=>link.kind!=='page'&&!link.href.endsWith('/book.md')))
 assert.ok(!links.some(link=>decodeURIComponent(link.href).includes('.note.md')))
 console.log('PASS: Rust gallery output parses, text/paths survive escaping, latest summary and local cover match, pending books retained.')
 console.log('Fixture:',output)
}finally{await vite.close()}
