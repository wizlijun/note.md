"""Read-only verification of the exact v6.1117.1 macOS release artifacts.
Run only after source is tagged and the six uploaded assets are in TASK/host.
No application launch, user Vault access, install, or publication is performed.
"""
from pathlib import Path
import subprocess,json,hashlib,plistlib,base64,tempfile,importlib.util,tarfile,re,os,argparse
TASK=Path(__file__).resolve().parent
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source',type=Path,default=TASK.parent/'vault-release-20261114/source',help='Clean tagged build checkout with dist and src-tauri/target')
parser.add_argument('--stage',type=Path,default=TASK/'host',help='Directory containing the six exact downloaded GitHub assets')
parser.add_argument('--version',default='6.1117.1',help='Exact candidate version without v prefix')
args=parser.parse_args()
if not __debug__:raise RuntimeError('Run without Python optimization: verification assertions must remain enabled')
ROOT=args.source.resolve();STAGE=args.stage.resolve();TARGET=ROOT/'src-tauri/target'
VERSION=args.version;TAG='v'+VERSION;FEATURE='d56a538f97afe2870085581a5d75eac2624d37f7';FIX='5954dbbd25ea81297330bec518d55ab518ca856a'
assert re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+',VERSION),'Invalid candidate version'
required=[f'note.md-{VERSION}-aarch64.dmg','note.md-aarch64.app.tar.gz','note.md-aarch64.app.tar.gz.sig','latest.json','Fcitx5-for-Sumi-0.5.0.15-arm64.pkg','fcitx5-companion.json']
assert all((STAGE/name).is_file() for name in required),'Six downloaded candidate assets must be present before verification'
def git(*args):return subprocess.check_output(['git',*args],cwd=ROOT)
SOURCE=git('rev-parse',TAG+'^{}').decode().strip()
assert git('rev-parse','HEAD').decode().strip()==SOURCE,'Build checkout is not frozen tag'
assert not git('status','--porcelain').strip(),'Build checkout has modifications'
for commit in [FEATURE,FIX]:subprocess.run(['git','merge-base','--is-ancestor',commit,SOURCE],cwd=ROOT,check=True)
spec=importlib.util.spec_from_file_location('checks',ROOT/'scripts/sumi/artifact_checks.py')
h=importlib.util.module_from_spec(spec);spec.loader.exec_module(h)
report={'sourceCommit':SOURCE,'featureCommit':FEATURE,'fixCommit':FIX,'version':VERSION,'architecture':'arm64','limits':'Read-only source/tag and actual signed artifact proof. No App launch, installation, native GUI interaction or user Vault operation.'}
def run(args):return h.check_command(report,list(map(str,args)))
app=TARGET/'aarch64-apple-darwin/release/bundle/macos/note.md.app'
binary=app/'Contents/MacOS/notemd';dep=TARGET/'aarch64-apple-darwin/release/notemd.d';dist=ROOT/'dist'
h.verify_app_identity(plistlib.loads((app/'Contents/Info.plist').read_bytes()),VERSION)
assert run(['/usr/bin/lipo','-archs',binary])=='arm64'
run(['/usr/bin/codesign','--verify','--deep','--strict','--verbose=2',app])
run(['/usr/sbin/spctl','--assess','--type','execute','--verbose=4',app])
assert 'Notarized Developer ID' in report['commands'][-1]['stderr']
run(['/usr/bin/xcrun','stapler','validate',app])
run(['/usr/bin/codesign','-dvv',app]);assert 'TeamIdentifier=T5G56DH47L' in report['commands'][-1]['stderr']
ent=plistlib.loads(subprocess.check_output(['/usr/bin/codesign','-d','--entitlements',':-',str(app)],stderr=subprocess.DEVNULL))
assert ent['com.apple.security.personal-information.location'] and ent['com.apple.security.automation.apple-events']
report['entitlements']=ent
modules=json.loads(run(['node',ROOT/'scripts/sumi/verify-embedded.mjs','--inspect',dist]))
(STAGE/'embedded-inputs.json').write_text(json.dumps({'host_modules':modules})+'\n')
report['embeddedModules']=json.loads(run(['node',ROOT/'scripts/sumi/verify-embedded.mjs','--arch','arm64',binary,dep,dist,STAGE/'embedded-inputs.json',TARGET]))
report['embeddedAllAssets']=json.loads(run(['node',ROOT/'scripts/sumi/verify-extracted-assets.mjs',binary,dep,dist,TARGET,ROOT,SOURCE]))
embedded_hashes={row['rawSha256'] for row in report['embeddedAllAssets']['proof']}
raw=binary.read_bytes();js_assets={p:p.read_text() for p in (dist/'assets').glob('*.js')}
commands=['vault_inspect','vault_create','vault_activate','vault_init_git','vault_set_sync','vault_set_onboarding','vault_sync_now_for_root','notemd_vault_stats','notemd_vault_stats_cancel','take_vault_management_request','open_vault_sync_logs']
for command in commands:assert command.encode() in raw,'Missing native command: '+command
tokens=commands+['vault-management-open','vault-root-changed','vaultManage.start','vaultManage.changeWarning','vaultManage.confirmChange','vaultOverview.contentSize','vaultOverview.documents','vaultOverview.partial']
i18n_keys=['vaultManage.start','vaultManage.skip','vaultManage.changeWarning','vaultManage.initConfirm','vaultOverview.documents','vaultOverview.contentSize']
i18n_values={}
for locale in ['en','zh','ja','de']:
 source_path=f'src/lib/i18n/{locale}.ts';text=git('show',SOURCE+':'+source_path).decode()
 for key in i18n_keys:
  match=re.search(r'^\s*'+re.escape(json.dumps(key))+r':\s*("(?:[^"\\]|\\.)*")',text,re.M)
  assert match,'Missing frozen localization: '+locale+':'+key
  value=json.loads(match.group(1));tokens.append(value);i18n_values[locale+':'+key]=value
