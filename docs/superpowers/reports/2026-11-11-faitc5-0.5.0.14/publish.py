from pathlib import Path
import subprocess,json,hashlib
r=Path('/Users/bruce/Faitc5-Releases/0.5.0.14');tag='faitc5-v0.5.0.14';repo='wizlijun/note.md'
names=['Faitc5-for-Sumi-0.5.0.14-arm64.pkg','SHA256SUMS','faitc5-companion.json']
def gh(*args):return subprocess.check_output(['gh','-R',repo,*args],text=True)
def view():return json.loads(gh('release','view',tag,'--json','tagName,isDraft,isPrerelease,assets,url'))
def identity(v):return [(a['id'],a['name'],a['size'],a['updatedAt'],a['state']) for a in sorted(v['assets'],key=lambda a:a['name'])]
before=view();assert before['isDraft'] and not before['isPrerelease'];assert sorted(a['name'] for a in before['assets'])==sorted(names)
remote=subprocess.check_output(['git','ls-remote','https://github.com/wizlijun/note.md.git',f'refs/tags/{tag}^{{}}'],text=True).split()[0];assert remote=='3c055387c422904bead67132134d1962b5833e52'
target=r/'draft-readback';target.mkdir()
gh('release','download',tag,'--dir',str(target))
for name in names:assert (target/name).read_bytes()==(r/name).read_bytes()
assert identity(view())==identity(before)
gh('release','edit',tag,'--draft=false','--latest=false')
after=view();assert not after['isDraft'] and identity(after)==identity(before)
(r/'publication.json').write_text(json.dumps({'tag':tag,'metadata_commit':remote,'input_method_source':'53758c46aed45f3de997bf956becdd819d0f8be1','public':True,'latest_host_unchanged':True,'draft_full_readback':True,'assets':[{'name':n,'bytes':(r/n).stat().st_size,'sha256':hashlib.sha256((r/n).read_bytes()).hexdigest()} for n in names]},indent=2)+'\n')
print('Published '+tag)
