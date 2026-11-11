from pathlib import Path
import subprocess,json,re,os,hashlib,tarfile,io,urllib.request,sys
root=Path('/Users/bruce/git/mdeditor');out=root/'tasks/plugin-writing-website-20261111';commit='e4486a80613eca18fd509efd4e54605e3efd1392';wrangler=root/'plugins-registry/node_modules/.bin/wrangler'
installed=json.loads((root/'plugins-registry/node_modules/wrangler/package.json').read_text());assert installed['version']=='3.114.17'
env=os.environ.copy()
for line in (root/'.env').read_text().splitlines():
 m=re.match(r'(?:export\s+)?CLOUDFLARE_API_TOKEN\s*=\s*(.*)',line)
 if m:env['CLOUDFLARE_API_TOKEN']=m[1].strip().strip('\"\'')
assert env.get('CLOUDFLARE_API_TOKEN'),'Existing Account API Token unavailable'
env['WRANGLER_SEND_METRICS']='false';env['CI']='true'
frozen=out/'source-final'
if not frozen.exists():
 frozen.mkdir();archive=subprocess.check_output(['git','archive',commit,'plugins-registry'],cwd=root)
 with tarfile.open(fileobj=io.BytesIO(archive)) as f:f.extractall(frozen,filter='data')
project=frozen/'plugins-registry';config=project/'wrangler.toml'
for rel in ('src/page.ts','src/index.ts','wrangler.toml'):
 actual=(project/rel).read_bytes();expected=subprocess.check_output(['git','show',commit+':plugins-registry/'+rel],cwd=root);assert actual==expected
mode=sys.argv[1];args={'dry-run':['deploy','--dry-run','--outdir',str(out/'dry-bundle')],'deploy':['deploy','--outdir',str(out/'deployed-bundle')]}[mode]
p=subprocess.run([str(wrangler),*args,'--config',str(config)],cwd=project,env=env,capture_output=True,text=True)
log=(p.stdout+p.stderr).replace(env['CLOUDFLARE_API_TOKEN'],'<redacted>');(out/(mode+'.log')).write_text(log)
print(json.dumps({'mode':mode,'exit_code':p.returncode,'log':str(out/(mode+'.log'))}))
if p.returncode:raise SystemExit(p.returncode)
if mode=='deploy':
 version=re.search(r'Current Version ID:\s*([^\s]+)',log);assert version,'Deployment version ID missing'
 data={'source_commit':commit,'wrangler_version':installed['version'],'route':'https://plugins.notemd.net/','worker':'notemd-plugins','version_id':version[1],'channel':'Existing Wrangler 3.114.17 + Account API Token; no OAuth, KV or R2 writes','source_files_sha256':{rel:hashlib.sha256((project/rel).read_bytes()).hexdigest() for rel in ('src/page.ts','src/index.ts','wrangler.toml')}}
 (out/'deployment.json').write_text(json.dumps(data,indent=2)+'\n');print(json.dumps(data))
