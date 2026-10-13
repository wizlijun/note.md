import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {expect,it} from 'vitest'
import {EditorState} from 'prosemirror-state'
import {createSourceSession,applySourceTextTransaction} from '@moraya/core'
import {propose} from './proposal'
const dir=fileURLToPath(new URL('../../share-editor/__fixtures__/corpus/source-fidelity/',import.meta.url))
const manifest=JSON.parse(readFileSync(join(dir,'manifest.json'),'utf8')) as {name:string;sha256:string;target:number}[]
for(const f of manifest) it(`installed core -> propose: ${f.name}`,()=>{
 const raw=readFileSync(join(dir,f.name+'.md')),source=raw.toString('utf8')
 expect(createHash('sha256').update(raw).digest('hex')).toBe(f.sha256)
 const opened=createSourceSession(source)
 expect(opened.ok).toBe(true);if(!opened.ok)throw new Error(opened.reason)
 const base=opened.session,positions:number[]=[]
 base.doc.descendants((n,p)=>{if(n.isText){const at=n.text!.indexOf('目标甲');if(at>=0)positions.push(p+at+2)}})
 expect(positions).toHaveLength(1)
 const from=positions[0]!
 const tr=EditorState.create({doc:base.doc}).tr.insertText('乙',from,from+1)
 const next=applySourceTextTransaction(base,tr)
 expect(next.ok).toBe(true);if(!next.ok)throw new Error(next.reason)
 const after=next.session.source
 // 原始 core 输出必须先精确相等，不能依赖 alignEol 补救。
 expect(Buffer.from(after)).toEqual(Buffer.from(source.slice(0,f.target)+'乙'+source.slice(f.target+1)))
 const p=propose({path:f.name+'.md',base:source,ours:source,theirs:after})
 expect(p.hunks).toHaveLength(1)
 expect(p.theirsEolAligned).toBe(false)
 const h=p.hunks[0]!
 expect(h.kind).toBe('theirs-only')
 expect(h.base).toContain('目标甲')
 expect(h.theirs).toBe(h.base.replace('目标甲','目标乙'))
 expect(source.slice(h.oursStart,h.oursEnd)).toBe(h.base)
 // 独立句边界：只允许目标所在句和紧随的原始 EOL，不能包含下一句。
 let start=f.target,end=f.target+1
 while(start>0&&!/[。！？\r\n]/.test(source[start-1]!))start--
 while(end<source.length&&!/[。！？\r\n]/.test(source[end]!))end++
 if(/[。！？]/.test(source[end]??''))end++
 if(source[end]==='\r'&&source[end+1]==='\n')end+=2
 else if(source[end]==='\r'||source[end]==='\n')end++
 expect(h.oursStart).toBeGreaterThanOrEqual(start)
 expect(h.oursEnd).toBeLessThanOrEqual(end)
})
