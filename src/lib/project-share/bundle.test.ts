import {describe, expect, it} from 'vitest'
import {buildProjectBundle} from './bundle'
import type {ProjectSnapshot} from './types'
const snapshot: ProjectSnapshot = {schemaVersion:1,project_id:'11111111-1111-4111-8111-111111111111',snapshotId:'22222222-2222-4222-8222-222222222222',entry:'README.md',files:[{path:'README.md',hash:'a'.repeat(64),bytes:10,markdown:'# hello\n</script><script>alert(1)</script>'}]}
describe('static project bundle',()=>{
  it('projects local metadata and unknown file fields out of the public snapshot',()=>{
    const local={...snapshot,schemaVersion:2 as const,parentSnapshotId:'private-parent',createdAt:'private-created',
      git:{snapshotCommit:'private-oid',headAtFreeze:'private-head',prefix:'private-prefix',repoRoot:'/private/repo',branch_intent:{head:'private-intent-head',results_hash:'private-results-hash',commit:'private-intent-commit',branch:'private-intent-branch'}},gitError:'private-error',
      futureMetadata:'private-future',files:[{...snapshot.files[0],modifiedAt:123,localPath:'/private/file',futureFile:'private-file-future'},
        {path:'asset.bin',hash:'b'.repeat(64),bytes:1,dataUrl:'data:application/octet-stream;base64,AA==',localPath:'/private/asset'}]}
    const html=buildProjectBundle(local,'https://share.example/feedback/test')
    const payload=JSON.parse(html.match(/<script id="project-data" type="application\/json">([\s\S]*?)<\/script>/)![1])
    expect(payload.snapshot).toEqual({schemaVersion:1,project_id:snapshot.project_id,snapshotId:snapshot.snapshotId,entry:'README.md',files:[
      {path:'README.md',hash:'a'.repeat(64),bytes:10,modifiedAt:123,markdown:'# hello\n</script><script>alert(1)</script>'},
      {path:'asset.bin',hash:'b'.repeat(64),bytes:1,dataUrl:'data:application/octet-stream;base64,AA=='},
    ]})
    for(const secret of ['branch_intent','private-intent-head','private-results-hash','private-intent-commit','private-intent-branch','private-parent','private-created','private-oid','private-head','private-prefix','/private/repo','private-error','private-future','/private/file','private-file-future','/private/asset']) expect(html).not.toContain(secret)
  })
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
  it('always writes same-origin version URL from the exact feedback route or explicit configuration',()=>{
    const payload=(url:string,options:any={})=>JSON.parse(buildProjectBundle(snapshot,url,options).match(/<script id="project-data" type="application\/json">([\s\S]*?)<\/script>/)![1])
    expect(payload('https://share.example/feedback/slug').versionUrl).toBe('https://share.example/project/slug/version')
    expect(payload('https://share.example/custom',{versionUrl:'https://share.example/project/explicit/version'}).versionUrl).toBe('https://share.example/project/explicit/version')
    expect(()=>payload('https://share.example/feedback')).toThrow(/version endpoint/)
    expect(()=>payload('https://share.example/arbitrary/slug')).toThrow(/version endpoint/)
    expect(()=>payload('https://share.example/feedback/slug/extra')).toThrow(/version endpoint/)
    expect(()=>payload('https://share.example/feedback/slug',{versionUrl:'https://else.example/project/slug/version'})).toThrow(/version endpoint/)
    const html=buildProjectBundle(snapshot,'https://share.example/feedback/slug')
    expect(payload('https://share.example/feedback/slug').editorKit).toBeUndefined()
    expect(html.match(/content="(default-src[^"]+)/)![1].replace(/nonce-[a-z0-9]+/g,'nonce-NONCE')).toBe("default-src 'none'; script-src 'nonce-NONCE'; style-src 'unsafe-inline'; img-src data: https: http:; font-src data:; connect-src https://share.example; base-uri 'none'; form-action 'none'")
  })

})

describe('frozen editor kit payload and CSP', () => {
  const resource = (ext: string, prefix = 'share-editor') => ({ url: `https://share.example/_kit/${prefix}.${'a'.repeat(64)}.${ext}`, integrity: 'sha384-' + 'a'.repeat(64) })
  const editorKit = { apiVersion: 1 as const, js: resource('js'), css: resource('css'), mermaid: resource('js', 'share-editor-mermaid') }
  it('projects only complete same-origin descriptors and grants exact script/style URLs', () => {
    const html = buildProjectBundle(snapshot, 'https://share.example/feedback/slug', { editorKit: { ...editorKit, token: 'private-token', localPath: '/private/path', git: 'private-git' } } as any)
    const payload = JSON.parse(html.match(/<script id="project-data" type="application\/json">([\s\S]*?)<\/script>/)![1])
    expect(payload.editorKit).toEqual(editorKit)
    expect(html).not.toMatch(/private-token|private-git|\/private\/path/)
    const csp = html.match(/content="(default-src[^"]+)/)![1].replace(/nonce-[a-z0-9]+/g, 'nonce-NONCE')
    expect(csp).toBe(`default-src 'none'; script-src 'nonce-NONCE' ${editorKit.js.url} ${editorKit.mermaid.url}; style-src 'unsafe-inline' ${editorKit.css.url}; img-src data: https: http:; font-src data:; connect-src https://share.example; base-uri 'none'; form-action 'none'`)
  })
  it.each(['/relative.js', 'https://other.test/kit.js', 'https://owner:password@share.example/kit.js', 'https://share.example/kit.js?token=secret', 'javascript:alert(1)'])('rejects unsafe kit URL %s', url => {
    expect(() => buildProjectBundle(snapshot, 'https://share.example/feedback/slug', { editorKit: { ...editorKit, js: { ...editorKit.js, url } } } as any)).toThrow()
  })
})
