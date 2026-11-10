#!/usr/bin/env python3
import datetime,gzip,hashlib,io,json,os,pathlib,re,shutil,subprocess,tarfile
root=pathlib.Path('/home/bruce/git/note.md'); task=root/'tasks/sumi-release-final'; build=task/'omarchy-6.1110.2'; assets=task/'assets'
version='6.1110.2'; package=build/f'notemd-{version}-1-x86_64.pkg.tar.zst'; deb=build/f'note.md_{version}_amd64.deb'
def sha(p):return hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
def cmd(args,**kw):return subprocess.check_output(args,**kw)
expected='0ae726211c3059b1bcfc892b904cf29ea50d8790106fedabc6a4a8b87f375976'
assert sha(deb)==expected
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
epoch=int(cmd(['git','show','-s','--format=%ct','v6.1110.2^{commit}']).decode())
with recipe_asset.open('wb') as raw:
 with gzip.GzipFile(filename='',fileobj=raw,mode='wb',mtime=0) as gz:
  with tarfile.open(fileobj=gz,mode='w',format=tarfile.PAX_FORMAT) as tar:
   for name in ['PKGBUILD','.SRCINFO','.omarchy/package.json']:
    data=(build/name).read_bytes();info=tarfile.TarInfo(f'notemd-{version}/{name}');info.size=len(data);info.mode=0o644;info.mtime=epoch;tar.addfile(info,io.BytesIO(data))
package_asset=assets/package.name;assert not package_asset.exists();shutil.copy2(package,package_asset);assert sha(package_asset)==sha(package)
report={'timestamp_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'version':version,'architecture':'x86_64','source_tag':'v6.1110.2','source_commit':cmd(['git','rev-parse','v6.1110.2^{commit}']).decode().strip(),'prepare_tool_commit':cmd(['git','log','-1','--format=%H','--','packaging/omarchy/prepare.py']).decode().strip(),'prepare_command':'python3 packaging/omarchy/prepare.py 6.1110.2 --amd64-only --output tasks/sumi-release-final/omarchy-6.1110.2','build_command':'makepkg --cleanbuild --noconfirm','downloaded_source':{'url':f'https://github.com/wizlijun/note.md/releases/download/v{version}/{deb.name}','sha256':sha(deb),'size':deb.stat().st_size,'matches_official_preserved_deb':sha(deb)==sha(assets/deb.name)},'artifacts':{p.name:{'sha256':sha(p),'size':p.stat().st_size} for p in [package_asset,recipe_asset]},'recipe_files_sha256':{name:sha(build/name) for name in ['PKGBUILD','.SRCINFO','.omarchy/package.json']},'debian_payload_files':debi,'debian_payload_preserved':True,'extra_files':sorted(extras),'checks':{'recipe_x86_64_only':'passed','makepkg_source_sha256':'passed','package_metadata':'passed','all_debian_file_bytes_and_modes':'passed','license_copy':'passed','elf_x86_64':'passed','ldd_r_resolved':'passed','cli_version':cli,'max_glibc':'.'.join(map(str,max(versions))),'no_direct_libssl':True},'binary_sha256':sha(binary),'log_sha256':{name:sha(task/name) for name in ['arch-prepare.log','arch-makepkg.log']},'verification_files_sha256':{str(p.relative_to(checks)):sha(p) for p in sorted(checks.glob('*')) if p.is_file()},'installed':False,'uploaded':False,'gui_acceptance':'Debian and Arch binary bytes are identical; final GUI acceptance is owned by parent agent.'}
report_asset=assets/f'omarchy-{version}-verification.json';report_asset.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
manifest=assets/'SHA256SUMS-omarchy.txt';manifest.write_text(''.join(f'{sha(p)}  {p.name}\n' for p in [package_asset,recipe_asset,report_asset]))
print(json.dumps({'artifacts':report['artifacts'],'verification':str(report_asset),'checksums':str(manifest),'binary_sha256':report['binary_sha256'],'preserved_payload_files':len(debi),'cli':cli},ensure_ascii=False,indent=2))