witnesses=[]
for token in tokens:
 matching=[p for p,text in js_assets.items() if token in text or json.dumps(token,ensure_ascii=True)[1:-1] in text]
 assert matching,'Missing actual frontend token: '+token
 for p in matching:assert h.file_info(p)['sha256'] in embedded_hashes,'Token asset not embedded in binary: '+p.name
 witnesses.append({'token':token,'assets':[p.name for p in matching]})
lib=git('show',SOURCE+':src-tauri/src/lib.rs').decode()
assert lib.count('MenuItemBuilder::with_id("vault-management",')==1
assert '"tray-sync-repo" => { show_vault_management(app); }' in lib
assert 'fn pick_sync_folder(' not in lib
assert 'path.strip_prefix(home)' in lib
app_source=git('show',SOURCE+':src/App.svelte').decode()
assert 'initializeVaultOnboarding()' in app_source and 'onboardingShownThisRun' in app_source and 'win.isVisible()' in app_source
assert '<VaultOnboarding />' in app_source
assert '<VaultOverview />' in git('show',SOURCE+':src/components/EmptyState.svelte').decode()
assert '<DesktopVaultSettings ' in git('show',SOURCE+':src/components/SettingsDialog.svelte').decode()
settings=git('show',SOURCE+':src/components/DesktopVaultSettings.svelte').decode()
assert 'prepareVaultChange' in settings and 'confirmChange' in settings and 'advancedOpen = $state(false)' in settings
management=git('show',SOURCE+':src/lib/vault-management.svelte.ts').decode()
assert "if (info.root) openSettings('vault')" in management and 'else showVaultOnboarding()' in management
assert 'abbreviateHome' in management and 'return `~${path.slice(normalizedHome.length)}`' in management
overview=git('show',SOURCE+':src/components/VaultOverview.svelte').decode()
assert all(token in overview for token in ['abbreviateHome(root,', 'stats.documents.toLocaleString', 'formatContentBytes(stats.bytes)', 'writeText(root)', 'revealItemInDir(root)'])
for component,text in [('DesktopVaultSettings.svelte',settings),('VaultOverview.svelte',overview)]:
 assert 'import { revealItemInDir }' in text and 'openPath' not in text,'Wrong reveal API in '+component
