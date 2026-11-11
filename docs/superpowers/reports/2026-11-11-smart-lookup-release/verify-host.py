from pathlib import Path
import subprocess,json,hashlib,plistlib,base64,tempfile,importlib.util,tarfile,re,os
TASK=Path(__file__).resolve().parent;ROOT=TASK/'source';STAGE=TASK/'host';TARGET=ROOT/'src-tauri/target';VERSION='6.1111.3'
frozen=json.loads((TASK/'frozen-source.json').read_text());SOURCE=frozen['source']
spec=importlib.util.spec_from_file_location('checks',ROOT/'scripts/sumi/artifact_checks.py');h=importlib.util.module_from_spec(spec);spec.loader.exec_module(h)
report={'sourceCommit':SOURCE,'version':VERSION,'architecture':'arm64','limits':'Read-only exact artifact/source proof and source tests; no user App replacement, GUI launch or physical keyboard claim.'}
def run(a):return h.check_command(report,list(map(str,a)))
def git(*a):return subprocess.check_output(['git',*a],cwd=ROOT)
assert git('rev-parse','HEAD').decode().strip()==SOURCE
assert not git('status','--porcelain').strip()
app=TARGET/'aarch64-apple-darwin/release/bundle/macos/note.md.app';binary=app/'Contents/MacOS/notemd';dep=TARGET/'aarch64-apple-darwin/release/notemd.d';dist=ROOT/'dist'
h.verify_app_identity(plistlib.loads((app/'Contents/Info.plist').read_bytes()),VERSION)
assert run(['/usr/bin/lipo','-archs',binary])=='arm64'
run(['/usr/bin/codesign','--verify','--deep','--strict','--verbose=2',app]);run(['/usr/sbin/spctl','--assess','--type','execute','--verbose=4',app]);assert 'Notarized Developer ID' in report['commands'][-1]['stderr'];run(['/usr/bin/xcrun','stapler','validate',app])
run(['/usr/bin/codesign','-dvv',app]);assert 'TeamIdentifier=T5G56DH47L' in report['commands'][-1]['stderr']
ent=plistlib.loads(subprocess.check_output(['/usr/bin/codesign','-d','--entitlements',':-',str(app)],stderr=subprocess.DEVNULL));assert ent['com.apple.security.personal-information.location'] and ent['com.apple.security.automation.apple-events'];report['entitlements']=ent
modules=json.loads(run(['node',ROOT/'scripts/sumi/verify-embedded.mjs','--inspect',dist]));(STAGE/'embedded-inputs.json').write_text(json.dumps({'host_modules':modules})+'\n')
report['embeddedModules']=json.loads(run(['node',ROOT/'scripts/sumi/verify-embedded.mjs','--arch','arm64',binary,dep,dist,STAGE/'embedded-inputs.json',TARGET]))
report['embeddedAllAssets']=json.loads(run(['node',ROOT/'scripts/sumi/verify-extracted-assets.mjs',binary,dep,dist,TARGET,ROOT,SOURCE]))
# Prove the plugin-market module itself, not only Sumi bridge chunks.
assets=list((dist/'assets').glob('pluginMarket-*.js'));assert assets
market=[p for p in assets if 'notemd.health-sync' in p.read_text() and 'notemd.apple-notes' in p.read_text()];assert market
# Every depfile Brotli asset is checked above as contained in the actual binary.
report['marketAssets']=[h.file_info(p) for p in market]
embedded_hashes={row['rawSha256'] for row in report['embeddedAllAssets']['proof']}
assert all(row['sha256'] in embedded_hashes for row in report['marketAssets'])
raw=binary.read_bytes()
for label in ['捕捉','写作','数据导入导出','Other','notemd.health-sync','notemd.apple-notes']:
 assert label.encode() in raw,'Missing native label/id: '+label
report['nativeMenuLabelsPresent']=True
# Tie the answer-first window, API calls and i18n to actual depfile assets
# already recovered and proved present in the signed Mach-O above.
js_assets={p:p.read_text() for p in (dist/'assets').glob('*.js')}
smart_tokens=['smart_lookup_local','smart_lookup_evidence_step','smart_lookup_answer',
              'smart_lookup_cancel','smartSearch.progress.write','smartSearch.answer.localFirst',
              'smartSearch.answer.sources','smartSearch.launch.enhanceOn',
              'settings.enhance.enabled','settings.enhance.chatConsentHint']
