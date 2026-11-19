from pathlib import Path
import hashlib,json,subprocess,datetime,shutil
root=Path('/Users/bruce/git/mdeditor'); task=root/'tasks/home-release-20261119'; source=root/'tasks/vault-release-20261114/source'
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def git(*args):return subprocess.check_output(['git',*args],cwd=source,text=True).strip()
candidate=task/'build-inputs-candidate.json'; c=json.loads(candidate.read_text()); log=task/'release-build.log'
assert 'draft ready:' in log.read_text()
assert git('status','--porcelain')==''
commit=git('rev-parse','HEAD');assert commit==git('rev-parse','v6.1119.1^{commit}')
assert set(git('diff','--name-only',c['pre_bump_commit'],commit).splitlines())==set(c['allowed_changes'])
assert all(sha(source/p)==h for p,h in c['tracked_file_sha256'].items())
tracked=set(subprocess.check_output(['git','ls-files','-z'],cwd=source).decode().split('\0'))-{''}
captured=set(c['tracked_file_sha256'])
assert captured <= tracked
omitted=sorted(tracked-captured)
assert omitted==['docs/2026-07-12-写得更少的时代大纲的价值.md']
for path in omitted:
 assert subprocess.check_output(['git','show',c['pre_bump_commit']+':'+path],cwd=source)==subprocess.check_output(['git','show',commit+':'+path],cwd=source)==(source/path).read_bytes()
actual_dist={str(p.relative_to(source/'dist')):sha(p) for p in (source/'dist').rglob('*') if p.is_file()}
assert actual_dist==c['dist_sha256']
snapshot=task/'release-build-prepublish.log';shutil.copyfile(log,snapshot)
artifacts={}
for name in ['note.md-6.1119.1-aarch64.dmg','note.md-aarch64.app.tar.gz','note.md-aarch64.app.tar.gz.sig','latest.json']:
 p=Path('/tmp')/name;artifacts[name]={'bytes':p.stat().st_size,'sha256':sha(p)}
r={'status':'PASS','capturedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'tag':'v6.1119.1','releaseCommit':commit,'releaseTree':git('rev-parse','HEAD^{tree}'),'tagObject':git('rev-parse','v6.1119.1'),'testedProductSource':'df353a18ae4b26827e3e26e8ccdf18d71e0d694b','preBumpCommit':c['pre_bump_commit'],'sourceDirectory':str(source),'cleanBuildSourceAfterRelease':True,'versionOnlyCommitFiles':c['allowed_changes'],'buildInputManifest':{'path':candidate.name,'sha256':sha(candidate),'capturedTrackedFiles':len(c['tracked_file_sha256']),'allCapturedFilesMatchFrozenRelease':True,'totalGitTrackedFiles':len(tracked),'notCapturedAtBuildTime':omitted,'omittedDocumentUnchangedAcrossPreBumpFrozenTagAndCurrentClone':True},'distFiles':len(actual_dist),'distMatchCapturedBuild':True,'distSha256':actual_dist,'releaseBuildLog':{'path':snapshot.name,'sha256':sha(snapshot)},'releaseCommand':c['release_command'],'environment':c['environment'],'observedReleaseScriptExitCode':0,'localStagedArtifacts':artifacts,'gates':{'frontendTestFiles':445,'frontendTests':6006,'svelteErrors':0,'svelteExistingWarnings':30,'protocolArtifacts':'consistent','dependencyAudit':{'low':1,'moderate':4,'high':0,'critical':0},'canvasRustTests':27,'mobileConfigTests':3},'scope':'darwin-aarch64','boundary':'Observed existing release.sh execution from a clean isolated clone, captured input hashes, unchanged dist outputs, signing/notarization and exact tag connect tested source to artifacts. This is trusted build provenance, not an independent bit-reproducible rebuild. Downloaded draft artifacts and embedded resources are verified separately.'}
(task/'build-provenance.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps({k:r[k] for k in ['status','releaseCommit','distFiles','buildInputManifest']}))
