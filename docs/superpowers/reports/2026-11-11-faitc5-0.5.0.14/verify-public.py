from pathlib import Path
import json,hashlib,subprocess
r=Path('/Users/bruce/Faitc5-Releases/0.5.0.14');folder=r/'public-readback';folder.mkdir(exist_ok=True)
def fetch(url,p):
 x=subprocess.run(['curl','--fail','--location','--silent','--show-error','--connect-timeout','15','--max-time','120','--output',str(p),url],capture_output=True,text=True)
 if x.returncode:raise SystemExit('Anonymous download failed: '+p.name)
base='https://github.com/wizlijun/note.md/releases/download/faitc5-v0.5.0.14/'
proof=json.loads((r/'publication.json').read_text())
for a in proof['assets']:
 p=folder/a['name'];fetch(base+a['name'],p);assert p.stat().st_size==a['bytes'] and hashlib.sha256(p.read_bytes()).hexdigest()==a['sha256']
fetch('https://api.github.com/repos/wizlijun/note.md/releases/tags/faitc5-v0.5.0.14',folder/'release.json')
v=json.loads((folder/'release.json').read_text());assert not v['draft'] and not v['prerelease'];assert sorted(a['name'] for a in v['assets'])==sorted(a['name'] for a in proof['assets'])
for a in proof['assets']:
 public=next(x for x in v['assets'] if x['name']==a['name']);assert public['size']==a['bytes'] and public['digest']=='sha256:'+a['sha256']
fetch('https://api.github.com/repos/wizlijun/note.md/releases/latest',folder/'latest-host.json');latest=json.loads((folder/'latest-host.json').read_text());assert latest['tag_name']=='v6.1111.2'
proof.update(anonymous_full_readback=True,public_url=v['html_url'],latest_host=latest['tag_name']);(r/'public-verification.json').write_text(json.dumps(proof,indent=2)+'\n')
print(json.dumps({'public':True,'anonymous_full_readback':True,'latest_host':latest['tag_name'],'url':v['html_url']}))