i18n_source_paths=['src/lib/i18n/en.ts','src/lib/i18n/zh.ts']
i18n_keys=['settings.enhance.enabled','smartSearch.launch.enhanceOn',
           'smartSearch.progress.write','smartSearch.answer.localFirst']
i18n_values={}
for source_path in i18n_source_paths:
 text=git('show',SOURCE+':'+source_path).decode()
 for key in i18n_keys:
  match=re.search(r'^\s*'+re.escape(json.dumps(key))+r':\s*("(?:[^"\\]|\\.)*")',text,re.M)
  assert match,'Frozen answer-first translation missing: '+source_path+':'+key
  value=json.loads(match.group(1));smart_tokens.append(value)
  i18n_values[source_path+':'+key]=value
witnesses=[]
for token in smart_tokens:
 matching=[p for p,text in js_assets.items() if token in text or json.dumps(token,ensure_ascii=True)[1:-1] in text]
 assert matching,'Answer-first token absent from built JS: '+token
 for p in matching:
  assert h.file_info(p)['sha256'] in embedded_hashes,'Smart Lookup JS not proven in actual Mach-O: '+p.name
 witnesses.append({'token':token,'assets':[p.name for p in matching]})
smart_assets=sorted({p for p,text in js_assets.items() if any(token in text or json.dumps(token,ensure_ascii=True)[1:-1] in text for token in smart_tokens)})
entry=(dist/'smart-search.html').read_text()
assert any(p.name.startswith('smartSearch-') and p.name in entry for p in smart_assets),'Smart Lookup entry does not load the proved JS'
for command in ['smart_lookup_local','smart_lookup_evidence_step','smart_lookup_answer','smart_lookup_cancel']:
 assert command.encode() in raw,'Missing actual native command: '+command
native_prompts={}
for source_path,name in [('src-tauri/src/smart_enhance/answer.rs','ANSWER_SYSTEM'),
                         ('src-tauri/src/smart_enhance/sag/mod.rs','CRITERION')]:
 text=git('show',SOURCE+':'+source_path).decode()
 match=re.search(r'const '+name+r': &str = ("(?:[^"\\]|\\.)*");',text)
 assert match,'Frozen native prompt missing: '+name
 prompt=json.loads(match.group(1));assert prompt.encode() in raw,'Native prompt absent from actual Mach-O: '+name
 native_prompts[name]={'source':source_path,'sha256':hashlib.sha256(prompt.encode()).hexdigest(),'bytes':len(prompt.encode())}
report['smartLookupAnswerFirst']={'assets':[h.file_info(p) for p in smart_assets],
 'i18n':i18n_values,'tokenWitnesses':witnesses,'nativeCommandsPresent':True,
 'nativePrompts':native_prompts,'proof':'Whole JS hashes match depfile-listed Brotli assets present in the actual signed Mach-O; native command strings and exact frozen answer/SAG2 prompts are present in that same binary. This does not claim GUI or real model endpoint acceptance.'}
report['appBinary']=h.file_info(binary)
tar=STAGE/'note.md-aarch64.app.tar.gz';sig=STAGE/'note.md-aarch64.app.tar.gz.sig';dmg=STAGE/f'note.md-{VERSION}-aarch64.dmg'
report['updaterIdentity']=h.verify_archive_identity(tar,VERSION)
with tempfile.TemporaryDirectory(prefix='smart-lookup-release-verify-') as t:
 t=Path(t);h.unpack_binary(tar,'note.md.app/Contents/MacOS/notemd',t/'binary');assert h.file_info(t/'binary')['sha256']==report['appBinary']['sha256']
 (t/'signature').write_bytes(base64.b64decode(sig.read_bytes().strip(),validate=True))
 key=base64.b64decode(json.loads((ROOT/'src-tauri/tauri.conf.json').read_text())['plugins']['updater']['pubkey']).decode().splitlines()[1]
 run(['minisign','-V','-P',key,'-m',tar,'-x',t/'signature'])
