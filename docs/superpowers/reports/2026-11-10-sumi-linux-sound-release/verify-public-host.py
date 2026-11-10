import json,hashlib,subprocess,time,re
from pathlib import Path
SOURCE_COMMIT = 'fbb9186259773a77f84a3ac69918e9f2f9df341f'  # Frozen v6.1110.7 source.
EXPECTED_DEB_SHA256 = '886379f3f52c768790ce4a9113f56b4c243033d6362a2afbfca36fbc6bdcbe23'  # Formal Debian artifact.
if not isinstance(SOURCE_COMMIT, str) or not re.fullmatch(r'[0-9a-f]{40}', SOURCE_COMMIT):
 raise RuntimeError('v7 source commit is not frozen; refusing public readback')
if not isinstance(EXPECTED_DEB_SHA256, str) or not re.fullmatch(r'[0-9a-f]{64}', EXPECTED_DEB_SHA256):
 raise RuntimeError('v7 Debian SHA256 is not frozen; refusing public readback')
root=Path('/home/bruce/git/note.md/tasks/sumi-sound-release-6.1110.7')
assert hashlib.sha256((root/'assets/note.md_6.1110.7_amd64.deb').read_bytes()).hexdigest()==EXPECTED_DEB_SHA256, 'Preserved formal Debian artifact differs'
public=root/'host-public-readback';public.mkdir(exist_ok=True)
def fetch(url,target):
 subprocess.run(['curl','--fail','--silent','--show-error','--location','--retry','2','--connect-timeout','15','--max-time','180','-A','note.md-release-audit','--output',str(target),url],check=True)
fetch('https://api.github.com/repos/wizlijun/note.md/releases/tags/v6.1110.7',public/'release.json')
release=json.loads((public/'release.json').read_text());assert release['tag_name']=='v6.1110.7' and release['draft'] is False and release['prerelease'] is False
fetch('https://api.github.com/repos/wizlijun/note.md/commits/v6.1110.7',public/'tag-commit.json')
assert json.loads((public/'tag-commit.json').read_text())['sha']==SOURCE_COMMIT, 'Public tag source differs'
names=['note.md_6.1110.7_amd64.deb','SHA256SUMS-linux.txt','notemd-6.1110.7-1-x86_64.pkg.tar.zst','notemd-6.1110.7-1-omarchy-recipe.tar.gz','omarchy-6.1110.7-verification.json','SHA256SUMS-omarchy.txt']
assert {x['name'] for x in release['assets']}==set(names)
metadata={x['name']:x for x in release['assets']};rows=[]
for name in names:
 source=root/'assets'/name;expected=hashlib.sha256(source.read_bytes()).hexdigest();url=f'https://github.com/wizlijun/note.md/releases/download/v6.1110.7/{name}'
 assert metadata[name].get('state')=='uploaded' and metadata[name]['browser_download_url']==url and metadata[name]['size']==source.stat().st_size
 target=public/name;fetch(url,target);method='anonymous curl readback'
 assert target.stat().st_size==source.stat().st_size and hashlib.sha256(target.read_bytes()).hexdigest()==expected,name
 assert metadata[name].get('digest') in (None,'sha256:'+expected)
 rows.append({'name':name,'url':url,'bytes':source.stat().st_size,'sha256':expected,'anonymousBytesMatch':True,'method':method})
fetch('https://api.github.com/repos/wizlijun/note.md/releases/latest',public/'latest.json')
latest=json.loads((public/'latest.json').read_text())
r={'tag':'v6.1110.7','sourceCommit':SOURCE_COMMIT,'publicStableRelease':True,'checkedAtEpoch':time.time(),'assets':rows,'githubLatestTag':latest['tag_name'],'macLatestUnchanged':latest['tag_name']=='v6.1110.1','installed':False}
(root/'host-public-verification.json').write_text(json.dumps(r,indent=2)+'\n')
print(json.dumps({'publicAssetsVerified':len(rows),'githubLatestTag':latest['tag_name']}))
