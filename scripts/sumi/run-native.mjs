#!/usr/bin/env node
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { readFile,writeFile,mkdir } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..')
const output=path.resolve(process.argv.slice(2).find(arg=>!arg.startsWith('--'))??path.join(os.tmpdir(),'sumi-editor-benchmark'))
const smoke=process.argv.includes('--smoke')
const hash=async p=>createHash('sha256').update(await readFile(p)).digest('hex')
const inputs=['scripts/sumi/native/runner.m','scripts/sumi/native/src/main.rs','scripts/sumi/native/Cargo.lock','tauri-plugin-native-editor/native/editor.m','tauri-plugin-native-editor/native/editor.h','write-core/src/document.rs','write-core/src/render.rs','write-core/src/selection.rs']
const before=Object.fromEntries(await Promise.all(inputs.map(async p=>[p,await hash(path.join(repo,p))])))
execFileSync('cargo',['+1.99.0','build','--release','--offline','--locked','--manifest-path','scripts/sumi/native/Cargo.toml'],{cwd:repo,env:{...process.env,CARGO_TARGET_DIR:path.join(repo,'write-core/target')},stdio:'inherit'})
const binary=path.join(repo,'write-core/target/release/sumi-native-benchmark')
await mkdir(path.join(output,'reports'),{recursive:true})
for(const size of [10000,100000]){
 const destination=path.join(output,'reports',`native-${size}-${Date.now()}.json`)
 execFileSync(binary,[path.join(output,'corpus',`${size}.json`),path.join(repo,'src-tauri/resources/sumi'),destination,...(smoke?['1','20','10']:['5','1000','100'])],{cwd:repo,stdio:'inherit',timeout:20*60*1000})
 const report=JSON.parse(await readFile(destination,'utf8'))
 const after=Object.fromEntries(await Promise.all(inputs.map(async p=>[p,await hash(path.join(repo,p))])))
 report.identity={binary_sha256:await hash(binary),source_before:before,source_after:after,source_stable:JSON.stringify(before)===JSON.stringify(after),machine:{platform:os.platform(),arch:os.arch(),release:os.release(),cpu:os.cpus()[0]?.model,total_memory:os.totalmem()},git_head:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim()}
 await writeFile(destination,JSON.stringify(report,null,2))
 if(!report.identity.source_stable)throw new Error(`Source changed during run; evidence invalid: ${destination}`)
 console.log(`Native pipeline report: ${destination}`)
}
