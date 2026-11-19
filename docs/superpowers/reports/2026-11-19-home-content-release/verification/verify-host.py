"""Read-only verification of the exact v6.1119.2 macOS release artifacts.
Run only after source is tagged and the six uploaded assets are in TASK/host.
No application launch, user Vault access, install, or publication is performed.
"""
from pathlib import Path
import subprocess,json,hashlib,plistlib,base64,tempfile,importlib.util,tarfile,re,os,argparse
TASK=Path(__file__).resolve().parent
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source',type=Path,default=Path('/Users/bruce/git/mdeditor/tasks/vault-release-20261114/source'),help='Clean tagged build checkout with dist and src-tauri/target')
parser.add_argument('--stage',type=Path,default=TASK/'host',help='Directory containing the six exact downloaded GitHub assets')
parser.add_argument('--version',default='6.1119.2',help='Exact candidate version without v prefix')
parser.add_argument('--app-submission-id',required=True,help='Current App submission ID bound by captured submitted zip SHA and this build log archive path')
parser.add_argument('--dmg-submission-id',required=True,help='Current DMG submission ID mapped from this release build log')
parser.add_argument('--dmg-submitted-archive',type=Path,default=TASK.parent/'notary-dmg-submitted-archive.json')
parser.add_argument('--app-submitted-archive',type=Path,default=TASK.parent/'notary-app-submitted-archive.json')
parser.add_argument('--build-log',type=Path,default=TASK.parent/'release-build.log')
parser.add_argument('--build-provenance',type=Path,default=TASK.parent/'build-provenance.json')
args=parser.parse_args()
if not __debug__:raise RuntimeError('Run without Python optimization: verification assertions must remain enabled')
ROOT=args.source.resolve();STAGE=args.stage.resolve();TARGET=ROOT/'src-tauri/target'
VERSION=args.version;TAG='v'+VERSION;FEATURE='f1625169fe82c69c7955b0cb00677f96488cb986';BASE='v6.1119.1'
assert re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+',VERSION),'Invalid candidate version'
required=[f'note.md-{VERSION}-aarch64.dmg','note.md-aarch64.app.tar.gz','note.md-aarch64.app.tar.gz.sig','latest.json','Fcitx5-for-Sumi-0.5.0.15-arm64.pkg','fcitx5-companion.json']
assert all((STAGE/name).is_file() for name in required),'Six downloaded candidate assets must be present before verification'
def git(*args):return subprocess.check_output(['git',*args],cwd=ROOT)
SOURCE=git('rev-parse',TAG+'^{}').decode().strip()
assert git('rev-parse','HEAD').decode().strip()==SOURCE,'Build checkout is not frozen tag'
assert not git('status','--porcelain').strip(),'Build checkout has modifications'
for commit in [FEATURE]:subprocess.run(['git','merge-base','--is-ancestor',commit,SOURCE],cwd=ROOT,check=True)
spec=importlib.util.spec_from_file_location('checks',ROOT/'scripts/sumi/artifact_checks.py')
h=importlib.util.module_from_spec(spec);spec.loader.exec_module(h)
report={'sourceCommit':SOURCE,'featureCommit':FEATURE,'acceptedImplementation':FEATURE,'version':VERSION,'architecture':'arm64','limits':'Read-only source/tag and actual signed artifact proof. No App launch, installation, native GUI interaction or user Vault operation.'}
build_log=args.build_log.resolve();build_text=build_log.read_text()
for submission in [args.app_submission_id,args.dmg_submission_id]:
 assert re.fullmatch('[0-9a-f-]{36}',submission),'Invalid explicit current submission ID'
assert args.dmg_submission_id in build_text,'Current DMG submission ID not mapped in frozen release build log'
# Tauri logs the exact signed App ZIP path but omits its Apple job ID. The ZIP
# capture SHA, explicit Apple log job ID, and Accepted CDHash form that binding.
app_archive=args.app_submitted_archive.resolve();app_archive_record=json.loads(app_archive.read_text())
assert app_archive_record['path_observed_in_build_log'] in build_text,'Captured App archive path not in this release build log'
provenance=args.build_provenance.resolve();assert provenance.is_file(),'Missing clean-build provenance record'
provenance_data=json.loads(provenance.read_text())
assert provenance_data['status']=='PASS' and provenance_data['releaseCommit']==SOURCE and provenance_data['tag']==TAG
assert provenance_data['testedProductSource']==FEATURE and provenance_data['cleanBuildSourceAfterRelease'] is True
assert provenance_data['observedReleaseScriptExitCode']==0 and provenance_data['distMatchCapturedBuild'] is True
allowed_version_files={'CHANGELOG.md','CHANGELOG.zh-CN.md','package.json','src-tauri/tauri.conf.json','src-tauri/Cargo.toml','src-tauri/Cargo.lock'}
pre_bump=provenance_data['preBumpCommit']
assert set(git('diff','--name-only',pre_bump,SOURCE).decode().splitlines())==allowed_version_files,'Release commit contains non-version changes'
subprocess.run(['git','merge-base','--is-ancestor',FEATURE,pre_bump],cwd=ROOT,check=True)
assert not git('diff',FEATURE,pre_bump,'--','src','src-tauri','searchidx','tauri-plugin-native-editor','scripts','package.json','pnpm-lock.yaml').strip(),'Pre-bump product changed after accepted integration'
report['releaseCommitScope']={'preBumpCommit':pre_bump,'versionOnlyFiles':sorted(allowed_version_files),'acceptedProductEqualsPreBump':True}

