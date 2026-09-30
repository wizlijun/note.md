#!/usr/bin/env node
// Hold an independent, nonpersistent native WebKit window for real CUA review.
// Production STRATA UI/bridge/CSP/Worker; synthetic RPC only, no note.md launch.
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
if (process.platform !== 'darwin') throw new Error('Native WebKit requires macOS')
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const output = await mkdtemp(join(tmpdir(), 'strata-webkit-ui-'))
const source = join(output, 'input'), served = join(output, 'served')
const run = (command, args, env = {}) => {
  const result=spawnSync(command,args,{cwd:repo,stdio:'inherit',env:{...process.env,...env}})
  if(result.status!==0) throw new Error(`${command} exited ${result.status}`)
}
console.log(`Native STRATA UI artifacts: ${output}`)
run('pnpm',['--filter','strata-plugin','build'])
await cp(join(repo,'plugins-src/strata/dist'),source,{recursive:true})
// Reuse the HTTP preview's single synthetic dataset without starting its
// server or replacing the production bridge. Fail if that fixture changes shape.
const preview=await readFile(join(repo,'plugins-src/strata/scripts/preview-fixture.mjs'),'utf8')
const start=preview.indexOf('const groups ='), end=preview.indexOf('\nlet atlas =',start)
if(start<0||end<0) throw new Error('Synthetic preview fixture contract changed')
const data=vm.runInNewContext(preview.slice(start,end)+'\n;({files,nodes,relations})',Object.create(null),{timeout:1000})
await writeFile(join(source,'fixture-data.json'),JSON.stringify(data))
await writeFile(join(source,'diagnostics.js'),`window.addEventListener('error',event=>window.webkit.messageHandlers.qa.postMessage({kind:'page-error',message:event.message,filename:event.filename}));window.addEventListener('unhandledrejection',event=>window.webkit.messageHandlers.qa.postMessage({kind:'rejection',message:String(event.reason)}));`)
const html=await readFile(join(source,'index.html'),'utf8')
await writeFile(join(source,'index.html'),html.replace('<head>','<head><script src="./diagnostics.js"></script>'))
await cp(source,served,{recursive:true})
run('cargo',['test','--manifest-path','src-tauri/Cargo.toml','--lib','plugin_runtime::protocol::tests::export_webkit_protocol_fixture','--','--exact'],{NOTEMD_WEBKIT_PLUGIN_ID:'notemd.strata',NOTEMD_WEBKIT_PLUGIN_ROOT:source,NOTEMD_WEBKIT_PROTOCOL_FIXTURE:served})
const app=join(output,'STRATA QA.app'), contents=join(app,'Contents')
await mkdir(join(contents,'MacOS'),{recursive:true})
const binary=join(contents,'MacOS','strata-webkit-ui')
await writeFile(join(contents,'Info.plist'),`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>strata-webkit-ui</string><key>CFBundleIdentifier</key><string>net.notemd.strata-qa</string><key>CFBundleName</key><string>STRATA QA</string><key>CFBundleDisplayName</key><string>STRATA QA</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1</string><key>NSHighResolutionCapable</key><true/><key>LSUIElement</key><false/></dict></plist>`)
run('xcrun',['swiftc',join(repo,'plugins-src/strata/scripts/webkit-worker.swift'),'-o',binary])
run('/usr/bin/open',['-n','--stdout',join(output,'native.log'),'--stderr',join(output,'native-error.log'),app,'--args',output,served,'--ui'])
console.log(`CUA app: ${app}`)
console.log('Bundle ID: net.notemd.strata-qa; production UI holds until its window is closed. No automatic UI clicks or screenshots.')