report['dmg']=h.file_info(dmg);run(['/usr/bin/xcrun','stapler','validate',dmg]);run(['/usr/bin/codesign','--verify','--strict','--verbose=2',dmg]);run(['/usr/sbin/spctl','--assess','--type','open','--context','context:primary-signature','--verbose=4',dmg])
code=(app/'Contents/_CodeSignature/CodeResources').read_bytes()
def resources(candidate):assert (candidate/'Contents/_CodeSignature/CodeResources').read_bytes()==code
h.verify_dmg_binary(report,dmg,report['appBinary']['sha256'],VERSION,resources)
with tarfile.open(tar,'r:gz') as a:
 seen=set()
 for member in a.getmembers():
  name=member.name.removeprefix('./');parts=Path(name).parts
  assert parts and parts[0]=='note.md.app' and '..' not in parts and not Path(name).is_absolute()
  rel=Path(*parts[1:]);local=app/rel
  if member.isdir(): assert local.is_dir();continue
  assert str(rel) not in seen;seen.add(str(rel))
  if member.issym(): assert local.is_symlink() and os.readlink(local)==member.linkname
  else:
   assert member.isfile() and local.is_file() and not local.is_symlink()
   assert member.mode & 0o777 == local.stat().st_mode & 0o777
   stream=a.extractfile(member);assert stream is not None
   assert hashlib.file_digest(stream,'sha256').hexdigest()==h.file_info(local)['sha256']
 expected={str(p.relative_to(app)) for p in app.rglob('*') if p.is_symlink() or p.is_file()}
 assert seen==expected
 report['updaterEntireAppFilesIdentical']=len(seen)
latest=json.loads((STAGE/'latest.json').read_text());assert latest['version']==VERSION and list(latest['platforms'])==['darwin-aarch64'];assert latest['platforms']['darwin-aarch64']['signature']==sig.read_text().strip();assert latest['platforms']['darwin-aarch64']['url']==f'https://github.com/wizlijun/note.md/releases/download/v{VERSION}/note.md-aarch64.app.tar.gz'
approval=json.loads((STAGE/'faitc5-companion.json').read_text());assert approval==json.loads((ROOT/'scripts/release-companions/faitc5.json').read_text())
pkginfo=h.file_info(STAGE/approval['filename']);assert pkginfo['bytes']==approval['bytes'] and pkginfo['sha256']==approval['sha256']
names=[dmg.name,tar.name,sig.name,'latest.json',approval['filename'],'faitc5-companion.json']
assets=[{'name':n,'path':str(STAGE/n),'size':(STAGE/n).stat().st_size,'sha256':h.file_info(STAGE/n)['sha256']} for n in names]
smart_source_files=['src/SmartLookupApp.svelte','src/components/SettingsDialog.svelte',
 'src/components/smart-lookup/LaunchView.svelte','src/lib/smart-search/api.ts',
 'src/lib/smart-search/answer-view.ts','src/lib/smart-search/evidence-flow.ts',
 'src/lib/smart-search/settings.ts','src-tauri/src/lib.rs','src-tauri/src/smart_lookup.rs',
 'src-tauri/src/lookup_params.rs','src-tauri/src/smart_enhance/answer.rs',
 'src-tauri/src/smart_enhance/evidence.rs','searchidx/src/sag.rs',
 'src/lib/i18n/en.ts','src/lib/i18n/zh.ts','src/lib/i18n/ja.ts','src/lib/i18n/de.ts']
smart_source_files+=git('ls-tree','-r','--name-only',SOURCE,'--','src-tauri/src/smart_enhance/sag').decode().splitlines()
source_files=sorted(set(frozen['changedFiles'])|set(smart_source_files))
report['sourceFiles']={}
for p in source_files:
 source_bytes=git('show',SOURCE+':'+p)
 assert (ROOT/p).read_bytes()==source_bytes,'Build source differs from frozen tag: '+p
 report['sourceFiles'][p]=hashlib.sha256(source_bytes).hexdigest()
report['smartLookupAnswerFirst']['frozenSourceFiles']=smart_source_files
assert not git('status','--porcelain').strip()
(STAGE/'artifact-verification.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
(STAGE/'host-assets.json').write_text(json.dumps({'sourceCommit':SOURCE,'version':VERSION,'assets':assets},indent=2)+'\n')
print(json.dumps({'ok':True,'source':SOURCE,'assets':len(assets),'report':str(STAGE/'artifact-verification.json')}))
