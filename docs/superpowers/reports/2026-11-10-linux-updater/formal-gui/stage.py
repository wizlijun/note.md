from pathlib import Path
import hashlib,json,subprocess,shutil,datetime,tarfile,io
r=Path.cwd(); f=r/'tasks/sumi-fcitx/host-fixture'; out=r/'tasks/linux-updater-fix/formal-gui'; tag='a64353c72ffe930de5ff90923b457e1d15360bef'; deb=r/'tasks/linux-updater-fix/assets/note.md_6.1110.3_amd64.deb'
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
assert sha(deb)=='e9945737d9dae0155fb46fe1a30f93450652f212f1877f600abcf8fef8a8fd29'
control=tarfile.open(fileobj=io.BytesIO(subprocess.check_output(['bsdtar','-xOf',str(deb),'control.tar.gz'])))
metadata=control.extractfile('control').read().decode(); assert 'Version: 6.1110.3\n' in metadata; (out/'deb-control.txt').write_text(metadata)
assert not (f/'ready.json').exists()
old=json.loads((f/'release-selection.json').read_text()); shutil.copy2(f/'release-selection.json',out/'release-selection-6.1110.2.backup.json')
payload=f/'release-package'/tag/'payload'; payload.mkdir(parents=True,exist_ok=True)
subprocess.run(['bsdtar','-xf','-','-C',str(payload)],input=subprocess.check_output(['bsdtar','-xOf',str(deb),'data.tar.gz']),check=True)
binary=payload/'usr/bin/notemd'
new={**old,'tag':'v6.1110.3','commit':tag,'host_version':'6.1110.3','host_binary':str(binary),'host_binary_sha256':sha(binary),'deb':str(deb),'deb_sha256':sha(deb),'plugin_source_tag':'v6.1110.2','gui_passed':False,'audit_purpose':'Linux updater formal native HTTP / UI / persistence acceptance','staged_at':datetime.datetime.now(datetime.timezone.utc).isoformat()}
(f/'release-selection.json').write_text(json.dumps(new,indent=2)+'\n'); (out/'release-selection-6.1110.3.json').write_text(json.dumps(new,indent=2)+'\n')
base=f/'data/net.notemd.app'
for name in ['updater.json','linux-updater-x86_64-unknown-linux-gnu.json']:
 p=base/name
 if p.exists(): shutil.copy2(p,out/(name+'.backup'))
 if name.startswith('linux'): p.unlink(missing_ok=True)
(base/'updater.json').write_text(json.dumps({'state':{'last_checked_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'latest_version_seen':'999.0.0','dismissed_version':None,'check_on_startup':False,'last_check_succeeded':True}})+'\n')
shutil.copy2(base/'updater.json',out/'legacy-seed.json')
print(json.dumps({k:new[k] for k in ['tag','commit','host_binary','host_binary_sha256','deb_sha256']}))
