from pathlib import Path
import subprocess,json,hashlib,plistlib,os,stat,xml.etree.ElementTree as ET
BASE=Path('/Users/bruce/Fcitx5-Releases/0.5.0.15')
TASK=Path(__file__).resolve().parent
SOURCE='2f561d84463a225f89acd1cf6f9e561c575642da'
pkg=BASE/'Fcitx5-for-Sumi-0.5.0.15-arm64.pkg'
app=next((BASE/'expanded-final').rglob('Fcitx5.app'))
staged=BASE/'root/Library/Input Methods/Fcitx5.app'
def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def inventory(root):
 out={}
 for p in root.rglob('*'):
  rel=str(p.relative_to(root))
  if p.is_symlink(): out[rel]={'link':os.readlink(p)}
  elif p.is_file(): out[rel]={'sha256':sha(p),'mode':stat.S_IMODE(p.stat().st_mode)}
 return out
actual=inventory(app);expected=inventory(staged)
assert actual==expected, 'Expanded payload differs from notarized staged App'
info=plistlib.loads((app/'Contents/Info.plist').read_bytes())
for key in ['CFBundleName','CFBundleDisplayName']: assert info[key]=='Fcitx5 for Sumi'
assert info['CFBundleIdentifier']=='org.fcitx.inputmethod.Fcitx5'
assert info['SumiSourceCommit']==SOURCE and info['SumiPackageVersion']=='0.5.0.15' and info['CFBundleVersion']=='2026111201'
source=json.loads((app/'Contents/Resources/SumiSetup/source.json').read_text())
assert source['edition']=='Fcitx5 for Sumi' and source['source_commit']==SOURCE and source['package_version']=='0.5.0.15'
commands=[]
for command in [['codesign','--verify','--deep','--strict',str(app)],['xcrun','stapler','validate',str(app)],['spctl','--assess','--type','execute','--verbose=4',str(app)],['lipo','-archs',str(app/'Contents/MacOS/Fcitx5')]]:
 r=subprocess.run(command,capture_output=True,text=True,check=True);commands.append({'command':command,'stdout':r.stdout,'stderr':r.stderr})
assert commands[-1]['stdout'].strip()=='arm64'
assert 'Notarized Developer ID' in commands[-2]['stderr']
locales={}
for f in (app/'Contents/Resources').rglob('*.strings'):
 parsed=json.loads(subprocess.check_output(['plutil','-convert','json','-o','-',str(f)],text=True))
 assert all('Faitc5' not in k and 'Faitc5' not in str(v) for k,v in parsed.items()), 'Misspelled display text: '+str(f)
 locales[str(f.relative_to(app))]={'sha256':sha(f),'entries':len(parsed)}
assert len(locales)>=16
for f in (app/'Contents/Resources').glob('*.lproj/InfoPlist.strings'):
 d=json.loads(subprocess.check_output(['plutil','-convert','json','-o','-',str(f)],text=True))
 assert d['CFBundleName']==d['CFBundleDisplayName']=='Fcitx5 for Sumi'
dist=ET.parse(BASE/'expanded-final/Distribution').getroot()
assert dist.find('title').text=='Fcitx5 for Sumi 0.5.0.15'
component=next((BASE/'expanded-final').rglob('PackageInfo'))
pi=ET.parse(component).getroot();assert pi.attrib['identifier']=='org.fcitx.Fcitx5.sumi.local' and pi.attrib['version']=='0.5.0.15'
for script in ['preinstall','postinstall','request-user-setup.sh']:
 path=next((BASE/'expanded-final').rglob(script))
 expected_script=BASE/'installer-scripts'/script
 assert path.read_bytes()==expected_script.read_bytes()
receipt={'version':'0.5.0.15','product':'Fcitx5 for Sumi','sourceCommit':SOURCE,'package':str(pkg),'bytes':pkg.stat().st_size,'sha256':sha(pkg),'appNotarized':True,'appStapled':True,'packageSigned':False,'packageNotarized':False,'submissionId':'85a89706-8105-4bf4-9c8d-56a145093688','notaryArchiveSha256':sha(BASE/'notary-app.zip'),'expandedAppFilesAndLinks':len(actual),'payloadExactMatch':True,'allLocalizedResources':locales,'info':{k:info[k] for k in ['CFBundleName','CFBundleDisplayName','CFBundleIdentifier','CFBundleVersion','SumiPackageVersion','SumiSourceCommit']},'commands':commands,'runtimeBoundary':'Not installed; original stable identity and user data preserved. New package actual UI/metadata/scripts verified; first-install GUI/permission acceptance not claimed.'}
(TASK/'ime-package-verification.json').write_text(json.dumps(receipt,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'ok':True,'bytes':receipt['bytes'],'sha256':receipt['sha256'],'files':len(actual),'localizedResources':len(locales)}))
