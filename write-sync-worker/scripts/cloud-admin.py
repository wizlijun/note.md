#!/usr/bin/env python3
"""Sumi-only deployment/onboarding through the repository's Wrangler 3 Account API Token.
All authentication material and raw cloud responses live in a mode-0700 temp directory.
The public report contains only allowlisted resource identities and source hashes.
"""
import argparse, hashlib, json, os, re, secrets, subprocess, tempfile, urllib.request, urllib.error
from email.parser import BytesParser
from email.policy import default
from pathlib import Path
os.umask(0o077)
ROOT=Path(__file__).resolve().parents[2]
WORKER=ROOT/'write-sync-worker'
TASK=ROOT/'tasks/sumi-sync'
WRANGLER=ROOT/'worker/node_modules/.bin/wrangler'
SERVICE='sumi-sync'
BUCKET='sumi-sync-backups'
TASK.mkdir(parents=True,exist_ok=True)

def private_write(path,data):
    raw=data if isinstance(data,bytes) else (json.dumps(data,ensure_ascii=False,indent=2)+'\n').encode()
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
    try:
        os.fchmod(fd,0o600)
        with os.fdopen(fd,'wb') as stream:stream.write(raw)
    except BaseException:
        try:os.close(fd)
        except OSError:pass
        raise

def private_dir():
    marker=TASK/'cloud-private-dir.txt'
    if marker.exists():
        path=Path(marker.read_text().strip())
        if path.is_dir() and path.stat().st_uid==os.getuid() and path.stat().st_mode&0o077==0:return path
        raise RuntimeError('Private state directory ownership/mode mismatch')
    path=Path(tempfile.mkdtemp(prefix='sumi-cloud-',dir='/private/tmp'));os.chmod(path,0o700)
    marker.write_text(str(path)+'\n');return path
PRIVATE=private_dir()

def environment():
    result=os.environ.copy()
    for line in (ROOT/'.env').read_text().splitlines():
        match=re.match(r'(?:export\s+)?CLOUDFLARE_API_TOKEN\s*=\s*(.*)',line)
        if match:result['CLOUDFLARE_API_TOKEN']=match[1].strip().strip('"\'')
    if not result.get('CLOUDFLARE_API_TOKEN'):raise RuntimeError('Existing Account API Token is required')
    account=re.search(r'^account_id\s*=\s*"([0-9a-f]+)"',(ROOT/'worker/wrangler.toml').read_text(),re.M).group(1)
    result.update(CLOUDFLARE_ACCOUNT_ID=account,WRANGLER_SEND_METRICS='false',WRANGLER_LOG='error',WRANGLER_LOG_PATH=str(PRIVATE/'wrangler-debug.log'),CI='true')
    return result
ENV=environment();ACCOUNT=ENV['CLOUDFLARE_ACCOUNT_ID']

def cf(path,method='GET',body=None,allow_missing=False):
    request=urllib.request.Request('https://api.cloudflare.com/client/v4'+path,method=method,headers={'Authorization':'Bearer '+ENV['CLOUDFLARE_API_TOKEN'],'Content-Type':'application/json'},data=None if body is None else json.dumps(body).encode())
    try:
        with urllib.request.urlopen(request,timeout=60) as response:status=response.status;raw=response.read();headers=dict(response.headers)
    except urllib.error.HTTPError as error:
        status=error.code;raw=error.read();headers=dict(error.headers)
    try:payload=json.loads(raw)
    except ValueError:payload=None
    if status==404 and allow_missing:return None
    if status>=400 or (payload is not None and payload.get('success') is False):
        private_write(PRIVATE/'last-api-error.json',raw)
        codes=[e.get('code') for e in (payload or {}).get('errors',[])]
        raise RuntimeError(f'Cloudflare {method} {path}: HTTP {status}, error codes {codes}; private details retained')
    return payload.get('result') if payload is not None else (raw,headers)

