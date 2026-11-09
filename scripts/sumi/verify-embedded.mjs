// Read-only whole-module proof, following scripts/release-share-payload.mjs.
// Does not execute the host or prove runtime routing/physical input.
import { readFileSync, readdirSync, realpathSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { brotliDecompressSync, brotliCompressSync } from 'node:zlib'
const need=(ok,message)=>{if(!ok)throw Error(message)}
const sha=b=>createHash('sha256').update(b).digest('hex')
const cpuTypes={arm64:0x0100000c,x86_64:0x01000007}
function verifyMachO(binary,arch){need(Object.hasOwn(cpuTypes,arch),'Unsupported architecture');need(binary.length>=32&&binary.subarray(0,4).toString('hex')==='cffaedfe'&&binary.readUInt32LE(4)===cpuTypes[arch],`Expected thin ${arch} Mach-O`)}
const roles={native:['native-editor-region','sumi-action','sumi-navigation','plugin_v2_open_window'],recovery:['sumi_restore_projection','恢复为新的一页','重新检查源文件'],exit:['sumi-before-exit','finish_sumi_exit'],source:['sumi_source_save','sumi_rebase_draft','sumi_detach'],richFrontmatter:['hidden-frontmatter-selection','hideRichFrontmatter'],richPreferences:['hideRichFrontmatter','settings://changed']}
const roleChunks={richFrontmatter:/^editor-bridge(?:-[\w-]+)?\.js$/,richPreferences:/^settings\.svelte(?:-[\w-]+)?\.js$/}
function inspect(dist){
 const rows=readdirSync(join(dist,'assets')).filter(n=>n.endsWith('.js')&&!n.startsWith('share-editor')).flatMap(name=>{
  const raw=readFileSync(join(dist,'assets',name)),text=raw.toString(),found=Object.keys(roles).filter(role=>(!roleChunks[role]||roleChunks[role].test(name))&&roles[role].every(token=>text.includes(token)))
  return found.length?[{name,sha256:sha(raw),bytes:raw.length,roles:found}]:[]
 }).sort((a,b)=>a.name.localeCompare(b.name))
 need(Object.keys(roles).every(role=>rows.some(row=>row.roles.includes(role))),'Missing host native/recovery/exit/source/Rich JS role')
 return rows
}
function recover(binary,compressed){const at=binary.indexOf(compressed);need(at>=0&&binary.indexOf(compressed,at+1)<0,'Missing or duplicate whole compressed module');return {offset:at,raw:brotliDecompressSync(binary.subarray(at,at+compressed.length))}}
function verifyBundle(binaryPath,depfile,dist,input,target,arch){
 const frozen=JSON.parse(readFileSync(input)),rows=inspect(dist);need(JSON.stringify(rows)===JSON.stringify(frozen.host_modules),'Host modules differ from frozen inputs')
 const binary=readFileSync(binaryPath);verifyMachO(binary,arch)
 need(!binary.includes(Buffer.from('net.notemd.sumi.acceptance')),'Isolated acceptance identity in release binary')
 const paths=[...new Set(readFileSync(depfile,'utf8').match(/\/[^\s:]*\/tauri-codegen-assets\/[a-f0-9]{64}\.js(?=[\s:]|$)/g)??[])],proof=[]
 for(const path of paths){need(realpathSync(path).startsWith(target+'/'),'Codegen cache outside target');const packed=readFileSync(path),raw=brotliDecompressSync(packed),hash=sha(raw);if(!rows.some(row=>row.sha256===hash))continue;const recovered=recover(binary,packed);need(recovered.raw.equals(raw),'Recovered module differs');proof.push({sha256:hash,compressed_sha256:sha(packed),offset:recovered.offset})}
 need(rows.every(row=>proof.filter(p=>p.sha256===row.sha256).length===1),'Frozen host module not proven in binary')
 return {ok:true,architecture:arch,modules:rows,proof,runtimeRoutingVerified:false,physicalInputVerified:false}
}
try{
 const args=process.argv.slice(2),at=args.indexOf('--arch');let arch='arm64'
 if(at>=0){need(at+1<args.length,'Missing --arch value');arch=args[at+1];args.splice(at,2)}
 need(Object.hasOwn(cpuTypes,arch)&&!args.includes('--arch'),'Expected --arch arm64|x86_64 exactly once')
 if(args[0]==='--self-test'){
  for(const expected of Object.keys(cpuTypes)){
   const header=Buffer.alloc(32);header.writeUInt32LE(0xfeedfacf);header.writeUInt32LE(cpuTypes[expected],4);verifyMachO(header,expected)
   const other=expected==='arm64'?'x86_64':'arm64';let failed=false;try{verifyMachO(header,other)}catch{failed=true}need(failed,'Wrong Mach-O CPU accepted')
   for(const bad of [header.subarray(0,8),Buffer.alloc(32)]){failed=false;try{verifyMachO(bad,expected)}catch{failed=true}need(failed,'Truncated/non-Mach-O accepted')}
  }
  const raw=Buffer.from('fixture'),packed=brotliCompressSync(raw);need(recover(Buffer.concat([Buffer.from('head'),packed]),packed).raw.equals(raw),'recover failed')
  for(const bytes of [Buffer.from('absent'),Buffer.concat([packed,packed])]){let failed=false;try{recover(bytes,packed)}catch{failed=true}need(failed,'negative containment accepted')}
  const dir=mkdtempSync(join(tmpdir(),'sumi-modules-test-'))
  try{mkdirSync(join(dir,'assets'));const full=Object.values(roles).flat().join(' '),host=join(dir,'assets','host.js')
   const rich=[['editor-bridge.js',roles.richFrontmatter.join(' ')],['settings.svelte.js',roles.richPreferences.join(' ')]]
   writeFileSync(host,full);for(const [name,text] of rich)writeFileSync(join(dir,'assets',name),text)
   need(inspect(dir).length===3,'Six-role split-module fixture failed')
   const rejected=(fn,message)=>{let failed=false;try{fn()}catch{failed=true}need(failed,message)}
   for(const tokens of Object.values(roles).slice(0,4)){writeFileSync(host,full.replace(tokens[0],''));rejected(()=>inspect(dir),'Missing original host role accepted')}
   writeFileSync(host,full)
   for(const [name,text] of rich){
    const file=join(dir,'assets',name);rmSync(file);rejected(()=>inspect(dir),'Rich role accepted from unrelated host chunk')
    writeFileSync(file,text.replace('hideRichFrontmatter','changed'));rejected(()=>inspect(dir),'Missing Rich role accepted');writeFileSync(file,text)
   }
   // End-to-end synthetic whole-module proof: real Brotli data, frozen hashes,
   // actual depfile/cache paths, and a minimal Mach-O header (not a real app).
   const rows=inspect(dir),target=join(dir,'target'),cache=join(target,'tauri-codegen-assets');mkdirSync(cache,{recursive:true})
   const modules=rows.map(row=>{const raw=readFileSync(join(dir,'assets',row.name)),packed=brotliCompressSync(raw),path=join(cache,sha(raw)+'.js');writeFileSync(path,packed);return {row,raw,packed,path}})
   const binaryPath=join(dir,'fixture.bin'),depfile=join(dir,'fixture.d'),input=join(dir,'inputs.json'),header=Buffer.alloc(32)
   header.writeUInt32LE(0xfeedfacf);header.writeUInt32LE(cpuTypes.arm64,4)
   const binary=Buffer.concat([header,...modules.map(row=>row.packed)])
   writeFileSync(binaryPath,binary);writeFileSync(depfile,modules.map(row=>row.path).join(' '));writeFileSync(input,JSON.stringify({host_modules:rows}))
   const verify=()=>verifyBundle(binaryPath,depfile,dir,input,realpathSync(target),'arm64')
   need(verify().proof.length===3,'Whole split-module fixture failed')
   for(const module of modules.filter(row=>row.row.roles.some(role=>role.startsWith('rich')))){
    writeFileSync(binaryPath,Buffer.concat([header,...modules.filter(row=>row!==module).map(row=>row.packed)]));rejected(verify,'Binary without complete Rich module accepted');writeFileSync(binaryPath,binary)
    writeFileSync(module.path,brotliCompressSync(Buffer.concat([module.raw,Buffer.from(' altered')])));rejected(verify,'Altered Rich codegen module accepted');writeFileSync(module.path,module.packed)
    const distPath=join(dir,'assets',module.row.name);writeFileSync(distPath,Buffer.concat([module.raw,Buffer.from(' altered')]))
    rejected(verify,'Altered Rich source bundle accepted');writeFileSync(distPath,module.raw)
   }
   writeFileSync(input,JSON.stringify({host_modules:rows.filter(row=>!row.roles.includes('richFrontmatter'))}));rejected(verify,'Frozen inventory missing Rich module accepted')
   rmSync(host);writeFileSync(join(dir,'assets','share-editor.js'),full);rejected(()=>inspect(dir),'Share-only original roles accepted')
  }finally{rmSync(dir,{recursive:true,force:true})}
  console.log(JSON.stringify({ok:true,checks:['arm64-and-x86_64-Mach-O-positive','wrong-CPU-truncated-and-invalid-Mach-O-rejected','whole-module-recovery','missing-rejected','duplicate-rejected','six-role-split-module-witnesses','missing-role-and-share-only-rejected','rich-role-in-unrelated-chunk-rejected','full-synthetic-binary-depfile-frozen-inventory-proof','missing-Rich-binary-module-rejected','altered-Rich-cache-and-dist-rejected','missing-Rich-frozen-inventory-rejected']}))
 }else if(args[0]==='--inspect')console.log(JSON.stringify(inspect(realpathSync(args[1]))))
 else{
  need(args.length===5,'Expected [--arch arm64|x86_64] binary depfile dist frozen-inputs target-root')
  const [binaryPath,depfile,dist,input,target]=args.map(p=>realpathSync(resolve(p)))
  console.log(JSON.stringify(verifyBundle(binaryPath,depfile,dist,input,target,arch)))
 }
}catch(error){console.error(JSON.stringify({ok:false,error:error.message}));process.exitCode=1}