assert 'await revealItemInDir(info!.root!)' in settings
assert 'revealItemInDir(root)' in overview
assert 'opener:default' in git('show',SOURCE+':src-tauri/capabilities/default.json').decode()
onboarding=git('show',SOURCE+':src/components/VaultOnboarding.svelte').decode()
assert 'skipVaultOnboarding()' in onboarding and 'vaultManagement.info?.root) return' in onboarding
assert 'abbreviateHome(path,' in onboarding and 'abbreviateHome(' in settings
for changelog in ['CHANGELOG.md','CHANGELOG.zh-CN.md']:
 changelog_text=git('show',SOURCE+':'+changelog).decode()
 sections=changelog_text.split('\n## ')[1:]
 section=next((text for text in sections if text.splitlines()[0].startswith(TAG+' ')),None)
 assert section and 'Vault' in section,'Missing Vault fix note for frozen version: '+changelog
 assert ('reveal and select the Vault folder' in section if changelog=='CHANGELOG.md' else '定位并选中 Vault 目录' in section),'Missing exact reveal fix note: '+changelog
 previous=next((text for text in sections if text.splitlines()[0].startswith('v6.1116.1 ')),None)
 assert previous and 'Vault' in previous and '~' in previous,'Missing original Vault release history'
report['vaultFeatures']={'nativeCommands':commands,'i18n':i18n_values,'frontendTokenWitnesses':witnesses,'sourceChecks':['single-main-menu-entry','tray-management-route','no-old-immediate-picker','home-component-boundary','visible-GUI-onboarding','advanced-protected-change','welcome-path-document-count-content-size','all-three-surfaces-home-abbreviation','absolute-copy-and-reveal-paths','skippable-onboarding-create-guard','frozen-release-changelog','both-Vault-components-use-revealItemInDir-without-openPath'],'proof':'Frozen feature source ancestry and exact source hashes plus all corresponding frontend resources proven present inside the signed Mach-O. These checks do not replace native GUI end-to-end acceptance.'}

def verify_reveal_bundle(js_assets, embedded_hashes):
 """Bind both generated Vault event-handler contexts to the opener reveal export.
 This proves exact compiled callsites, not native Finder interaction.
 """
 witnesses=[]
 for key,span in [('vaultOverview.reveal',400),('vaultManage.reveal',850)]:
  matches=[]
  for path,text in js_assets.items():
   for binding in re.finditer(r'import\{([^}]+)\}from["\'](\./[^"\']+)["\'];',text):
    alias=re.search(r'(?:^|,)revealItemInDir(?: as ([$\w]+))?(?:,|$)',binding.group(1))
    if not alias:continue
    local=alias.group(1) or 'revealItemInDir'
    module=(path.parent/binding.group(2)).resolve()
    module_text=next((value for file,value in js_assets.items() if file.resolve()==module),None)
    assert module_text and 'plugin:opener|reveal_item_in_dir' in module_text,'Missing reveal IPC module'
    marker=re.search(r'[$\w]+\("'+re.escape(key)+r'"\)',text)
    if not marker:continue
    context=text[marker.start():marker.end()+span]
    assert re.search(r'(?<![$\w])'+re.escape(local)+r'\(',context),'Vault action does not call bound reveal API: '+key
    for file in [path,module]:
     assert hashlib.sha256(file.read_bytes()).hexdigest() in embedded_hashes,'Reveal callsite/module not embedded: '+str(file)
    matches.append({'key':key,'asset':path.name,'assetSha256':hashlib.sha256(path.read_bytes()).hexdigest(),'revealModule':module.name,'revealModuleSha256':hashlib.sha256(module.read_bytes()).hexdigest(),'localBinding':local,'compiledContext':context})
  assert len(matches)==1,'Expected exactly one compiled reveal witness for '+key
  witnesses.extend(matches)
 return witnesses
assert b'reveal_item_in_dir' in raw,'Missing native opener reveal command'
report['vaultRevealFix']={'commit':FIX,'compiledCallsites':verify_reveal_bundle(js_assets,embedded_hashes),'scope':'Both frozen components contain revealItemInDir and no openPath. Their generated event-handler contexts bind to the actual opener reveal IPC export; complete containing modules are proven inside the signed Mach-O. Native Finder GUI operation is not executed.'}

report['appBinary']=h.file_info(binary)
tar=STAGE/'note.md-aarch64.app.tar.gz';sig=STAGE/'note.md-aarch64.app.tar.gz.sig';dmg=STAGE/f'note.md-{VERSION}-aarch64.dmg'
report['updaterIdentity']=h.verify_archive_identity(tar,VERSION)
with tempfile.TemporaryDirectory(prefix='vault-release-verify-') as td:
 td=Path(td);h.unpack_binary(tar,'note.md.app/Contents/MacOS/notemd',td/'binary')
 assert h.file_info(td/'binary')['sha256']==report['appBinary']['sha256']
 (td/'signature').write_bytes(base64.b64decode(sig.read_bytes().strip(),validate=True))
 key=base64.b64decode(json.loads((ROOT/'src-tauri/tauri.conf.json').read_text())['plugins']['updater']['pubkey']).decode().splitlines()[1]
 run(['minisign','-V','-P',key,'-m',tar,'-x',td/'signature'])
