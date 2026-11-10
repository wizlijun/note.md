#!/usr/bin/env python3
import datetime,gzip,hashlib,io,json,os,pathlib,re,shutil,subprocess,tarfile
root=pathlib.Path('/home/bruce/git/note.md'); task=root/'tasks/sumi-focus-release-6.1110.6'; build=task/'omarchy-6.1110.6'; assets=task/'assets'
EXPECTED_DEB_SHA256 = "8f11cc89f73832b3ab2106552408c8289ac0fe87aaff47a02d81a9d8f48927d8"  # Formal v6 public artifact; GUI gate approved and preserved Debian bytes verified.
version='6.1110.6'; package=build/f'notemd-{version}-1-x86_64.pkg.tar.zst'; deb=build/f'note.md_{version}_amd64.deb'
def sha(p):return hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
def cmd(args,**kw):return subprocess.check_output(args,**kw)
source_commit = '024d81814b4076def2456428150a4a2cd84095de'  # Frozen v6.1110.6 tag; independent of main.
if not isinstance(source_commit, str) or not re.fullmatch(r'[0-9a-f]{40}', source_commit):
 raise RuntimeError('v6 source commit is not frozen; refusing verification')
if not isinstance(EXPECTED_DEB_SHA256, str) or not re.fullmatch(r'[0-9a-f]{64}', EXPECTED_DEB_SHA256):
 raise RuntimeError('v6 Debian SHA256 is not frozen; refusing verification')
assert cmd(['git','rev-parse',f'v{version}^{{commit}}']).decode().strip()==source_commit
checksum_lines=(assets/'SHA256SUMS-linux.txt').read_text().splitlines()
assert len(checksum_lines)==1, 'Expected exactly one official amd64 checksum'
checksum_match=re.fullmatch(r'([0-9a-f]{64})  (.+)',checksum_lines[0]);assert checksum_match
expected,expected_name=checksum_match.groups()
assert expected_name==deb.name, 'Official checksum filename mismatch'
assert isinstance(EXPECTED_DEB_SHA256,str) and re.fullmatch(r'[0-9a-f]{64}',EXPECTED_DEB_SHA256), 'Formal Debian SHA256 has not been frozen yet'
assert expected==EXPECTED_DEB_SHA256, 'Unexpected official Debian bytes'
assert sha(assets/deb.name)==expected, 'Preserved formal Debian artifact differs'
assert sha(deb)==expected and deb.read_bytes()==(assets/deb.name).read_bytes(), 'Downloaded Debian artifact differs from preserved formal bytes' 
recipe=(build/'PKGBUILD').read_text();assert "arch=('x86_64')" in recipe and 'aarch64' not in recipe and 'arm64' not in recipe and expected in recipe
srcinfo=cmd(['makepkg','--printsrcinfo'],cwd=build);(build/'.SRCINFO').write_bytes(srcinfo)
assert b'arch = x86_64' in srcinfo and b'aarch64' not in srcinfo
checks=task/'arch-verification';checks.mkdir(exist_ok=True)
debroot=checks/'deb-root';archroot=checks/'arch-root';debroot.mkdir(exist_ok=True);archroot.mkdir(exist_ok=True)
ar_members=cmd(['bsdtar','-tf',str(deb)]).decode().splitlines();data_member=next(n for n in ar_members if n.startswith('data.tar'))
subprocess.run(['bsdtar','--no-same-owner','-xf','-','-C',str(debroot)],input=cmd(['bsdtar','-xOf',str(deb),data_member]),check=True)
subprocess.run(['bsdtar','--no-same-owner','-xf',str(package),'-C',str(archroot)],check=True)
def inventory(base):
 result={}
 for p in sorted(base.rglob('*')):
  rel=str(p.relative_to(base))
  if p.is_symlink():result[rel]={'symlink':os.readlink(p)}
  elif p.is_file():result[rel]={'sha256':sha(p),'size':p.stat().st_size,'mode':oct(p.stat().st_mode&0o777)}
 return result
debi=inventory(debroot);archi=inventory(archroot)
deb_dirs={str(p.relative_to(debroot)):oct(p.stat().st_mode&0o777) for p in debroot.rglob('*') if p.is_dir() and not p.is_symlink()}
for name,mode in deb_dirs.items():
 target=archroot/name;assert target.is_dir() and not target.is_symlink() and oct(target.stat().st_mode&0o777)==mode,(name,mode)
for p,entry in debi.items():assert archi.get(p)==entry,(p,entry,archi.get(p))
extras=set(archi)-set(debi);assert extras=={'.PKGINFO','.BUILDINFO','.MTREE','usr/share/licenses/notemd/LICENSE'},extras
assert sha(archroot/'usr/share/licenses/notemd/LICENSE')==sha(debroot/'usr/share/doc/note.md/copyright')
(checks/'debian-inventory.json').write_text(json.dumps(debi,indent=2)+'\n');(checks/'arch-inventory.json').write_text(json.dumps(archi,indent=2)+'\n')
metadata=(archroot/'.PKGINFO').read_text();assert 'pkgname = notemd\n' in metadata and f'pkgver = {version}-1\n' in metadata and 'arch = x86_64\n' in metadata
for dep in ['libsecret','libpulse','fontconfig']:assert f'depend = {dep}\n' in metadata
binary=archroot/'usr/bin/notemd';elf={}
for key,flag in [('header','-h'),('program','-l'),('dynamic','-d'),('versions','--version-info')]:
 elf[key]=cmd(['readelf',flag,str(binary)]).decode();(checks/f'elf-{key}.txt').write_text(elf[key])
