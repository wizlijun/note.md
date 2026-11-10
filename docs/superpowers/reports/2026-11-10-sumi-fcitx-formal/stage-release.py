#!/usr/bin/env python3
"""Stage publisher artifacts in the stopped private fixture; never install system-wide."""
import argparse, hashlib, io, json, os, pathlib, re, shutil, stat, subprocess, tarfile, tempfile, zipfile
ROOT = pathlib.Path(__file__).resolve().parent
REPO = ROOT.parents[2]
p = argparse.ArgumentParser(description=__doc__)
for name in ('tag', 'deb', 'deb-sha256', 'plugin', 'plugin-sha256', 'signature'):
    p.add_argument('--' + name, required=True)
a = p.parse_args()
assert not (ROOT/'ready.json').exists(), 'stop private fixture before staging'
def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def source(path): return subprocess.check_output(['git','-C',str(REPO),'show',a.tag+':'+path],text=True)
commit = subprocess.check_output(['git','-C',str(REPO),'rev-parse',a.tag+'^{commit}'],text=True).strip()
assert subprocess.check_output(['git','-C',str(REPO),'tag','--points-at',commit],text=True).strip(), 'frozen tag required'
assert json.loads(source('src-tauri/tauri.conf.json'))['version']=='6.1110.2'
expected_manifest=json.loads(source('plugins-src/write/manifest.v2.json'))
assert expected_manifest['version']=='0.1.11'
pubkey=re.search(r'PLUGIN_REGISTRY_PUBKEY:\s*&str\s*=\s*"([^"]+)"',source('src-tauri/src/plugin_runtime/market.rs')).group(1)
deb,plugin,sig=map(lambda v:pathlib.Path(v).resolve(),(a.deb,a.plugin,a.signature))
assert sha(deb)==a.deb_sha256, 'Debian package hash mismatch'
assert sha(plugin)==a.plugin_sha256, 'plugin package hash mismatch'
minisign=REPO/'tasks/omarchy-build/minisign-tool/usr/bin/minisign'
verify_env = dict(os.environ, LD_LIBRARY_PATH=str(minisign.parents[1]/'lib/x86_64-linux-gnu'))
verified=subprocess.run([str(minisign),'-V','-P',pubkey,'-m',str(plugin),'-x',str(sig)],env=verify_env,capture_output=True,text=True,check=True)
release=ROOT/'release-package'/commit
release.mkdir(parents=True,exist_ok=False)
for path in (deb,plugin,sig):shutil.copy2(path,release/path.name)
members=subprocess.check_output(['ar','t',str(deb)],text=True).splitlines()
def deb_tar(prefix):
    name=next(n for n in members if n.startswith(prefix))
    return tarfile.open(fileobj=io.BytesIO(subprocess.check_output(['ar','p',str(deb),name])))
with deb_tar('control.tar') as t:
    control=t.extractfile(next(m for m in t if m.name.lstrip('./')=='control')).read().decode()
assert re.search(r'^Version: 6\.1110\.2$',control,re.M)
assert re.search(r'^Architecture: amd64$',control,re.M)
with deb_tar('data.tar') as t:t.extractall(release/'payload',filter='data')
host=release/'payload/usr/bin/notemd'
assert host.is_file()
plugin_root=ROOT/'data/net.notemd.app/plugins/notemd.sumi'
dest=plugin_root/'0.1.11'
assert not dest.exists(), 'preserve prior staged release; do not overwrite'
with tempfile.TemporaryDirectory(prefix='signed-plugin-',dir=release) as tmp:
    stage=pathlib.Path(tmp)
    with zipfile.ZipFile(plugin) as z:
        assert sum(i.file_size for i in z.infolist())<=200*1024*1024
        for i in z.infolist():
            path=pathlib.PurePosixPath(i.filename)
            assert not path.is_absolute() and '..' not in path.parts
            mode=i.external_attr>>16
            assert not stat.S_ISLNK(mode)
            target=stage/path
            if i.is_dir():target.mkdir(parents=True,exist_ok=True);continue
            target.parent.mkdir(parents=True,exist_ok=True)
            target.write_bytes(z.read(i));target.chmod(0o755 if mode&0o111 else 0o644)
    manifest=json.loads((stage/'manifest.json').read_text())
    assert manifest==expected_manifest, 'package manifest differs from frozen tag'
    assert manifest['id']=='notemd.sumi' and manifest['engines']['notemd']=='>=6.1110.2'
    backend=stage/manifest['binary']['x86_64-unknown-linux-gnu']
    assert backend.read_bytes()[:4]==b'\x7fELF'
    shutil.move(stage,dest)
files={str(f.relative_to(dest)):sha(f) for f in dest.rglob('*') if f.is_file()}
record={'tag':a.tag,'commit':commit,'host_version':'6.1110.2','plugin_version':'0.1.11','host_binary':str(host),'host_binary_sha256':sha(host),'deb':str(deb),'deb_sha256':sha(deb),'plugin':str(plugin),'plugin_sha256':sha(plugin),'signature_sha256':sha(sig),'public_key':pubkey,'signature_verification':verified.stdout,'plugin_directory':str(dest),'plugin_files_sha256':files,'system_installed':False,'gui_passed':False}
(release/'provenance.json').write_text(json.dumps(record,indent=2)+'\n')
current=plugin_root/'current'
assert current.is_symlink()
link=plugin_root/'current.release';link.symlink_to('0.1.11');os.replace(link,current)
state=plugin_root.parent/'state.json'
s=json.loads(state.read_text());s['installed']['notemd.sumi']={'version':'0.1.11','enabled':True}
state.write_text(json.dumps(s)+'\n')
(ROOT/'release-selection.json').write_text(json.dumps(record,indent=2)+'\n')
print(json.dumps({'host_binary':str(host),'provenance':str(release/'provenance.json'),'gui_passed':False},indent=2))
