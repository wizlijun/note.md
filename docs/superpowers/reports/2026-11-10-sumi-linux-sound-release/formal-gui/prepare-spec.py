#!/usr/bin/env python3
"""Pin formal v7 host bytes; reuse already signed plugins/addon without rebuilding."""
import argparse,json,pathlib,re,hashlib,subprocess
r=pathlib.Path(__file__).resolve().parent;repo=r.parents[1]
p=argparse.ArgumentParser();p.add_argument('--commit',required=True);p.add_argument('--deb',type=pathlib.Path,required=True);p.add_argument('--sha256',required=True);a=p.parse_args()
assert re.fullmatch('[0-9a-f]{40}',a.commit) and re.fullmatch('[0-9a-f]{64}',a.sha256)
assert subprocess.check_output(['git','rev-parse','v6.1110.7^{commit}'],cwd=repo,text=True).strip()==a.commit
assert hashlib.sha256(a.deb.read_bytes()).hexdigest()==a.sha256
spec=json.loads((repo/'tasks/sumi-focus-v6/artifacts.json').read_text());spec.update(tag='v6.1110.7',commit=a.commit,host={'path':str(a.deb.resolve()),'sha256':a.sha256})
(r/'artifacts.json').write_text(json.dumps(spec,indent=2)+'\n');print(r/'artifacts.json')
