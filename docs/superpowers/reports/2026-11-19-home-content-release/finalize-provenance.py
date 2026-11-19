from pathlib import Path
import hashlib,json,subprocess,datetime,shutil,re

ROOT=Path('/Users/bruce/git/mdeditor')
TASK=ROOT/'tasks/release-2026-11-19-evidence'
SOURCE=ROOT/'tasks/vault-release-20261114/source'
TAG='v6.1119.2'
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def git(*args):return subprocess.check_output(['git',*args],cwd=SOURCE,text=True).strip()
c=json.loads((TASK/'build-inputs-candidate.json').read_text())
log=TASK/'release-build.log';text=log.read_text()
assert json.loads((TASK/'release-exit.json').read_text())['exitCode']==0
assert 'draft ready:' in text and not git('status','--porcelain')
commit=git('rev-parse','HEAD');assert commit==git('rev-parse',TAG+'^{commit}')
assert set(git('diff','--name-only',c['pre_bump_commit'],commit).splitlines())==set(c['allowed_changes'])
assert all(sha(SOURCE/p)==h for p,h in c['tracked_file_sha256'].items())
tracked=set(subprocess.check_output(['git','ls-files','-z'],cwd=SOURCE).decode().split('\0'))-{''}
assert set(c['tracked_file_sha256'])==tracked, 'Every tracked file must have been captured'
dist={str(p.relative_to(SOURCE/'dist')):sha(p) for p in (SOURCE/'dist').rglob('*') if p.is_file()}
assert dist==c['dist_sha256']
snapshot=TASK/'release-build-prepublish.log';shutil.copyfile(log,snapshot)
assets={}
for name in ['note.md-6.1119.2-aarch64.dmg','note.md-aarch64.app.tar.gz','note.md-aarch64.app.tar.gz.sig','latest.json']:
 p=Path('/tmp')/name;assets[name]={'bytes':p.stat().st_size,'sha256':sha(p)}
counts=re.findall(r'Tests\s+(\d+) passed',text);files=re.findall(r'Test Files\s+(\d+) passed',text)
assert counts and files
native=(TASK/'home-content-native-tests.log').read_text();assert 'test result: ok. 11 passed' in native
assert 'svelte-check found 0 errors and 30 warnings' in text
assert '✓ protocol artifacts up to date' in text and 'Severity: 1 low | 4 moderate' in text
assert all('test result: ok. '+str(n)+' passed' in text for n in [25,2,3])
report={'status':'PASS','capturedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'tag':TAG,'releaseCommit':commit,'releaseTree':git('rev-parse','HEAD^{tree}'),'tagObject':git('rev-parse',TAG),'testedProductSource':c['pre_bump_commit'],'preBumpCommit':c['pre_bump_commit'],'sourceDirectory':str(SOURCE),'cleanBuildSourceAfterRelease':True,'versionOnlyCommitFiles':c['allowed_changes'],'buildInputManifest':{'path':'build-inputs-candidate.json','sha256':sha(TASK/'build-inputs-candidate.json'),'capturedTrackedFiles':len(tracked),'allCapturedFilesMatchFrozenRelease':True,'totalGitTrackedFiles':len(tracked),'notCapturedAtBuildTime':[]},'distFiles':len(dist),'distMatchCapturedBuild':True,'distSha256':dist,'releaseBuildLog':{'path':snapshot.name,'sha256':sha(snapshot)},'releaseCommand':c['release_command'],'environment':c['environment'],'observedReleaseScriptExitCode':0,'localStagedArtifacts':assets,'gates':{'frontendTestFiles':int(files[-1]),'frontendTests':int(counts[-1]),'svelteErrors':0,'svelteExistingWarnings':30,'homeContentNativeTests':11,'canvasRustTests':27,'mobileConfigTests':3,'otherGates':'Original protocol generation and production dependency audit gates completed in unmodified release.sh; details in frozen log.'},'scope':'darwin-aarch64','boundary':'Observed clean build with existing release.sh, all tracked input and dist hashes, signing/notarization and exact tag. This is trusted build provenance, not an independent reproducible rebuild; actual downloaded artifacts are verified separately.'}
(TASK/'build-provenance.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'status':'PASS','releaseCommit':commit,'inputs':len(tracked),'distFiles':len(dist)}))
