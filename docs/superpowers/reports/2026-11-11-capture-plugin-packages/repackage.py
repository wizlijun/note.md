from pathlib import Path
import json,zipfile,subprocess,hashlib,re,tempfile,selectors
ROOT=Path('/Users/bruce/git/mdeditor');OUT=ROOT/'tasks/capture-plugin-release-20261111';SRC=Path('/Users/bruce/git/mdeditor-capture-release-20261111')
VERSIONS={'apple-notes':('1.0.4','1.0.5'),'roam-import':('1.2.7','1.2.8'),'health-sync':('0.2.2','0.2.3')}
sha=lambda b:hashlib.sha256(b).hexdigest()
commit=subprocess.check_output(['git','rev-parse','HEAD'],cwd=SRC,text=True).strip()
pub=re.search(r'PLUGIN_REGISTRY_PUBKEY: &str =\s*"([^"]+)"',(SRC/'src-tauri/src/plugin_runtime/market.rs').read_text())[1]
index=json.loads((OUT/'index-before.json').read_text());rows=[];proof=[]
for name,(old,new) in VERSIONS.items():
 id='notemd.'+name;oldrow=next(r for r in index['plugins'] if r['id']==id and r['version']==old)
 manifest=(SRC/'plugins-src'/name/'manifest.v2.json').read_bytes();m=json.loads(manifest)
 target=SRC/'dist-plugins'/id/new;target.mkdir(parents=True,exist_ok=True);(target/'manifest.json').write_bytes(manifest)
 for arch in oldrow['archs']:
  previous=OUT/'previous'/id/old/(arch+'.notemdpkg');assert sha(previous.read_bytes())==oldrow['sha256'][arch]
  subprocess.run(['minisign','-Vm',str(previous),'-P',pub],check=True,capture_output=True)
  package=target/(arch+'.notemdpkg');assert not package.exists(),'Refuse overwrite'
  with zipfile.ZipFile(previous) as zin:
   oldm=json.loads(zin.read('manifest.json'));expected=json.loads(json.dumps(oldm));expected['version']=new
   for menu in expected['contributes']['menus']:menu['submenu']='record'
   assert expected==m,'Only version/submenu may change'
   with zipfile.ZipFile(package,'w') as zout:
    for info in zin.infolist():
     assert not info.filename.startswith('/') and '..' not in Path(info.filename).parts
     zout.writestr(info,manifest if info.filename=='manifest.json' else zin.read(info))
  subprocess.run(['minisign','-S','-s',str(Path.home()/'.tauri/notemd-plugins.key'),'-m',str(package)],input='\n',text=True,check=True,capture_output=True)
  subprocess.run(['minisign','-Vm',str(package),'-P',pub],check=True,capture_output=True)
  with zipfile.ZipFile(previous) as oldz,zipfile.ZipFile(package) as z:
   names=[n for n in z.namelist() if not n.endswith('/')];assert len(names)==len(set(names));files={n:sha(z.read(n)) for n in names};assert z.namelist()==oldz.namelist()
   for n in names:
    if n!='manifest.json':assert z.read(n)==oldz.read(n),n
   binname=m['binary'][arch];binpath=OUT/'verified'/id/arch/binname;binpath.parent.mkdir(parents=True,exist_ok=True);binpath.write_bytes(z.read(binname));binpath.chmod(0o755)
  verified=subprocess.run(['codesign','--verify','--strict','--verbose=2',str(binpath)],capture_output=True,text=True);assert verified.returncode==0,verified.stderr
  details=subprocess.run(['codesign','-dv','--verbose=4',str(binpath)],capture_output=True,text=True);assert 'TeamIdentifier=T5G56DH47L' in details.stderr
  actual_arch=subprocess.check_output(['lipo','-archs',str(binpath)],text=True).strip();assert actual_arch==('arm64' if arch.startswith('aarch64') else 'x86_64')
  smoke=None
  if arch.startswith('aarch64'):
   data=OUT/'isolated'/name;data.mkdir(parents=True,exist_ok=True)
   p=subprocess.Popen([str(binpath)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
   req={'jsonrpc':'2.0','id':1,'method':'$initialize','params':{'protocol_version':2,'host_version':'6.1111.1','locale':'en','theme':'light','plugin_root':str(binpath.parent.parent),'data_dir':str(data)}}
   p.stdin.write(json.dumps(req)+'\n');p.stdin.flush();sel=selectors.DefaultSelector();sel.register(p.stdout,selectors.EVENT_READ);assert sel.select(10),'initialize timed out';line=p.stdout.readline();reply=json.loads(line);assert reply.get('id')==1 and reply.get('result',{}).get('ok') is True
   p.stdin.write(json.dumps({'jsonrpc':'2.0','id':2,'method':'$deactivate','params':{}})+'\n');p.stdin.flush();stdout,stderr=p.communicate(timeout=10);assert p.returncode==0
   smoke={'initialize':reply,'deactivateOutput':stdout,'exitCode':p.returncode,'scope':'Initialize/deactivate only; no activation, account or personal data access'}
  rows.append({'id':id,'version':new,'arch':arch,'sourceCommit':commit,'packagePath':str(package),'sha256':sha(package.read_bytes()),'bytes':package.stat().st_size,'signatureSha256':sha(Path(str(package)+'.minisig').read_bytes()),'files':files,'minHost':oldrow['min_host']})
  proof.append({'id':id,'version':new,'arch':arch,'previousVersion':old,'previousPackageSha256':sha(previous.read_bytes()),'previousPackageMinisignVerified':True,'payloadFilesIdentical':{n:h for n,h in files.items() if n!='manifest.json'},'manifestOnlyChanges':['version','contributes.menus[].submenu'],'codesignVerify':verified.stderr,'codesignDetails':details.stderr,'architecture':actual_arch,'smoke':smoke,'notarization':'Retained exact previously distributed signed binary; not rebuilt or re-signed; no new notary submission claimed'})
(OUT/'frozen-plugin-packages.json').write_text(json.dumps({'sourceCommit':commit,'sourceRepository':str(SRC),'packages':rows},ensure_ascii=False,indent=2)+'\n')
(OUT/'package-reuse-proof.json').write_text(json.dumps(proof,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'sourceCommit':commit,'packages':len(rows),'armSmoke':3,'intelExecution':False}))