report['dmg']=h.file_info(dmg)
run(['/usr/bin/xcrun','stapler','validate',dmg]);run(['/usr/bin/codesign','--verify','--strict','--verbose=2',dmg])
run(['/usr/sbin/spctl','--assess','--type','open','--context','context:primary-signature','--verbose=4',dmg])
code=(app/'Contents/_CodeSignature/CodeResources').read_bytes()
def resources(candidate):assert (candidate/'Contents/_CodeSignature/CodeResources').read_bytes()==code
h.verify_dmg_binary(report,dmg,report['appBinary']['sha256'],VERSION,resources)
with tarfile.open(tar,'r:gz') as archive:
 seen=set()
 for member in archive.getmembers():
  name=member.name.removeprefix('./');parts=Path(name).parts
  assert parts and parts[0]=='note.md.app' and '..' not in parts and not Path(name).is_absolute()
  rel=Path(*parts[1:]);local=app/rel
  if member.isdir():assert local.is_dir();continue
  assert str(rel) not in seen;seen.add(str(rel))
  if member.issym():assert local.is_symlink() and os.readlink(local)==member.linkname
  else:
   assert member.isfile() and local.is_file() and not local.is_symlink()
   assert member.mode & 0o777 == local.stat().st_mode & 0o777
   stream=archive.extractfile(member);assert stream is not None
   assert hashlib.file_digest(stream,'sha256').hexdigest()==h.file_info(local)['sha256']
 assert seen=={str(p.relative_to(app)) for p in app.rglob('*') if p.is_symlink() or p.is_file()}
 report['updaterEntireAppFilesIdentical']=len(seen)
latest=json.loads((STAGE/'latest.json').read_text())
assert latest['version']==VERSION and list(latest['platforms'])==['darwin-aarch64']
assert latest['platforms']['darwin-aarch64']['signature']==sig.read_text().strip()
assert latest['platforms']['darwin-aarch64']['url']==f'https://github.com/wizlijun/note.md/releases/download/{TAG}/note.md-aarch64.app.tar.gz'
approval=json.loads((STAGE/'fcitx5-companion.json').read_text())
assert approval==json.loads(git('show',SOURCE+':scripts/release-companions/fcitx5.json'))
assert approval['version']=='0.5.0.15'
pkginfo=h.file_info(STAGE/approval['filename']);assert pkginfo['bytes']==approval['bytes'] and pkginfo['sha256']==approval['sha256']
report['companion']={'approval':approval,'package':pkginfo}
names=[dmg.name,tar.name,sig.name,'latest.json',approval['filename'],'fcitx5-companion.json']
assets=[{'name':name,'path':str(STAGE/name),'size':(STAGE/name).stat().st_size,'sha256':h.file_info(STAGE/name)['sha256']} for name in names]
source_files=git('diff-tree','--no-commit-id','--name-only','-r',FEATURE).decode().splitlines()
source_files+=git('diff-tree','--no-commit-id','--name-only','-r',FIX).decode().splitlines()
source_files+=['src-tauri/capabilities/default.json','package.json','src-tauri/tauri.conf.json','src-tauri/Cargo.toml','src-tauri/Cargo.lock','scripts/release-companions/fcitx5.json']
report['sourceFiles']={}
for path in sorted(set(source_files)):
 source_bytes=git('show',SOURCE+':'+path)
 assert (ROOT/path).read_bytes()==source_bytes,'Build source differs from frozen tag: '+path
 report['sourceFiles'][path]=hashlib.sha256(source_bytes).hexdigest()
assert not git('status','--porcelain').strip()
(STAGE/'artifact-verification.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
(STAGE/'host-assets.json').write_text(json.dumps({'sourceCommit':SOURCE,'version':VERSION,'assets':assets},indent=2)+'\n')
(TASK/'frozen-source.json').write_text(json.dumps({'source':SOURCE,'feature':FEATURE,'fix':FIX,'tag':TAG,'changedFiles':source_files},indent=2)+'\n')
print(json.dumps({'ok':True,'source':SOURCE,'assets':len(assets),'report':str(STAGE/'artifact-verification.json')}))