assert provenance_data['releaseBuildLog']['sha256']==h.file_info(build_log)['sha256']
input_manifest=provenance.parent/provenance_data['buildInputManifest']['path']
assert provenance_data['buildInputManifest']['allCapturedFilesMatchFrozenRelease'] is True and provenance_data['buildInputManifest']['sha256']==h.file_info(input_manifest)['sha256']
for omitted in provenance_data['buildInputManifest']['notCapturedAtBuildTime']:
 assert git('show',provenance_data['preBumpCommit']+':'+omitted)==git('show',SOURCE+':'+omitted)==(ROOT/omitted).read_bytes(),'Uncaptured document differs across pre-bump, tag or build clone'
for relative,digest in provenance_data['distSha256'].items():
 assert h.file_info(ROOT/'dist'/relative)['sha256']==digest,'Dist differs from captured trusted build: '+relative
assert len(provenance_data['distSha256'])==provenance_data['distFiles']
for name,identity in provenance_data['localStagedArtifacts'].items():
 downloaded=h.file_info(STAGE/name)
 assert downloaded['sha256']==identity['sha256'] and downloaded['bytes']==identity['bytes'],'Draft asset differs from trusted build output: '+name
report['buildProvenance']={'record':h.file_info(provenance),'data':provenance_data,'releaseBuildLog':h.file_info(build_log),'appSubmissionId':args.app_submission_id,'capturedAppSubmittedArchive':{'record':h.file_info(app_archive),'data':app_archive_record},'dmgSubmissionId':args.dmg_submission_id,'boundary':'Clean build/release execution provenance connects frozen source to observed artifacts; this verification is not an independent reproducible rebuild.'}
def run(args):return h.check_command(report,list(map(str,args)))
app=TARGET/'aarch64-apple-darwin/release/bundle/macos/note.md.app'
binary=app/'Contents/MacOS/notemd';dep=TARGET/'aarch64-apple-darwin/release/notemd.d';dist=ROOT/'dist'
h.verify_app_identity(plistlib.loads((app/'Contents/Info.plist').read_bytes()),VERSION)
assert run(['/usr/bin/lipo','-archs',binary])=='arm64'
run(['/usr/bin/codesign','--verify','--deep','--strict','--verbose=2',app])
run(['/usr/sbin/spctl','--assess','--type','execute','--verbose=4',app])
assert 'Notarized Developer ID' in report['commands'][-1]['stderr']
run(['/usr/bin/xcrun','stapler','validate',app])
run(['/usr/bin/codesign','-dvvv',app]);assert 'TeamIdentifier=T5G56DH47L' in report['commands'][-1]['stderr']
ent=plistlib.loads(subprocess.check_output(['/usr/bin/codesign','-d','--entitlements',':-',str(app)],stderr=subprocess.DEVNULL))
assert ent['com.apple.security.personal-information.location'] and ent['com.apple.security.automation.apple-events']
report['entitlements']=ent
modules=json.loads(run(['node',ROOT/'scripts/sumi/verify-embedded.mjs','--inspect',dist]))
(STAGE/'embedded-inputs.json').write_text(json.dumps({'host_modules':modules})+'\n')
report['embeddedModules']=json.loads(run(['node',ROOT/'scripts/sumi/verify-embedded.mjs','--arch','arm64',binary,dep,dist,STAGE/'embedded-inputs.json',TARGET]))
report['embeddedAllAssets']=json.loads(run(['node',ROOT/'scripts/sumi/verify-extracted-assets.mjs',binary,dep,dist,TARGET,ROOT,SOURCE]))
embedded_hashes={row['rawSha256'] for row in report['embeddedAllAssets']['proof']}
raw=binary.read_bytes();js_assets={p:p.read_text() for p in (dist/'assets').glob('*.js')}
spec=importlib.util.spec_from_file_location('home_checks',TASK/'home_checks.py')
c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
changed=git('diff','--name-only','--diff-filter=ACMR',BASE,FEATURE).decode().splitlines()
deleted=git('diff','--name-only','--diff-filter=D',BASE,FEATURE).decode().splitlines()
for path in deleted:
 assert not (ROOT/path).exists(), 'Accepted deletion was restored: '+path