assert 'ELF64' in elf['header'] and 'Advanced Micro Devices X86-64' in elf['header']
assert '[Requesting program interpreter: /lib64/ld-linux-x86-64.so.2]' in elf['program']
needed=re.findall(r'\(NEEDED\).*\[([^]]+)\]',elf['dynamic']);assert 'libc.so.6' in needed and not any(n.startswith('libssl') for n in needed)
versions={tuple(map(int,v.split('.'))) for v in re.findall(r'GLIBC_([0-9]+(?:\.[0-9]+)*)',elf['versions'])};assert max(versions)<=(2,36)
env=dict(os.environ)
for name in ['DISPLAY','WAYLAND_DISPLAY','LD_LIBRARY_PATH','LD_PRELOAD']:env.pop(name,None)
ldd=cmd(['ldd','-r',str(binary)],env=env,stderr=subprocess.STDOUT).decode();assert not re.search('not found|undefined symbol|symbol lookup error',ldd,re.I);(checks/'ldd-r.txt').write_text(ldd)
cli=cmd([str(binary),'--cli','--version'],env=env,stderr=subprocess.STDOUT).decode().strip();assert cli==f'notemd {version} (plugin API v1)',cli;(checks/'cli-version.txt').write_text(cli+'\n')
# Publishable recipe includes exact generated source checksums and Omarchy metadata.
recipe_asset=assets/f'notemd-{version}-1-omarchy-recipe.tar.gz'
epoch=int(cmd(['git','show','-s','--format=%ct','v6.1110.6^{commit}']).decode())
with recipe_asset.open('wb') as raw:
 with gzip.GzipFile(filename='',fileobj=raw,mode='wb',mtime=0) as gz:
  with tarfile.open(fileobj=gz,mode='w',format=tarfile.PAX_FORMAT) as tar:
   for name in ['PKGBUILD','.SRCINFO','.omarchy/package.json']:
    data=(build/name).read_bytes();info=tarfile.TarInfo(f'notemd-{version}/{name}');info.size=len(data);info.mode=0o644;info.mtime=epoch;tar.addfile(info,io.BytesIO(data))
package_asset=assets/package.name;assert not package_asset.exists();shutil.copy2(package,package_asset);assert sha(package_asset)==sha(package)
report={'timestamp_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'version':version,'architecture':'x86_64','source_tag':'v6.1110.6','source_commit':cmd(['git','rev-parse','v6.1110.6^{commit}']).decode().strip(),'prepare_tool_commit':cmd(['git','log','-1','--format=%H','--','packaging/omarchy/prepare.py']).decode().strip(),'prepare_command':'python3 packaging/omarchy/prepare.py 6.1110.6 --amd64-only --output tasks/sumi-focus-release-6.1110.6/omarchy-6.1110.6','build_command':'makepkg --cleanbuild --noconfirm','downloaded_source':{'url':f'https://github.com/wizlijun/note.md/releases/download/v{version}/{deb.name}','sha256':sha(deb),'size':deb.stat().st_size,'matches_official_preserved_deb':sha(deb)==sha(assets/deb.name)},'artifacts':{p.name:{'sha256':sha(p),'size':p.stat().st_size} for p in [package_asset,recipe_asset]},'recipe_files_sha256':{name:sha(build/name) for name in ['PKGBUILD','.SRCINFO','.omarchy/package.json']},'debian_payload_files':debi,'debian_payload_preserved':True,'extra_files':sorted(extras),'checks':{'recipe_x86_64_only':'passed','makepkg_source_sha256':'passed','package_metadata':'passed','all_debian_file_bytes_and_modes':'passed','all_debian_directory_modes':'passed','license_copy':'passed','elf_x86_64':'passed','ldd_r_resolved':'passed','cli_version':cli,'max_glibc':'.'.join(map(str,max(versions))),'no_direct_libssl':True},'binary_sha256':sha(binary),'log_sha256':{name:sha(task/name) for name in ['arch-prepare.log','arch-makepkg.log']},'verification_files_sha256':{str(p.relative_to(checks)):sha(p) for p in sorted(checks.glob('*')) if p.is_file()},'installed':False,'uploaded':False,'gui_acceptance':'Debian and Arch binary bytes are identical; final GUI acceptance is owned by parent agent.'}
report_asset=assets/f'omarchy-{version}-verification.json';report_asset.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
manifest=assets/'SHA256SUMS-omarchy.txt';manifest.write_text(''.join(f'{sha(p)}  {p.name}\n' for p in [package_asset,recipe_asset,report_asset]))
print(json.dumps({'artifacts':report['artifacts'],'verification':str(report_asset),'checksums':str(manifest),'binary_sha256':report['binary_sha256'],'preserved_payload_files':len(debi),'cli':cli},ensure_ascii=False,indent=2))
