import {describe, expect, it} from 'vitest'
import {buildProjectBundle} from './bundle'
import type {ProjectSnapshot} from './types'
const snapshot: ProjectSnapshot = {schemaVersion:1,project_id:'11111111-1111-4111-8111-111111111111',snapshotId:'22222222-2222-4222-8222-222222222222',entry:'README.md',files:[{path:'README.md',hash:'a'.repeat(64),bytes:10,markdown:'# hello\n</script><script>alert(1)</script>'}]}
describe('static project bundle',()=>{
  it('freezes the title and presentation into a direct reading shell with inline font CSP',()=>{
    const presentation={themeId:'chosen',styleHead:'<style>.moraya-editor{color:purple}</style>',documents:{'README.md':'<h1>原文</h1><svg viewBox="0 0 20 20"><text>图</text></svg>'},warnings:[]}
    const html=buildProjectBundle(snapshot,'https://share.example/feedback/test',{title:' <私人> ',presentation})
    expect(html).toContain('<title>&lt;私人&gt; · 只读</title>')
    expect(html).toContain("font-src data:")
    expect(html).not.toContain('<header>')
    expect(html).not.toContain('<h2 id="title">')
    expect(html).toContain('id="file-panel"')
    expect(JSON.parse(html.match(/<script id="project-data" type="application\/json">([\s\S]*?)<\/script>/)![1])).toMatchObject({title:'<私人>',presentation:{themeId:presentation.themeId,documents:presentation.documents,warnings:[]}})
    expect(html.split(presentation.styleHead)).toHaveLength(2)
    expect(buildProjectBundle({...snapshot,entry:'目录/稿件.MARKDOWN'},'https://share.example/feedback/test')).toContain('<title>稿件 · 只读</title>')
  })
  it('embeds the complete snapshot without allowing Markdown to break out of its JSON element',()=>{
    const html=buildProjectBundle(snapshot,'https://share.example/feedback/test')
    expect(html).not.toContain('</script><script>alert(1)</script>')
    const raw=html.match(/<script id="project-data" type="application\/json">([\s\S]*?)<\/script>/)![1]
    expect(JSON.parse(raw).snapshot).toEqual(snapshot)
    expect(html).toContain('Content-Security-Policy')
    expect(html).not.toContain('edit_token')
    expect(html).not.toContain('feedback_token_hash')
  })
  it('refuses packages over 25 MiB and non-HTTP feedback endpoints',()=>{
    expect(()=>buildProjectBundle({...snapshot,files:[{...snapshot.files[0],markdown:'a'.repeat(25*1024*1024)}]},'https://example.org/feedback/x')).toThrow(/25 MiB/)
    expect(()=>buildProjectBundle(snapshot,'javascript:alert(1)')).toThrow()
  })
})
