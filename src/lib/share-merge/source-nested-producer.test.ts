import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {expect,it} from 'vitest'
import {EditorState} from 'prosemirror-state'
import type {Node as PmNode} from 'prosemirror-model'
import {createSourceSession,applySourceBlockTransaction} from '@moraya/core'
import {propose} from './proposal'
function at(doc:PmNode,path:readonly number[],offset=0):number {
 let n=doc,p=0
 for(const i of path){for(let j=0;j<i;j++)p+=n.child(j).nodeSize;p++;n=n.child(i)}
 return p+offset
}
function run(source:string,path:readonly number[],offset:number,old:string,text:string,expected:string){
 const opened=createSourceSession(source);expect(opened.ok).toBe(true);if(!opened.ok)throw Error(opened.reason)
 const b=opened.session,p=at(b.doc,path,offset);expect(b.doc.textBetween(p,p+1)).toBe(old)
 const tr=EditorState.create({doc:b.doc}).tr.insertText(text,p,p+1)
 const r=applySourceBlockTransaction(b,tr);expect(r.ok).toBe(true);if(!r.ok)throw Error(r.reason)
 expect(Buffer.from(r.session.source)).toEqual(Buffer.from(expected));expect(r.session.doc.eq(tr.doc)).toBe(true)
 expect(r.edits).toHaveLength(1);expect(r.edits[0]!.to-r.edits[0]!.from).toBe(1);expect(r.edits[0]!.text).toBe(text)
 expect(b.source).toBe(source)
 const proposal=propose({path:'body.md',base:source,ours:source,theirs:r.session.source})
 expect(proposal.hunks).toHaveLength(1);expect(proposal.theirsEolAligned).toBe(false)
 expect(proposal.hunks[0]!.kind).toBe('theirs-only')
 return proposal.hunks[0]!
}
const nested=[
 ['>  甲。\n> 第二句。\n',[0,0],0,'>  乙。\n> 第二句。\n'],
 ['*   甲。\n*   甲。\n',[0,1,0],0,'*   甲。\n*   乙。\n'],
 ['[^n]: 甲。\n\n正文[^n]。',[0,0],0,'[^n]: 乙。\n\n正文[^n]。'],
 ['###   甲。   ###\n',[0],0,'###   乙。   ###\n'],
 ['甲。\n====\n',[0],0,'乙。\n====\n'],
 ['\uFEFF>  甲。\r\n> 甲。\r\n',[0,0],0,'\uFEFF>  乙。\r\n> 甲。\r\n'],
 ['> 甲。\nlazy甲。\n',[0,0],7,'> 甲。\nlazy乙。\n'],
] as const
it.each(nested)('installed nested body %j',(raw,path,offset,expected)=>{run(raw,path,offset,'甲','乙',expected)})
const bodies=[
 ['table padding','| H | J |\n| :--- | ---: |\n|   甲 | 甲  |\n',[0,1,1,0],0,'| H | J |\n| :--- | ---: |\n|   甲 | 乙  |\n'],
 ['escaped pipe','| H |\n| :--- |\n| a\\|甲 |\n',[0,1,0,0],2,'| H |\n| :--- |\n| a\\|乙 |\n'],
 ['mermaid','~~~~mermaid\ngraph TD; 甲-->B\n~~~~\n',[0],10,'~~~~mermaid\ngraph TD; 乙-->B\n~~~~\n'],
 ['frontmatter','\uFEFF---\r\ntitle: 甲\r\n---\r\n',[0],7,'\uFEFF---\r\ntitle: 乙\r\n---\r\n'],
 ['HTML','<div class="note">\n  甲。\n</div>\n',[0],21,'<div class="note">\n  乙。\n</div>\n'],
 ['indented code','    甲。\n    同句。\n',[0],0,'    乙。\n    同句。\n'],
 ['critic','{==甲。==}{>>原注<<}',[0],0,'{==乙。==}{>>原注<<}'],
 ['header only','| 甲 |\n| :--- |\n',[0,0,0,0],0,'| 乙 |\n| :--- |\n'],
 ['header body','| 甲 |\n| :--- |\n| 甲 |\n',[0,0,0,0],0,'| 乙 |\n| :--- |\n| 甲 |\n'],
 ['extra column','| H |\n| --- |\n|  甲 | 甲 |\n',[0,1,0,0],0,'| H |\n| --- |\n|  乙 | 甲 |\n'],
 ['double backslash','| H |\n| --- |\n| a\\\\|甲 |\n',[0,1,0,0],2,'| H |\n| --- |\n| a\\\\|乙 |\n'],
 ['triple backslash','| H |\n| --- |\n| a\\\\\\|甲 |\n',[0,1,0,0],3,'| H |\n| --- |\n| a\\\\\\|乙 |\n'],
 ['entity','| H |\n| --- |\n| &amp;甲 |\n',[0,1,0,0],1,'| H |\n| --- |\n| &amp;乙 |\n'],
 ['table BOM CRLF','\uFEFF| H |\r\n| :--- |\r\n| 甲 |\r\n',[0,1,0,0],0,'\uFEFF| H |\r\n| :--- |\r\n| 乙 |\r\n'],
 ['quote table','> | H |\n> | :--- |\n> | 甲 |\n',[0,0,1,0,0],0,'> | H |\n> | :--- |\n> | 乙 |\n'],
 ['critic emphasis','{==保留 _甲强调_==}{>>原注<<}',[0],3,'{==保留 _乙强调_==}{>>原注<<}'],
 ['HTML mark','<span>甲</span>',[0],0,'<span>乙</span>'],
 ['highlight','==甲==',[0],0,'==乙=='],
 ['strike','~~甲~~',[0],0,'~~乙~~'],
] as const
it.each(bodies)('installed actual body %s',(_name,raw,path,offset,expected)=>{run(raw,path,offset,'甲','乙',expected)})
it('installed table body has exactly one real row hunk',()=>{
 const h=run('| H | J |\n| :--- | ---: |\n|   甲 | 甲  |\n',[0,1,1,0],0,'甲','乙','| H | J |\n| :--- | ---: |\n|   甲 | 乙  |\n')
 expect(h.base).toBe('|   甲 | 甲  |\n');expect(h.theirs).toBe('|   甲 | 乙  |\n')
})

