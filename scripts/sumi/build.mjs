#!/usr/bin/env node
import { build } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { fileURLToPath } from 'node:url'
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import { corpus } from './corpus.mjs'
import { isolateTauri } from './isolate-tauri.mjs'
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..')
const output=path.resolve(process.argv[2]??path.join(os.tmpdir(),'sumi-editor-benchmark'))
await mkdir(output,{recursive:true})
for(const n of [10000,100000,1000000]) { await mkdir(path.join(output,'corpus'),{recursive:true});await writeFile(path.join(output,'corpus',`${n}.json`),JSON.stringify(corpus(n))); }
await build({configFile:false,root:path.join(repo,'scripts/sumi/browser'),base:'./',plugins:[isolateTauri(),svelte({hot:false})],resolve:{dedupe:['svelte','prosemirror-model','prosemirror-state','prosemirror-view']},build:{target:'safari16',outDir:path.join(output,'web'),emptyOutDir:true}})
const hash=async p=>createHash('sha256').update(await readFile(p)).digest('hex')
async function hashes(root,prefix=''){let result={};for(const entry of await readdir(path.join(root,prefix),{withFileTypes:true})){const relative=path.join(prefix,entry.name);if(entry.isDirectory())Object.assign(result,await hashes(root,relative));else result[relative]=await hash(path.join(root,relative));}return result}
const sourceFiles=['scripts/sumi/browser/index.html','scripts/sumi/browser/bootstrap.ts','scripts/sumi/browser/main.ts','scripts/sumi/browser/prelude.ts','scripts/sumi/browser/style.css','scripts/sumi/isolate-tauri.mjs','scripts/sumi/build.mjs','scripts/sumi/corpus.mjs','src/components/RichEditor.svelte','src/lib/editor-bridge.ts','src/editor-kit-v2/file-main.ts','tauri-plugin-native-editor/native/editor.m','tauri-plugin-native-editor/native/editor.h','tauri-plugin-native-editor/native/focus.h','write-core/src/document.rs','write-core/src/render.rs','write-core/src/selection.rs','pnpm-lock.yaml']
const identity={schema:1,built_at:new Date().toISOString(),git_head:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),machine:{platform:os.platform(),arch:os.arch(),release:os.release(),cpu:os.cpus()[0]?.model,total_memory:os.totalmem()},build:'Vite production minified, safari16 target; not Vite dev/HMR',artifacts:await hashes(path.join(output,'web')),sources:Object.fromEntries(await Promise.all(sourceFiles.map(async p=>[p,await hash(path.join(repo,p))])))}
await writeFile(path.join(output,'identity.json'),JSON.stringify(identity,null,2))
console.log(`Benchmark artifacts: ${output}\nServe: node scripts/sumi/serve.mjs ${output}`)
