import importlib.util,json,tempfile,hashlib,subprocess,copy,ast
from pathlib import Path
from unittest.mock import patch
HERE=Path(__file__).resolve().parent
s=importlib.util.spec_from_file_location('p',HERE/'publish-plugin.py');p=importlib.util.module_from_spec(s);s.loader.exec_module(p)
p.load_frozen('710c148cc7548d8db14ecb6ae6dea75eca0ede09');entries=p.check_packages()
before=json.loads((HERE/'plugins-index-readonly.json').read_text()); candidate=p.merge_entries(before,entries)
checks=[]
for pending in [False,True]:
 with tempfile.TemporaryDirectory() as t:
  calls=[];i=iter([before,before,candidate])
  def fetch(url,path):path.write_text(json.dumps(candidate));calls.append('public-index');return 200
  def wrangler(args,log):calls.append('kv-write');assert args[:3]==['kv:key','put','index'];return subprocess.CompletedProcess(args,0)
  with patch.object(p,'HERE',Path(t)),patch.object(p,'require_public_host',lambda:calls.append('host-public')),patch.object(p,'require_pending_host_compatibility',lambda:calls.append('pending-compat')),patch.object(p,'verify_public_packages',lambda:calls.append('full-package-check')),patch.object(p,'read_kv',lambda n:next(i)),patch.object(p,'wrangler',wrangler),patch.object(p,'fetch',fetch):
   p.publish_index(entries,pending)
   r=json.loads((Path(t)/'plugins-index-verification.json').read_text())
   assert r['compatibleHostPublic']==(not pending) and r['publishedBeforeCompatibleHost']==pending
   assert r['historicalEntriesUnchanged'] and r['before']==304 and r['after']==305
  assert calls==[('pending-compat' if pending else 'host-public'),'full-package-check','kv-write','public-index','public-index'],calls
  checks.append('publish-order-pending='+str(pending))
for gate in ['require_public_host','require_pending_host_compatibility','verify_public_packages']:
 calls=[]
 def fail():raise RuntimeError('injected gate failure')
 with patch.object(p,'require_public_host',lambda:None),patch.object(p,'require_pending_host_compatibility',lambda:None),patch.object(p,'verify_public_packages',lambda:None),patch.object(p,gate,fail),patch.object(p,'wrangler',lambda *a:calls.append(a)):
  try:p.publish_index(entries,gate=='require_pending_host_compatibility')
  except RuntimeError:pass
  else:raise AssertionError('gate did not stop')
 assert not calls;checks.append('no-write-on-'+gate)
base={'ok':True,'preparedSource':p.FROZEN['sourceCommit'],'pluginSha256':p.ROWS[0]['sha256'],'hostTag':'v6.1109.1','minimumHost':'>=6.1109.2','oldHostSelectedVersion':'0.1.6','oldHostUpdateTarget':None,'oldHostInstallRejected':True,'hostSourceHashes':{path:hashlib.sha256(b'fixture').hexdigest() for path in ['src/lib/market/select.ts','src/plugin-market-app.svelte','src-tauri/src/plugin_runtime/commands.rs','src-tauri/src/plugin_runtime/installer.rs','plugin-protocol/src/lib.rs']},'hostCommit':'4b3de21a0afef6c689cecadc9a2dadf0d4d57121'}
variants=[('valid',{},404),('missing-update-key',{},404),('audit-failed',{'ok':False},404),('empty-source-proof',{'hostSourceHashes':{}},404),('wrong-source',{'preparedSource':'wrong'},404),('wrong-package',{'pluginSha256':'wrong'},404),('wrong-host',{'hostTag':'v6.1108.6'},404),('lowered-engine',{'minimumHost':'>=6.1109.1'},404),('old-host-selected-new',{'oldHostSelectedVersion':'0.1.7'},404),('old-host-update-new',{'oldHostUpdateTarget':'0.1.7'},404),('old-host-not-rejected',{'oldHostInstallRejected':False},404),('target-already-public',{},200),('target-network-unknown',{},503)]
for name,changes,status in variants:
 with tempfile.TemporaryDirectory() as t:
  d={**base,**changes}
  if name=='missing-update-key': del d['oldHostUpdateTarget']
  (Path(t)/'plugin-pending-host-compatibility.json').write_text(json.dumps(d))
  def output(args,**kwargs):return base['hostCommit']+'\n' if 'rev-parse' in args else b'fixture'
  def fetch(url,path):
   if '/v6.1109.1?' in url:path.write_text(json.dumps({'tag_name':'v6.1109.1','draft':False,'prerelease':False,'published_at':'date'}));return 200
   return status
  with patch.object(p,'HERE',Path(t)),patch.object(p.subprocess,'check_output',output),patch.object(p,'fetch',fetch):
   try:p.require_pending_host_compatibility();passed=True
   except RuntimeError:passed=False
  assert passed==(name=='valid'),name
  checks.append(name)
old=ast.parse((HERE/'publish-plugin-before-pending-host.py').read_text());new=ast.parse((HERE/'publish-plugin.py').read_text())
a={n.name:ast.dump(n) for n in old.body if isinstance(n,ast.FunctionDef)};b={n.name:ast.dump(n) for n in new.body if isinstance(n,ast.FunctionDef)}
assert [n for n in a if a[n]!=b.get(n)]==['publish_index','main'];checks.append('other-19-functions-unchanged')
report={'ok':True,'checks':checks,'count':len(checks),'networkWritesPerformed':False,'publisherSha256':hashlib.sha256((HERE/'publish-plugin.py').read_bytes()).hexdigest()}
(HERE/'pending-host-publisher-tests.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'ok':True,'checks':len(checks)}))
