from pathlib import Path
import hashlib,json,os,subprocess,shutil
root=Path(__file__).resolve().parent
packages=list(root.glob('notemd-sumi-preview-*.pkg.tar.zst'))
assert len(packages)==1,packages
package=packages[0]
extracted=root/'verified-root'
if extracted.exists(): shutil.rmtree(extracted)
extracted.mkdir()
subprocess.run(['bsdtar','-xf',str(package),'-C',str(extracted)],check=True)
binary=extracted/'usr/bin/notemd'
assert binary.is_file() and os.access(binary,os.X_OK)
elf=binary.read_bytes()[:20]
assert elf[:6]==b'\x7fELF\x02\x01' and int.from_bytes(elf[18:20],'little')==62
metadata=(extracted/'.PKGINFO').read_text()
for dependency in ('libsecret','libpulse','fontconfig'):
 assert 'depend = '+dependency+'\n' in metadata
ldd=subprocess.run(['ldd','-r',str(binary)],capture_output=True,text=True,check=True)
assert 'not found' not in ldd.stdout and 'undefined symbol' not in ldd.stdout+ldd.stderr
(root/'ldd.log').write_text(ldd.stdout+ldd.stderr)
license_file=extracted/'usr/share/licenses/notemd-sumi-preview/LICENSE'
assert 'Apache License' in license_file.read_text()
desktops=list((extracted/'usr/share/applications').glob('*.desktop'))
assert desktops and 'notemd' in desktops[0].read_text()
env=os.environ.copy()
for key in ('DISPLAY','WAYLAND_DISPLAY','DBUS_SESSION_BUS_ADDRESS'): env.pop(key,None)
env['XDG_CONFIG_HOME']=str(root/'cli-config');env['XDG_DATA_HOME']=str(root/'cli-data')
version=subprocess.run([str(binary),'--cli','--version'],env=env,capture_output=True,text=True,check=True)
assert '6.1110.1' in version.stdout,version
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
result={'kind':'local-debug-source-preview-stripped','published':False,'installed':False,'arch':'x86_64','package':str(package),'packageSha256':sha(package),'binarySha256':sha(binary),'bytes':package.stat().st_size,'cliVersion':version.stdout.strip(),'elfAndDependenciesPassed':True,'desktop':desktops[0].read_text(),'licenseSha256':sha(license_file),'packageInfo':metadata}
(root/'verification.json').write_text(json.dumps(result,indent=2,ensure_ascii=False)+'\n')
(root/'SHA256SUMS').write_text(sha(package)+'  '+package.name+'\n')
print(json.dumps({k:result[k] for k in ('package','packageSha256','bytes','cliVersion')},ensure_ascii=False))
