import pathlib,hashlib,json,plistlib,subprocess,shutil,os,xml.etree.ElementTree as ET
r=pathlib.Path('/Users/bruce/Faitc5-Releases/0.5.0.14');repo=pathlib.Path('/Users/bruce/git/fcitx5-macos-sumi');app=r/'expanded/Fcitx5-Sumi-component.pkg/Payload/Library/Input Methods/Fcitx5.app';sourceapp=r/'root/Library/Input Methods/Fcitx5.app';setup=app/'Contents/Resources/SumiSetup';package=r/'Faitc5-for-Sumi-0.5.0.14-arm64.pkg'
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def entries(p):return {str(f.relative_to(p)):('link',str(f.readlink())) if f.is_symlink() else ('file',sha(f),f.stat().st_mode&0o777) if f.is_file() else ('dir',f.stat().st_mode&0o777) for f in p.rglob('*')}
def run(name,args,expected=0,env=None):
 p=subprocess.run(args,capture_output=True,text=True,env=env);(r/(name+'.log')).write_text(p.stdout+p.stderr);assert p.returncode==expected,(name,p.returncode);return p.stdout+p.stderr
assert entries(app)==entries(sourceapp),'Expanded payload differs from stapled root'
info=plistlib.loads((app/'Contents/Info.plist').read_bytes());embedded=json.loads((setup/'source.json').read_text());source='53758c46aed45f3de997bf956becdd819d0f8be1'
assert info['SumiSourceCommit']==source and embedded['source_commit']==source
assert embedded['automatic_spacing_commit']=='27d4f6e25ce3f96f3bdd82a166f3511f137655b9'
assert info['SumiPackageVersion']=='0.5.0.14' and info['CFBundleVersion']=='2026111111'
assert embedded['key_logging'] is False
assert embedded['quickphrase_shortcut_commit'].startswith('28966ee')
assert 'QuickPhraseKey=Super+semicolon' in (setup/'pinyin.conf').read_text()
assert ET.parse(r/'expanded/Fcitx5-Sumi-component.pkg/PackageInfo').getroot().attrib['version']=='0.5.0.14'
for name,digest in embedded['plugin_sha256'].items():assert sha(setup/name)==digest,name
for name in ('install-user-resources.sh','profile','pinyin.conf'):assert (setup/name).read_bytes()==(repo/'scripts/sumi-package'/name).read_bytes(),name
for name in ('preinstall','postinstall','request-user-setup.sh'):assert (r/'expanded/Fcitx5-Sumi-component.pkg/Scripts'/name).read_bytes()==(repo/'scripts/sumi-package'/name).read_bytes(),name
assert (r/'expanded/Fcitx5-Sumi-component.pkg/Scripts/package-version').read_text().strip()=='0.5.0.14'
run('final-codesign',['codesign','--verify','--deep','--strict',str(app)])
run('final-stapler',['xcrun','stapler','validate',str(app)])
assessment=run('final-gatekeeper',['spctl','--assess','--type','execute','--verbose=4',str(app)]);assert 'Notarized Developer ID' in assessment
signature=run('final-pkg-signature',['pkgutil','--check-signature',str(package)],1);assert 'no signature' in signature
signing=json.loads((r/'candidate/developer-id/signing-receipt.json').read_text());notary=json.loads((r/'notary-state.json').read_text());tickets=json.loads((r/'apple-notary-log.json').read_text())
assert tickets['status']=='Accepted' and tickets['sha256']==notary['archive_sha256'];coverage={(t.get('cdhash'),t.get('arch')) for t in tickets['ticketContents']}
for name,meta in signing['machos'].items():
 p=app/name;assert sha(p)==meta['sha256'],name;assert (meta['cdhash'],'arm64') in coverage,name
 assert subprocess.check_output(['lipo','-archs',str(p)],text=True).strip()=='arm64',name
home=r/'isolated-resource-home-verified'
run('final-resources-first',['sh',str(setup/'install-user-resources.sh'),'--target-home',str(home),'--if-needed'])
prefix=home/'Library/fcitx5';before=entries(home)
run('final-resources-repeat',['sh',str(setup/'install-user-resources.sh'),'--target-home',str(home),'--if-needed']);assert before==entries(home),'Repeated resource setup changed files'
for rel in ('lib/fcitx5/libquickphrase.so','share/fcitx5/addon/quickphrase.conf'):
 target=prefix/rel;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(app/'Contents'/rel,target)
env={**os.environ,'DYLD_LIBRARY_PATH':str(app/'Contents/lib')}
run('final-pinyin-defaults',[str(repo/'build/arm64/tests/sumi-pinyin-cpp'),str(prefix),'--defaults',str(home/'.config/fcitx5')],env=env)
validation={'version':'0.5.0.14','source_commit':source,'source_tag':'faitc5-sumi-v0.5.0.14-rc1','automatic_spacing_commit':embedded['automatic_spacing_commit'],'package':str(package),'package_sha256':sha(package),'app_notarized':True,'app_stapled':True,'installer_signature':'unsigned','installer_notarized':False,'submission_id':notary['id'],'notary_archive_sha256':notary['archive_sha256'],'signed_machos':len(signing['machos']),'payload_files_and_links':sum(f.is_file() or f.is_symlink() for f in app.rglob('*')),'payload_entries_including_directories':len(entries(app)),'payload_exact_match':True,'test_evidence':{'spacing_policy':'39 passed','production_IMK_route':'16 passed','sumi_ctest':'7 passed including settings and key mapping','installation_model':'production model receipt/permission/resume/retry passed','native_repair':'17 passed','request_handoff':'7 passed','preinstall':'5 passed','postinstall_restart':'16 passed','source_user_resources':'16 groups + 6 negative arguments passed','expanded_resources':'first setup and repeat no-change passed','expanded_pinyin_defaults':'actual Chinese archive with packaged quickphrase: Command-semicolon opens Quick Phrase, bare semicolon commits punctuation, Pinyin/emoji defaults passed','full_arm64_build':'passed after isolated CMake 4.3.4 replaced too-old environment tool'},'runtime_acceptance':'Not installed by this release task. New package native repair was verified by production-model fixtures and exact bundled scripts; physical first-install acceptance remains unverified. Historical 0.5.0.12 acceptance is not substituted.'}
(r/'validation.json').write_text(json.dumps(validation,indent=2)+'\n')
manifest=json.loads((r/'candidate/manifest.json').read_text());manifest.update(package_sha256=validation['package_sha256'],app_notarized=True,app_stapled=True,notarized=True,installer_notarized=False,notary_submission_id=notary['id']);(r/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps(validation,indent=2))
