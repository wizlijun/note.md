// Read-only whole-module proof, following scripts/release-share-payload.mjs.
// Does not execute the host or prove runtime routing/physical input.
import { readFileSync, readdirSync, realpathSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { brotliDecompressSync, brotliCompressSync } from 'node:zlib'
const need=(ok,message)=>{if(!ok)throw Error(message)}
const sha=b=>createHash('sha256').update(b).digest('hex')
const roles={native:['native-editor-region','sumi-action','sumi-navigation','plugin_v2_open_window'],recovery:['sumi_restore_projection','恢复为新的一页','重新检查源文件'],exit:['sumi-before-exit','finish_sumi_exit'],source:['sumi_source_save','sumi_rebase_draft','sumi_detach']}
function inspect(dist){
 const rows=readdirSync(join(dist,'assets')).filter(n=>n.endsWith('.js')&&!n.startsWith('share-editor')).flatMap(name=>{
  const raw=readFileSync(join(dist,'assets',name)),text=raw.toString(),found=Object.keys(roles).filter(role=>roles[role].every(token=>text.includes(token)))
  return found.length?[{name,sha256:sha(raw),bytes:raw.length,roles:found}]:[]
 }).sort((a,b)=>a.name.localeCompare(b.name))
 need(Object.keys(roles).every(role=>rows.some(row=>row.roles.includes(role))),'Missing host native/recovery/exit/source JS role')
 return rows
}
function recover(binary,compressed){const at=binary.indexOf(compressed);need(at>=0&&binary.indexOf(compressed,at+1)<0,'Missing or duplicate whole compressed module');return {offset:at,raw:brotliDecompressSync(binary.subarray(at,at+compressed.length))}}
try{
 if(process.argv[2]==='--self-test'){
  const raw=Buffer.from('fixture'),packed=brotliCompressSync(raw);need(recover(Buffer.concat([Buffer.from('head'),packed]),packed).raw.equals(raw),'recover failed')
  for(const bytes of [Buffer.from('absent'),Buffer.concat([packed,packed])]){let failed=false;try{recover(bytes,packed)}catch{failed=true}need(failed,'negative containment accepted')}
  const dir=mkdtempSync(join(tmpdir(),'sumi-modules-test-'))
  try{mkdirSync(join(dir,'assets'));const full=Object.values(roles).flat().join(' ');writeFileSync(join(dir,'assets','host.js'),full);need(inspect(dir).length===1,'Role-positive fixture failed')
   for(const tokens of Object.values(roles)){writeFileSync(join(dir,'assets','host.js'),full.replace(tokens[0],''));let failed=false;try{inspect(dir)}catch{failed=true}need(failed,'Missing host role accepted')}
   rmSync(join(dir,'assets','host.js'));writeFileSync(join(dir,'assets','share-editor.js'),full);let failed=false;try{inspect(dir)}catch{failed=true}need(failed,'Share-only roles accepted')
  }finally{rmSync(dir,{recursive:true,force:true})}
  console.log(JSON.stringify({ok:true,checks:['whole-module-recovery','missing-rejected','duplicate-rejected','four-role-witnesses','missing-role-and-share-only-rejected']}))
 }else if(process.argv[2]==='--inspect')console.log(JSON.stringify(inspect(realpathSync(process.argv[3]))))
 else{
  need(process.argv.length===7,'Expected binary depfile dist frozen-inputs target-root')
  const [binaryPath,depfile,dist,input,target]=process.argv.slice(2).map(p=>realpathSync(resolve(p)))
  const frozen=JSON.parse(readFileSync(input)),rows=inspect(dist);need(JSON.stringify(rows)===JSON.stringify(frozen.host_modules),'Host modules differ from frozen inputs')
  const binary=readFileSync(binaryPath);need(binary.subarray(0,4).toString('hex')==='cffaedfe'&&binary.readUInt32LE(4)===16777228,'Expected thin arm64 Mach-O')
  need(!binary.includes(Buffer.from('net.notemd.sumi.acceptance')),'Isolated acceptance identity in release binary')
  const paths=[...new Set(readFileSync(depfile,'utf8').match(/\/[^\s:]*\/tauri-codegen-assets\/[a-f0-9]{64}\.js(?=[\s:]|$)/g)??[])],proof=[]
  for(const path of paths){need(realpathSync(path).startsWith(target+'/'),'Codegen cache outside target');const packed=readFileSync(path),raw=brotliDecompressSync(packed),hash=sha(raw);if(!rows.some(row=>row.sha256===hash))continue;const recovered=recover(binary,packed);need(recovered.raw.equals(raw),'Recovered module differs');proof.push({sha256:hash,compressed_sha256:sha(packed),offset:recovered.offset})}
  need(rows.every(row=>proof.filter(p=>p.sha256===row.sha256).length===1),'Frozen host module not proven in binary')
  console.log(JSON.stringify({ok:true,modules:rows,proof,runtimeRoutingVerified:false,physicalInputVerified:false}))
 }
}catch(error){console.error(JSON.stringify({ok:false,error:error.message}));process.exitCode=1}
