import { anchor, extractGuestAnnotations, propose } from '../lib/share-merge'
import { scanOwnerAnnotations } from '../lib/share-merge/critic'
import { alignEol } from '../lib/share-merge/eol'

/** Proposal offsets are in its EOL-aligned text; map them back without rewriting raw. */
export function guestChanges(input: {path:string;base:string;draft:string}) {
  const extracted=extractGuestAnnotations(input), clean=extracted.clean
  const proposal=propose({path:input.path,base:input.base,ours:input.base,theirs:clean})
  const aligned=alignEol(input.base,clean).theirs, offsets:number[]=[]
  let at=0
  for(let i=0;i<=aligned.length;i++) {
    offsets[i]=at
    if(aligned[i]===clean[at]) at++
    else if(i<aligned.length && aligned[i]!=='\r' && !(i===0 && aligned[i]==='\uFEFF')) throw Error('proposal source mismatch')
  }
  let cursor=0
  const hunks=proposal.segments.flatMap(segment=> {
    if(segment.type==='stable') {cursor+=segment.text.length;return []}
    const hunk=proposal.hunks.find(h=>h.id===segment.id)!, from=offsets[cursor]
    cursor+=hunk.theirs.length
    return [{hunk,from,to:offsets[cursor]}]
  })
  const remaining=new Map<string,number>()
  for(const owner of scanOwnerAnnotations(input.base)) remaining.set(owner.raw,(remaining.get(owner.raw)??0)+1)
  let removed=0
  const guests=scanOwnerAnnotations(input.draft).flatMap(row=> {
    const count=remaining.get(row.raw)??0
    if(count) {remaining.set(row.raw,count-1);return []}
    const from=row.start-removed,to=from+row.quote.length
    removed+=row.raw.length-row.quote.length
    return [{...row,from,to}]
  })
  const rawOffset=(offset:number,end=false)=> {
    let extra=0
    for(const guest of guests) {
      if(offset<guest.from || offset===guest.from && !end) break
      if(offset<=guest.to) return guest.start+(guest.quote?3:0)+(offset-guest.from)
      extra+=guest.raw.length-guest.quote.length
    }
    return offset+extra
  }
  return {extracted,proposal,hunks,guests,rawOffset}
}

export function revertGuestHunk(input: { path: string; base: string; draft: string; hunkId: string }): string {
  const {extracted,hunks,guests}=guestChanges(input)
  const row=hunks.find(row=>row.hunk.id===input.hunkId)
  if(!row) throw Error('这处修改已变化，请重新选择')
  const clean=extracted.clean.slice(0,row.from)+row.hunk.base+extracted.clean.slice(row.to)
  const delta=row.hunk.base.length-(row.to-row.from)
  const located=guests.map((guest,index)=> {
    if(guest.to<=row.from) return {...guest,start:guest.from,end:guest.to}
    if(guest.from>=row.to) return {...guest,start:guest.from+delta,end:guest.to+delta}
    const {start:_start,end:_end,...selector}=extracted.annotations[index].selector
    const result=anchor(clean,selector)
    if(result.status!=='exact') throw Error('撤销会使批注失去定位；批注和修改仍保留，请先调整批注')
    return {...guest,start:result.start,end:result.end}
  }).sort((a,b)=>a.start-b.start || a.end-b.end)
  let result='',cursor=0
  for(const guest of located) {
    if(guest.start<cursor) throw Error('批注定位重叠；批注和修改仍保留')
    result+=clean.slice(cursor,guest.start)+guest.raw;cursor=guest.end
  }
  return result+clean.slice(cursor)
}
