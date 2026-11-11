#!/usr/bin/python3
"""Verify frozen source, package payload, and the packaged addon on a private bus."""
import argparse,hashlib,json,os,pathlib,subprocess,tarfile,tempfile
ROOT=pathlib.Path(__file__).resolve().parent
MANIFEST=json.loads((ROOT/'source-manifest.json').read_text())
PAYLOAD=['usr/lib/fcitx5/libsumicandidates.so','usr/share/fcitx5/addon/sumicandidates.conf','usr/share/licenses/fcitx5-sumi-candidates/LGPL-2.1-or-later.txt']
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def run(args):return subprocess.check_output(args,text=True,stderr=subprocess.STDOUT)
def verify_source():
    archive=ROOT/MANIFEST['source_archive']
    assert digest(archive)==MANIFEST['source_archive_sha256'],'source archive hash mismatch'
    assert digest(ROOT/'PKGBUILD')==MANIFEST['original_pkgbuild_sha256'],'build recipe differs from original release'
    with tarfile.open(archive) as tar:
        actual={}
        for m in tar:
            assert not m.issym() and not m.islnk()
            if not m.isfile():continue
            p=pathlib.PurePosixPath(m.name)
            assert p.parts[0]=='fcitx5-sumi' and '..' not in p.parts and not p.is_absolute()
            actual[str(pathlib.PurePosixPath(*p.parts[1:]))]=hashlib.sha256(tar.extractfile(m).read()).hexdigest()
    assert actual==MANIFEST['source_files_sha256'],'source file manifest mismatch'
    return archive
p=argparse.ArgumentParser();p.add_argument('--source-only',action='store_true');p.add_argument('--package',type=pathlib.Path,default=ROOT/MANIFEST['original_package']);p.add_argument('--output',type=pathlib.Path,default=ROOT/'verification.json');a=p.parse_args()
archive=verify_source()
if a.source_only:
    print('Frozen source and original PKGBUILD verified: '+MANIFEST['source_commit']);raise SystemExit(0)
package=a.package.resolve();pkginfo=run(['bsdtar','-xOf',str(package),'.PKGINFO'])
for line in ['pkgname = fcitx5-sumi-candidates','pkgver = 5.1.23.r4.gb07f55ca-1','arch = x86_64','depend = fcitx5>=5.1.23','depend = fcitx5<5.2']:
    assert line in pkginfo.splitlines(),line
members=run(['bsdtar','-tf',str(package)]).splitlines();metadata={'.PKGINFO','.BUILDINFO','.MTREE'}
assert sorted(n for n in members if not n.endswith('/') and n not in metadata)==sorted(PAYLOAD)
audit=pathlib.Path(tempfile.mkdtemp(prefix='audit-',dir=ROOT));extract=audit/'payload';extract.mkdir()
subprocess.run(['bsdtar','-xf',str(package),'-C',str(extract),*PAYLOAD],check=True)
elf=extract/PAYLOAD[0];header=run(['readelf','-h',str(elf)]);assert all(s in header for s in ['ELF64','Advanced Micro Devices X86-64','DYN'])
link=run(['ldd','-r',str(elf)]);assert 'not found' not in link and 'undefined symbol' not in link
(audit/'ldd-r.txt').write_text(link);(audit/'package-info.txt').write_text(run(['pacman','-Qip',str(package)]));(audit/'build-info.txt').write_text(run(['bsdtar','-xOf',str(package),'.BUILDINFO']))
config=(extract/PAYLOAD[1]).read_text();assert 'Library=libsumicandidates' in config and 'Type=SharedLibrary' in config and '@' not in config
source=audit/'source';source.mkdir()
with tarfile.open(archive) as tar:tar.extractall(source,filter='data')
runtime=audit/'runtime'
for d in ['config/fcitx5','data/fcitx5/addon','cache','run']:(runtime/d).mkdir(parents=True)
(runtime/'run').chmod(0o700)
(runtime/'data/fcitx5/addon/sumicandidates.conf').write_bytes((extract/PAYLOAD[1]).read_bytes())
(runtime/'config/fcitx5/profile').write_text('[Groups/0]\nName=Default\nDefault Layout=us\nDefaultIM=pinyin\n[Groups/0/Items/0]\nName=keyboard-us\n[Groups/0/Items/1]\nName=pinyin\n[GroupOrder]\n0=Default\n')
env=os.environ.copy();env.update(SUMI_PACKAGE_TEST_DIR=str(runtime),SUMI_PACKAGE_EXTRACT=str(extract),SUMI_PACKAGE_SOURCE=str(source/'fcitx5-sumi'))
with (audit/'runtime.log').open('w') as log:
    subprocess.run(['dbus-run-session','--config-file='+str(ROOT/'dbus-test.conf'),'--','bash',str(ROOT/'runtime-worker.sh')],env=env,stdout=log,stderr=subprocess.STDOUT,check=True,timeout=45)
passed=[line for line in (audit/'runtime.log').read_text().splitlines() if line.startswith('PASS:')]
assert len(passed)==10,passed
result={'source_commit':MANIFEST['source_commit'],'source_archive_sha256':digest(archive),'pkgbuild_sha256':digest(ROOT/'PKGBUILD'),'package':str(package),'package_sha256':digest(package),'matches_original_package':digest(package)==MANIFEST['original_package_sha256'],'payload_sha256':{n:digest(extract/n) for n in PAYLOAD},'audit_directory':str(audit),'dependency_packages':run(['pacman','-Q','fcitx5','fcitx5-chinese-addons','fcitx5-gtk']).splitlines(),'checks':{'frozen_source_manifest':True,'exact_three_file_payload':True,'elf_and_relocations':True,'actual_package_module_loaded_on_private_bus':True,'real_pinyin_protocol_regressions':passed},'system_installed_by_verifier':False,'global_fcitx_restarted':False,'published':False}
a.output.write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))
