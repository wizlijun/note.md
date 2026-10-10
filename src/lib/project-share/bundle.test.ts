import {describe, expect, it} from 'vitest'
import {buildProjectBundle} from './bundle'
import type {ProjectSnapshot} from './types'
const snapshot: ProjectSnapshot = {schemaVersion:1,project_id:'11111111-1111-4111-8111-111111111111',snapshotId:'22222222-2222-4222-8222-222222222222',entry:'README.md',files:[{path:'README.md',hash:'a'.repeat(64),bytes:10,markdown:'# hello\n</script><script>alert(1)</script>'}]}
describe('static project bundle',()=>{
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
