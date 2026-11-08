// Read-only exclusion proof over the actual Mach-O and every build-depfile
// Tauri embedded asset. No estimate of DMG marginal savings is made here.
import { readFileSync, readdirSync, realpathSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { brotliDecompressSync, brotliCompressSync } from 'node:zlib'
import { createHash } from 'node:crypto'
const need=(ok,message)=>{if(!ok)throw Error(message)}
const hash=b=>createHash('sha256').update(b).digest('hex')
function clean(bytes, forbidden, label) {
 for(const item of forbidden) {
  need(!bytes.includes(item.raw),`${label}: migrated resource bytes remain: ${item.name}`)
  need(!bytes.includes(Buffer.from(item.raw.toString('base64'))),`${label}: migrated resource base64 remains: ${item.name}`)
 }
}
function inspectPacked(binary, packed, forbidden, label) {
 need(binary.includes(packed),'Depfile asset not found in actual Mach-O: '+label)
 const raw=brotliDecompressSync(packed)
 clean(raw,forbidden,label)
 return {compressedSha256:hash(packed),rawSha256:hash(raw),compressedBytes:packed.length,rawBytes:raw.length}
}
try {
 const args=process.argv.slice(2)
 if(args[0]==='--self-test') {
  const forbidden=[{name:'fixture.gif',raw:Buffer.from('GIF89a complete migrated fixture')}]
  const reject=f=>{let failed=false;try{f()}catch{failed=true}need(failed,'Forbidden fixture accepted')}
  clean(Buffer.from('host thin bridge'),forbidden,'good')
  reject(()=>clean(forbidden[0].raw,forbidden,'raw'))
  reject(()=>clean(Buffer.from(forbidden[0].raw.toString('base64')),forbidden,'base64'))
  const packed=brotliCompressSync(forbidden[0].raw)
  reject(()=>inspectPacked(Buffer.concat([Buffer.from('head'),packed]),packed,forbidden,'actual embedded forbidden'))
  const good=brotliCompressSync(Buffer.from('thin bridge'))
  inspectPacked(Buffer.concat([Buffer.from('head'),good]),good,forbidden,'good embedded')
  reject(()=>inspectPacked(Buffer.from('missing'),good,forbidden,'not actual'))
  console.log(JSON.stringify({ok:true,checks:['raw-and-base64-rejection','actual-brotli-forbidden-rejection','actual-clean-positive','missing-embedded-asset-rejected']}))
 } else {
  need(args.length===6,'Expected binary depfile dist target-root repo frozen-commit')
  const [binaryPath,depfile,dist,target,repo]=args.slice(0,5).map(p=>realpathSync(resolve(p))),commit=args[5]
  need(/^[0-9a-f]{40}$/.test(commit),'Frozen commit required')
  const git=(...a)=>execFileSync('git',['-C',repo,...a])
  const power='plugins-src/power-mode/public/assets/power-mode/'
  const font='plugins-src/write/resources/sumi/'
  const paths=git('ls-tree','-r','--name-only',commit,'--',power,font).toString().trim().split('\n').filter(Boolean)
  need(paths.filter(p=>p.startsWith(power)&&p.endsWith('.gif')).length===13,'Frozen 13 Power GIFs required')
  need(paths.filter(p=>p.startsWith(font)).length===10,'Frozen 10 Sumi metadata files required')
  const forbidden=paths.map(name=>({name,raw:git('show',commit+':'+name)}))
  const catalog=JSON.parse(git('show',commit+':'+font+'manifest.json'))
  for(const asset of catalog.assets)if(asset.url)forbidden.push({name:'font-download-url:'+asset.file,raw:Buffer.from(asset.url)})
  const binary=readFileSync(binaryPath);clean(binary,forbidden,'Mach-O')
  const walk=directory=>readdirSync(directory,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(join(directory,e.name)):[join(directory,e.name)])
  let distCount=0
  for(const path of walk(dist)){need(realpathSync(path).startsWith(dist+'/'),'Dist symlink escaped');clean(readFileSync(path),forbidden,path);distCount++}
  const dep=readFileSync(depfile,'utf8')
  const cache=[...new Set(dep.match(/\/[^\s:]*\/tauri-codegen-assets\/[a-f0-9]{64}(?:\.[^\s:]*)?(?=[\s:]|$)/g)??[])]
  need(cache.length>0,'No embedded resources in actual depfile')
  const proof=[]
  for(const path of cache){need(realpathSync(path).startsWith(target+'/'),'Codegen asset outside target');proof.push(inspectPacked(binary,readFileSync(path),forbidden,path))}
  console.log(JSON.stringify({ok:true,forbiddenSourceFiles:paths.map(name=>({name,sha256:hash(git('show',commit+':'+name))})),distFiles:distCount,embeddedResourceCount:proof.length,proof,scope:'Exact frozen raw/base64 content, download URLs, and every depfile-listed Brotli resource proven present in actual Mach-O; not a general decoder for arbitrary encodings or a DMG savings estimate.'}))
 }
} catch(e){console.error(JSON.stringify({ok:false,error:e.message}));process.exitCode=1}