report['acceptedDeletedFiles']=deleted
implementation=[p for p in changed if p.startswith(('src/','src-tauri/src/'))]
report['acceptedSourceFiles']=c.verify_frozen_sources(implementation,lambda p:git('show',FEATURE+':'+p),lambda p:git('show',SOURCE+':'+p))
report['homeFeatures']=c.verify_home_resources(js_assets,{p:p.read_text() for p in (dist/'assets').glob('*.css')},embedded_hashes)
for command in ['plugin_market_installed','get_plugin_manifests','notemd_vault_stats','home_content_catalog','update_latest_menu','update_recent_menu']:
 assert command.encode() in raw,'Missing native command: '+command
report['homeFeatures']['nativeCommands']=['plugin_market_installed','get_plugin_manifests','notemd_vault_stats','home_content_catalog','update_latest_menu','update_recent_menu']
for changelog in ['CHANGELOG.md','CHANGELOG.zh-CN.md']:
 text=git('show',SOURCE+':'+changelog).decode()
 section=next((s for s in text.split('\n## ')[1:] if s.splitlines()[0].startswith(TAG+' ')),None)
 assert section and ('home' in section.lower() if changelog=='CHANGELOG.md' else '首页' in section),'Missing frozen release home changelog: '+changelog
report['homeFeatures']['acceptedSourceChecks']=c.verify_home_source(lambda p:git('show',SOURCE+':'+p).decode())
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
def resources(candidate):
 assert (candidate/'Contents/_CodeSignature/CodeResources').read_bytes()==code
 assert c.app_manifest(candidate)==c.app_manifest(app),'DMG entire App differs from build App'
 report['dmgEntireAppFilesIdentical']=len(c.app_manifest(app))
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
source_files=implementation+['package.json','src-tauri/tauri.conf.json','src-tauri/Cargo.toml','src-tauri/Cargo.lock','scripts/release-companions/fcitx5.json']
report['sourceFiles']={}
for path in sorted(set(source_files)):
 source_bytes=git('show',SOURCE+':'+path)
 assert (ROOT/path).read_bytes()==source_bytes,'Build source differs from frozen tag: '+path
 report['sourceFiles'][path]=hashlib.sha256(source_bytes).hexdigest()
assert not git('status','--porcelain').strip()
for label,target in [('app',app),('dmg',dmg)]:
 log_path=TASK/(label+'-apple-notary-log.json')
 if log_path.exists():
  run(['/usr/bin/codesign','-dvvv',target])
  notary_log=json.loads(log_path.read_text())
  assert notary_log['jobId']==(args.app_submission_id if label=='app' else args.dmg_submission_id),'Apple log jobId differs from this build submission mapping'
  if label=='app':report['appSubmittedArchiveBinding']=c.verify_app_archive_binding(app_archive_record,build_text,notary_log,args.app_submission_id)
  else:
   dmg_capture_path=args.dmg_submitted_archive.resolve();dmg_capture=json.loads(dmg_capture_path.read_text())
   assert dmg_capture['submission_id']==args.dmg_submission_id
   assert dmg_capture['sha256']==notary_log['sha256'],'Apple DMG submitted SHA differs from this captured pre-staple DMG'
   assert Path(dmg_capture['path']).name==notary_log['archiveFilename']==dmg.name
   report['dmgSubmittedArchiveBinding']={'record':h.file_info(dmg_capture_path),'data':dmg_capture,'appleSubmittedArchiveSha256':notary_log['sha256'],'byteShaMatches':True,'boundary':'Captured pre-staple DMG SHA matches Apple submitted archive; post-staple download is separately hashed and bound by CDHash.'}
  binding=c.verify_notary(notary_log,report['commands'][-1]['stderr'],label,h.file_info(dmg)['sha256'] if label=='dmg' else None)
  (TASK/(label+'-notary-binding.json')).write_text(json.dumps(binding,indent=2)+'\n')
  report[label+'NotaryBinding']=binding
 else:raise RuntimeError('Missing current Apple notary log: '+str(log_path))
(STAGE/'artifact-verification.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
(STAGE/'host-assets.json').write_text(json.dumps({'sourceCommit':SOURCE,'version':VERSION,'assets':assets},indent=2)+'\n')
(TASK/'frozen-source.json').write_text(json.dumps({'source':SOURCE,'feature':FEATURE,'acceptedImplementation':FEATURE,'tag':TAG,'changedFiles':source_files},indent=2)+'\n')
print(json.dumps({'ok':True,'source':SOURCE,'assets':len(assets),'report':str(STAGE/'artifact-verification.json')}))
