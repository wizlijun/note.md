from pathlib import Path
import importlib.util,json,hashlib,subprocess,datetime,time
HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('download',HERE.parent/'smart-lookup-release-20261111/verify-public-host-full.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
m.HERE=HERE;m.TAG='fcitx5-v0.5.0.15'
api=m.api
release=api('/releases/tags/'+m.TAG)
assert not release['draft'] and not release['prerelease']
expected={'Fcitx5-for-Sumi-0.5.0.15-arm64.pkg','fcitx5-companion.json','SHA256SUMS'}
assert {a['name'] for a in release['assets']}==expected
ref=api('/git/ref/tags/'+m.TAG)['object'];tag_object=ref['sha']
if ref['type']=='tag':ref=api('/git/tags/'+ref['sha'])['object']
assert ref['type']=='commit' and ref['sha']=='8a7d9db75ae5cd2a267f4622f9411a246f36c623'
records=[];out=HERE/'input-method-public'
for asset in release['assets']:
 data=(HERE/'input-method-release'/asset['name']).read_bytes();h=hashlib.sha256(data).hexdigest()
 assert asset['size']==len(data) and asset['digest']=='sha256:'+h
 prior={'bytes':len(data),'sha256':h,'github_digest':'sha256:'+h}
 for attempt in range(3):
  try:
   receipt=m.full_asset(asset,prior,'browser',out);break
  except (AssertionError,RuntimeError) as error:
   print('Same canonical asset bounded retry',asset['name'],attempt+1,type(error).__name__,str(error),flush=True)
   if attempt==2:raise
 records.append(receipt)
approved=json.loads((HERE/'input-method-release/fcitx5-companion.json').read_text())
assert json.loads((out/'fcitx5-companion.json').read_text())==approved
assert (out/'SHA256SUMS').read_bytes()==(HERE/'input-method-release/SHA256SUMS').read_bytes()
assert hashlib.sha256((out/approved['filename']).read_bytes()).hexdigest()==approved['sha256']
after=api('/releases/tags/'+m.TAG);assert not after['draft'] and not after['prerelease'] and m.identity(after)==m.identity(release)
assert api('/git/ref/tags/'+m.TAG)['object']['sha']==tag_object
latest=api('/releases/latest');assert latest['tag_name']=='v6.1111.3','Input method release must not change host latest'
report={'status':'passed','verifiedAtUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'tag':m.TAG,'tagObject':tag_object,'metadataCommit':ref['sha'],'inputMethodSource':approved['sourceCommit'],'assets':records,'anonymousFullReadback':True,'transport':'canonical browser download URLs','fallbackUsed':False,'approvedCompanionVerified':True,'hostLatestUnchanged':latest['tag_name'],'runtimeBoundary':'Same SHA as fully expanded/notarized/stapled local package; no real system installation.'}
(HERE/'input-method-public-verification.json').write_text(json.dumps(report,indent=2)+'\n')
print('Complete anonymous input-method public verification passed',flush=True)