def wrangler(args,label):
    version=json.loads((ROOT/'worker/node_modules/wrangler/package.json').read_text())['version']
    if version!='3.114.17':raise RuntimeError('Unverified Wrangler version')
    log=PRIVATE/(label+'.log')
    fd=os.open(log,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
    with os.fdopen(fd,'wb') as stream:
        result=subprocess.run([str(WRANGLER),*args,'--config',str(WORKER/'wrangler.toml')],cwd=WORKER,env=ENV,stdout=stream,stderr=subprocess.STDOUT,timeout=600)
    if result.returncode:raise RuntimeError(f'Wrangler {label} failed ({result.returncode}); private log retained')
    print('Wrangler',label,'succeeded',flush=True)
    return log.read_text()

def source_proof():
    names=['package.json','package-lock.json','wrangler.toml']+[str(p.relative_to(WORKER)) for p in (WORKER/'src').glob('*.ts')]
    files={name:hashlib.sha256((WORKER/name).read_bytes()).hexdigest() for name in sorted(names)}
    status=subprocess.run(['git','status','--porcelain','--','write-sync-worker'],cwd=ROOT,capture_output=True,text=True,check=True).stdout
    commit=subprocess.run(['git','rev-parse','HEAD'],cwd=ROOT,capture_output=True,text=True,check=True).stdout.strip()
    return {'uncommitted':bool(status.strip()),'commit':commit,'files':files,'source_sha256':hashlib.sha256(json.dumps(files,sort_keys=True,separators=(',',':')).encode()).hexdigest(),'wrangler':'3.114.17'}

def report(name,value):(TASK/name).write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n')
def bundle():return json.loads((PRIVATE/'admin.json').read_text())
def keychain(mode):
    exe=PRIVATE/'keychain-build/debug/sumi-admin-keychain'
    if not exe.exists():
        build=subprocess.run(['cargo','+1.99.0','build','--offline','--manifest-path',str(WORKER/'scripts/admin-keychain/Cargo.toml'),'--target-dir',str(PRIVATE/'keychain-build')],capture_output=True)
        private_write(PRIVATE/'keychain-build.log',build.stdout+build.stderr)
        if build.returncode:raise RuntimeError('Keychain helper build failed; details retained privately')
    result=subprocess.run([str(exe),mode,str(PRIVATE/'admin.json')],capture_output=True)
    if result.returncode:raise RuntimeError('Keychain operation failed; no credential was printed')

def main():
    parser=argparse.ArgumentParser();parser.add_argument('mode',choices=['preflight','prepare','bucket','deploy','secrets','retention','verify','verify-source','quota','bootstrap','invite','private-path']);args=parser.parse_args()
    base=f'/accounts/{ACCOUNT}'
    if args.mode=='private-path':print(PRIVATE);return
    if args.mode=='preflight':
        script=cf(base+f'/workers/scripts/{SERVICE}/settings',allow_missing=True)
        bucket=cf(base+f'/r2/buckets/{BUCKET}',allow_missing=True)
        report('cloud-preflight.json',{'service':SERVICE,'bucket':BUCKET,'script_exists':script is not None,'bucket_exists':bucket is not None,'account_id':ACCOUNT,**source_proof()})
        print(json.dumps({'service_exists':script is not None,'bucket_exists':bucket is not None}))
    elif args.mode=='prepare':
        path=PRIVATE/'admin.json'
        if not path.exists():
            try:keychain('get')
            except RuntimeError:
                if cf(base+f'/workers/scripts/{SERVICE}/settings',allow_missing=True) is not None:
                    raise RuntimeError('Existing service has no available owner bundle; refusing credential rotation')
                private_write(path,{'service':SERVICE,'bucket':BUCKET,'accountId':ACCOUNT,'SIGNING_KEY':secrets.token_urlsafe(32),'PROVISION_KEY':secrets.token_urlsafe(32)})
                keychain('put')
        value=bundle()
        if value['service']!=SERVICE or value['accountId']!=ACCOUNT:raise RuntimeError('Owner bundle identity mismatch')
        private_write(PRIVATE/'worker-secrets.json',{name:value[name] for name in ['SIGNING_KEY','PROVISION_KEY']})
        print('Sumi owner bundle prepared in Keychain and private temporary files')
    elif args.mode=='bucket':
        if cf(base+f'/r2/buckets/{BUCKET}',allow_missing=True) is None:wrangler(['r2','bucket','create',BUCKET],'create-bucket')
        info=cf(base+f'/r2/buckets/{BUCKET}')
        report('cloud-bucket.json',{'name':info.get('name',BUCKET),'creation_date':info.get('creation_date')})
        managed=cf(base+f'/r2/buckets/{BUCKET}/domains/managed')
        custom=cf(base+f'/r2/buckets/{BUCKET}/domains/custom')
        domains=custom.get('domains',[]) if isinstance(custom,dict) else custom
        report('cloud-bucket-access.json',{'managedEnabled':managed.get('enabled'),'customDomains':domains})
        if managed.get('enabled') or any(domain.get('enabled') for domain in domains):
            raise RuntimeError('Dedicated backup bucket unexpectedly has public access')
        print('Dedicated private backup bucket verified')
    elif args.mode=='deploy':
        before=source_proof();report('cloud-source-before.json',before)
        output=wrangler(['deploy'],'deploy')
        if source_proof()!=before:raise RuntimeError('Source changed during deploy')
        urls=re.findall(r'https://[^\s]+\.workers\.dev',output)
        if urls:report('cloud-endpoint.json',{'url':urls[-1]})
        print('Sumi code deployed; source hash',before['source_sha256'])
    elif args.mode=='secrets':
        wrangler(['secret','bulk',str(PRIVATE/'worker-secrets.json')],'secrets')
    elif args.mode=='retention':
        rules={'rules':[{'id':'sumi-backups-30-days','enabled':True,'conditions':{'prefix':''},'deleteObjectsTransition':{'condition':{'type':'Age','maxAge':30*24*3600}}}]}
        private_write(PRIVATE/'lifecycle.json',rules)
        wrangler(['r2','bucket','lifecycle','set',BUCKET,'--file',str(PRIVATE/'lifecycle.json'),'--force'],'retention')
        actual=cf(base+f'/r2/buckets/{BUCKET}/lifecycle')
        report('cloud-retention.json',actual)
        if actual!=rules:raise RuntimeError('Lifecycle readback differs')
        print('Dedicated bucket 30-day retention verified')
    elif args.mode=='verify-source':
        wrangler(['deploy','--dry-run','--outdir',str(PRIVATE/'bundle')],'source-dry-run')
        raw,headers=cf(base+f'/workers/scripts/{SERVICE}/content/v2')
        private_write(PRIVATE/'remote-bundle.multipart',raw)
        content_type=next(v for k,v in headers.items() if k.lower()=='content-type')
        message=BytesParser(policy=default).parsebytes(('Content-Type: '+content_type+'\r\nMIME-Version: 1.0\r\n\r\n').encode()+raw)
        remote={part.get_param('name',header='content-disposition'):hashlib.sha256(part.get_payload(decode=True)).hexdigest() for part in message.iter_parts()}
        local={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in (PRIVATE/'bundle').glob('*.js')}
        if not local or any(remote.get(name)!=digest for name,digest in local.items()):raise RuntimeError('Deployed module differs from frozen dry-run bundle')
        report('cloud-source-readback.json',{'remote_modules':remote,'local_modules':local,'matched':True,**source_proof()})
        print('Cloud deployed module bytes match frozen source bundle')
    elif args.mode=='quota':
        from datetime import datetime, timezone, timedelta
        today=datetime.now(timezone.utc).date();tomorrow=today+timedelta(days=1)
        query='{viewer{accounts(filter:{accountTag:"'+ACCOUNT+'"}){durableObjectsPeriodicGroups(limit:1000,filter:{date_geq:"'+str(today)+'",date_lt:"'+str(tomorrow)+'"}){sum{rowsRead rowsWritten exceededCpuErrors exceededMemoryErrors}}}}}'
        request=urllib.request.Request('https://api.cloudflare.com/client/v4/graphql',data=json.dumps({'query':query}).encode(),headers={'Authorization':'Bearer '+ENV['CLOUDFLARE_API_TOKEN'],'Content-Type':'application/json'})
        with urllib.request.urlopen(request,timeout=60) as response:value=json.load(response)
        if value.get('errors'):
            private_write(PRIVATE/'quota-query-error.json',value)
            raise RuntimeError('Account quota query failed; private details retained')
        data=value['data'];data['checkedAt']=datetime.now(timezone.utc).isoformat()
        report('cloud-account-quota-before.json',data)
        sums=data['viewer']['accounts'][0]['durableObjectsPeriodicGroups']
        total={key:sum(row['sum'][key] for row in sums) for key in ['rowsRead','rowsWritten','exceededCpuErrors','exceededMemoryErrors']}
        print('Current UTC-day shared Durable Object usage:',json.dumps(total))
    elif args.mode in ['bootstrap','invite']:
        endpoint=json.loads((TASK/'cloud-endpoint.json').read_text())['url']
        def service(route,value,token=None):
            request=urllib.request.Request(endpoint+route,data=json.dumps(value).encode(),headers={'Content-Type':'application/json','User-Agent':'Sumi-Admin/0.1',**({'Authorization':'Bearer '+token} if token else {})})
            with urllib.request.urlopen(request,timeout=60) as response:return json.load(response)
        value=bundle()
        if 'bootstrap' not in value:
            if args.mode!='bootstrap':raise RuntimeError('Run bootstrap first')
            value['bootstrap']=service('/admin/provision',{},value['PROVISION_KEY'])
            private_write(PRIVATE/'admin.json',value);keychain('put')
        if args.mode=='bootstrap':
            print('Owner space provisioned; bootstrap credentials saved in Keychain')
            report('cloud-owner-space.json',{'spaceId':value['bootstrap']['spaceId'],'deviceId':value['bootstrap']['deviceId'],'baseUrl':endpoint})
        else:
            token=service('/v1/token',value['bootstrap'])['accessToken']
            invitation=service('/v1/pair',{},token)
            private_write(PRIVATE/'owner-invitation.json',{'baseUrl':endpoint,**invitation})
            print('One-use owner invitation written to private file; expires in 5 minutes')
    elif args.mode=='verify':
        deployments=cf(base+f'/workers/scripts/{SERVICE}/deployments')
        settings=cf(base+f'/workers/scripts/{SERVICE}/settings')
        subdomain=cf(base+'/workers/subdomain')
        endpoint=f'https://{SERVICE}.{subdomain["subdomain"]}.workers.dev'
        report('cloud-endpoint.json',{'url':endpoint})
        report('cloud-deployment.json',{'url':endpoint,'deployments':deployments,'settings':settings,**source_proof()})
        print('Deployment metadata verified:',endpoint)
if __name__=='__main__':main()