const dir=fileURLToPath(new URL('../../share-editor/__fixtures__/corpus/source-fidelity/',import.meta.url))
const manifest=JSON.parse(readFileSync(join(dir,'manifest.json'),'utf8')) as {name:string;sha256:string}[]
const corpus=[
 ["mixed-list", 19, [0, 0, 1, 0, 1, 0, 0], 0, "孙", "新", "* 第一项\n  + 子项\n    - ", "项\n+ 第二项\n\n目标甲。", "    - 孙项\n", "    - 新项\n"],
 ["quote", 3, [0, 0], 0, "原", "新", ">  ", "始引用。\n>\n> 第二句。\n\n目标甲。", ">  原始引用。\n", ">  新始引用。\n"],
 ["table", 28, [0, 1, 0, 0], 0, "x", "z", "| A | B |\n| :--- | ---: |\n| ", " | y |\n\n目标甲。", "| x | y |\n", "| z | y |\n"],
 ["footnote", 24, [1, 0], 0, "原", "新", "目标甲[^n]。保留 _斜体_。\n\n[^n]: ", "注。\n", "[^n]: 原注。\n", "[^n]: 新注。\n"],
 ["mermaid", 21, [0], 10, "A", "C", "```mermaid\ngraph TD; ", "-->B\n```\n\n目标甲。", "```mermaid\ngraph TD; A-->B\n```\n", "```mermaid\ngraph TD; C-->B\n```\n"],
 ["html", 21, [0], 21, "保", "存", "<div class=\"note\">\n  ", "留 HTML。\n</div>\n\n目标甲。", "<div class=\"note\">\n  保留 HTML。\n</div>\n", "<div class=\"note\">\n  存留 HTML。\n</div>\n"],
 ["frontmatter", 12, [0], 8, "原", "新", "---\ntitle: \"", "样\"\n---\n\n目标甲。\n", "title: \"原样\"\n", "title: \"新样\"\n"],
 ["critic-range", 11, [0], 7, "强", "重", "目标甲。{==保留 _", "调_==}{>>原注<<}", "{==保留 _强调_==}{>>原注<<}", "{==保留 _重调_==}{>>原注<<}"],
 ] as const
for(const [name,rawOffset,path,offset,old,text,before,after,hunkBase,hunkTheirs] of corpus)it(`installed original fixture internal body: ${name}`,()=>{
 const bytes=readFileSync(join(dir,name+'.md')),source=bytes.toString('utf8')
 expect(createHash('sha256').update(bytes).digest('hex')).toBe(manifest.find(f=>f.name===name)!.sha256)
 expect(source).toBe(before+old+after);expect(before.length).toBe(rawOffset);expect(source[rawOffset]).toBe(old)
 const expected=before+text+after
 const h=run(source,path,offset,old,text,expected)
 expect(h.base).toBe(hunkBase);expect(h.theirs).toBe(hunkTheirs)
})
