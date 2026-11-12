"""One immutable Sumi 0.1.16 dual architecture release through existing Wrangler 3 + Account Token.
Default check is offline. inspect is read-only; stage/publish-index are explicit
future actions and are not run while preparing this script.
"""
import argparse,hashlib,json,os,re,signal,subprocess,sys,time,zipfile
from pathlib import Path
HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[1]
SOURCE=ROOT
HOST='6.1111.1'
WRANGLER=ROOT/'plugins-registry/node_modules/.bin/wrangler'
CONFIG=ROOT/'plugins-registry/wrangler.toml'
INDEX='https://plugins.notemd.net/api/index.json'
PUBLIC=HERE/'plugins-public'
import copy, importlib.util
_spec=importlib.util.spec_from_file_location('prepare_sumi', HERE/'prepare-plugin.py')
prepare=importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(prepare)
FROZEN = None
ROWS = []
PUB = None


def load_frozen(expected_source):
    global FROZEN, ROWS, PUB, SOURCE
    require(re.fullmatch('[0-9a-f]{40}', expected_source or ''), 'Exact final source commit required')
    FROZEN = prepare.check_candidate(expected_source)
    SOURCE = Path(FROZEN['sourceRepository'])
    ROWS = FROZEN['packages']
    PUB = prepare.public_key()


def freeze(source):
    candidate = prepare.check_candidate()
    require(re.fullmatch('[0-9a-f]{40}', source or ''), 'Exact final source commit required')
    for name, digest in candidate['sourceFiles'].items():
        raw = subprocess.check_output(['git', 'show', source + ':' + name], cwd=ROOT)
        require(hashlib.sha256(raw).hexdigest() == digest, 'Final source differs from built candidate: ' + name)
    frozen = {**candidate, 'sourceCommit': source, 'sourceStatus': 'bound to exact committed build inputs'}
    destination = HERE/'frozen-plugin-packages.json'
    if destination.exists():
        require(json.loads(destination.read_text()) == frozen, 'Refuse replacing an existing source freeze')
    else:
        save('frozen-plugin-packages.json', frozen)
    load_frozen(source)


def require(condition, message):
    if not condition:
        raise RuntimeError(message)

def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def save(name, value):
    (HERE / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')

def env():
    result = os.environ.copy()
    for line in (ROOT / '.env').read_text().splitlines():
        match = re.match(r'(?:export\s+)?CLOUDFLARE_API_TOKEN\s*=\s*(.*)', line)
        if match:
            result['CLOUDFLARE_API_TOKEN'] = match[1].strip().strip('"\'')
    require(bool(result.get('CLOUDFLARE_API_TOKEN')), 'Account API Token required')
    result['WRANGLER_SEND_METRICS'] = 'false'
    return result

def wrangler(args, log=None):
    command = [str(WRANGLER), *args, '--config', str(CONFIG)]
    output = (HERE / log).open('a') if log else subprocess.PIPE
    process = subprocess.Popen(command, cwd=ROOT / 'plugins-registry', env=env(), stdout=output,
                               stderr=subprocess.STDOUT if log else subprocess.PIPE, start_new_session=True)
    try:
        stdout, stderr = process.communicate(timeout=600)
        return subprocess.CompletedProcess(command, process.returncode, stdout, stderr)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.communicate()
        raise
    finally:
        if log:
            output.close()

def fetch(url, path):
    result = subprocess.run(['curl', '--silent', '--show-error', '--location', '--retry', '2',
                             '--connect-timeout', '15', '--max-time', '180', '-A', 'note.md-release-audit',
                             '--output', str(path), '--write-out', '%{http_code}', url],
                            capture_output=True, text=True, timeout=600)
    require(result.returncode == 0, 'Anonymous fetch failed: ' + url)
    return int(result.stdout)

def fresh(url):
    return url + '?release=fcitx5-name-20261112-' + str(time.time_ns())

def signature(package):
    result = subprocess.run(['minisign', '-Vm', str(package), '-P', PUB], capture_output=True)
    require(result.returncode == 0, 'Minisign verification failed: ' + str(package))

def read_kv(name):
    result = wrangler(['kv:key', 'get', 'index', '--binding', 'INDEX'])
    require(result.returncode == 0, 'KV read failed')
    value = json.loads(result.stdout)
    require(isinstance(value.get('plugins'), list), 'Invalid registry index')
    save(name, value)
    return value

def require_public_host():
    api = f'https://api.github.com/repos/wizlijun/note.md/releases/tags/v{HOST}'
    require(fetch(fresh(api), HERE / 'plugin-host-gate-release.json') == 200, 'Compatible host release is not public')
    release = json.loads((HERE / 'plugin-host-gate-release.json').read_text())
    require(release.get('tag_name') == 'v' + HOST and release.get('draft') is False
            and release.get('prerelease') is False and bool(release.get('published_at')),
            'Compatible host release is draft/prerelease/unpublished')
    names = {asset['name'] for asset in release.get('assets', [])}
    require({'latest.json', 'note.md-aarch64.app.tar.gz', 'note.md-aarch64.app.tar.gz.sig',
             f'note.md-{HOST}-aarch64.dmg'}.issubset(names), 'Compatible host assets missing')
    base = f'https://github.com/wizlijun/note.md/releases/download/v{HOST}/'
    latest_path = HERE / 'plugin-host-gate-latest.json'
    canonical_transport_error = None
    try:
        canonical_status = fetch(fresh(base + 'latest.json'), latest_path)
    except (RuntimeError, subprocess.TimeoutExpired) as error:
        canonical_status = None
        canonical_transport_error = type(error).__name__
    gate_endpoint = 'canonical'
    if canonical_status != 200:
        # Same immutable public asset via GitHub's anonymous official REST endpoint.
        asset = next(item for item in release['assets'] if item['name'] == 'latest.json')
        require(asset['url'].startswith('https://api.github.com/repos/wizlijun/note.md/releases/assets/'),
                'Unexpected asset endpoint')
        response = subprocess.run(['curl', '--silent', '--show-error', '--location',
            '--connect-timeout', '15', '--max-time', '90', '-H', 'Accept: application/octet-stream',
            '--output', str(latest_path), '--write-out', '%{http_code}', fresh(asset['url'])],
            capture_output=True, text=True, timeout=100)
        require(response.returncode == 0 and response.stdout == '200', 'Anonymous REST manifest unavailable')
        require('sha256:' + digest(latest_path) == asset['digest'] and latest_path.stat().st_size == asset['size'],
                'Anonymous REST manifest differs from frozen public asset')
        gate_endpoint = 'anonymous_official_rest_asset'
    asset = next(item for item in release['assets'] if item['name'] == 'latest.json')
    require('sha256:' + digest(latest_path) == asset['digest'] and latest_path.stat().st_size == asset['size'],
            'Public manifest differs from frozen release identity')
    save('plugin-host-gate-endpoint.json', {'canonical_status': canonical_status, 'canonical_transport_error': canonical_transport_error, 'verified_endpoint': gate_endpoint,
         'manifest_sha256': digest(latest_path), 'ordinary_download_route_verified': canonical_status == 200})
    latest = json.loads((HERE / 'plugin-host-gate-latest.json').read_text())
    platform = latest.get('platforms', {}).get('darwin-aarch64', {})
    require(latest.get('version') == HOST and platform.get('url') == base + 'note.md-aarch64.app.tar.gz'
            and bool(platform.get('signature')), 'Compatible host updater manifest differs')


def package_path(row): return HERE/row['packagePath']
def download(row): return f"https://plugins.notemd.net/api/download/{row['id']}/{row['version']}/{row['arch']}"


def check_packages():
    # Full signature, exact ZIP inventory, backend/resource reuse and source
    # binding were checked by load_frozen/prepare.check_candidate above.
    manifest=json.loads(prepare.inventory(package_path(ROWS[0]))['manifest.json'])
    entry = {
        'id': 'notemd.sumi', 'version': '0.1.16', 'min_host': '>=6.1111.1',
        'archs': prepare.ARCHS, 'size': max(r['bytes'] for r in ROWS),
        'sha256': {r['arch']: r['sha256'] for r in ROWS},
        'name': manifest['name'], 'category': 'create', 'description': manifest.get('description'),
        'i18n': manifest.get('i18n'), 'icon_url': manifest.get('icon_url'),
        'changelog_url': manifest.get('changelog_url'),
        'download': {r['arch']: download(r) for r in ROWS},
    }
    validate_entry(entry)
    save('plugin-index-entry.json', entry)
    return [entry]


def validate_entry(entry):
    require((entry.get('id'),entry.get('version'),entry.get('min_host'),entry.get('category')) ==
            ('notemd.sumi','0.1.16','>=6.1111.1','create'), 'Only unchanged Sumi identity/minimum host/category in scope')
    require(entry.get('archs') == prepare.ARCHS, 'Both existing platforms must remain available')
    require(set(entry.get('sha256',{})) == set(prepare.ARCHS) and set(entry.get('download',{})) == set(prepare.ARCHS), 'Architecture hash/download inventory differs')
    for arch in prepare.ARCHS:
        require(re.fullmatch('[0-9a-f]{64}', entry['sha256'][arch]), 'Invalid package hash')
        require(entry['download'][arch] == download({'id':'notemd.sumi','version':'0.1.16','arch':arch}), 'Unexpected download URL')


def merge_entries(live, entries):
    require(len(entries) == 1, 'Only one Sumi 0.1.16 entry may be appended')
    validate_entry(entries[0])
    keys=[(x['id'],x['version']) for x in live['plugins']]
    require(len(keys)==len(set(keys)), 'Duplicate existing registry identities')
    result=copy.deepcopy(live)
    existing=[x for x in result['plugins'] if (x['id'],x['version'])==('notemd.sumi','0.1.16')]
    if existing:
        require(existing == entries, 'Existing immutable Sumi 0.1.16 entry differs')
    else:
        result['plugins'].append(copy.deepcopy(entries[0]))
    require(result['plugins'][:len(live['plugins'])] == live['plugins'], 'Historical registry entries changed')
    return result


def verify_public_packages():
    proof=[]
    for row in ROWS:
        for mode in ['normal','fresh']:
            folder=PUBLIC/row['id']/mode;folder.mkdir(parents=True,exist_ok=True)
            for suffix in ['', '.minisig']:
                source=Path(str(package_path(row))+suffix);target=folder/source.name
                for attempt in range(18):
                    url=download(row)+suffix
                    code=fetch(url if mode=='normal' else fresh(url),target)
                    if code==200:
                        require(target.read_bytes()==source.read_bytes(),'Immutable public object differs');break
                    require(code==404,f'Public read uncertain: HTTP {code}; stop')
                    if attempt==17: raise RuntimeError('Object propagation incomplete; do not rewrite')
                    time.sleep(5)
                proof.append({'id':row['id'],'version':row['version'],'mode':mode,'file':source.name,'sha256':digest(target),'bytes':target.stat().st_size})
            signature(folder/package_path(row).name)
    save('plugins-public-packages.json',{'ok':True,'signatures_valid':True,'objects':proof})

def inspect(entries):
    folder=HERE/'occupancy';folder.mkdir(exist_ok=True)
    code=fetch(fresh(INDEX),folder/'public-index.json');require(code==200,'Public index unavailable')
    public=json.loads((folder/'public-index.json').read_bytes())
    kv=read_kv('plugins-index-readonly.json')
    wanted={(r['id'],r['version']) for r in ROWS}
    objects=[]
    for row in ROWS:
        for suffix in ['', '.minisig']:
            target=folder/(row['id']+'-'+row['arch']+suffix.replace('.','_')+'.body')
            code=fetch(fresh(download(row)+suffix),target)
            require(code in (200,404),f'Presence uncertain: HTTP {code}')
            same=target.read_bytes()==Path(str(package_path(row))+suffix).read_bytes() if code==200 else None
            require(same is not False,'Occupied immutable object differs')
            objects.append({'id':row['id'],'version':row['version'],'arch':row['arch'],'suffix':suffix,'httpStatus':code,'sameFrozenBytes':same})
    # A same-version conflict is a hard stop; absent entries are only prepared.
    merge_entries(kv,entries);merge_entries(public,entries)
    save('plugins-version-occupancy.json',{'readOnly':True,'objects':objects,'publicMatches':[e for e in public['plugins'] if (e['id'],e['version']) in wanted],'kvMatches':[e for e in kv['plugins'] if (e['id'],e['version']) in wanted],'limitation':'Observation, not a reservation; stage rechecks every immutable key before writes.'})
    print('Read-only package/key/index occupancy checked; no writes')

def stage():
    PUBLIC.mkdir(exist_ok=True)
    # Inspect both immutable keys before the first write. A conflicting later
    # signature must not leave earlier missing packages partially staged.
    preflight=[]
    for row in ROWS:
        for suffix in ['', '.minisig']:
            source=Path(str(package_path(row))+suffix)
            target=PUBLIC/('preflight-'+row['id']+'-'+source.name)
            code=fetch(fresh(download(row)+suffix),target)
            require(code in (200,404),f'HTTP {code}: presence uncertain; do not write')
            same=target.read_bytes()==source.read_bytes() if code==200 else None
            require(same is not False,'Immutable object differs: '+row['id']+'/'+source.name)
            preflight.append({'id':row['id'],'version':row['version'],'file':source.name,'httpStatus':code,'sameFrozenBytes':same})
    save('plugins-r2-preflight.json',{'objects':preflight,'writesPerformed':False})
    # Recheck each key immediately before a put; preflight is not a reservation.
    for row in ROWS:
        for suffix in ['', '.minisig']:
            source=Path(str(package_path(row))+suffix);key=f"{row['id']}/{row['version']}/{source.name}"
            target=PUBLIC/('probe-'+row['id']+'-'+source.name)
            for attempt in range(4):
                code=fetch(fresh(download(row)+suffix),target)
                if code==200:
                    require(target.read_bytes()==source.read_bytes(),'Immutable object differs: '+key);break
                require(code==404,f'HTTP {code}: presence uncertain; do not write')
                if attempt==3: raise RuntimeError('Object absent after retries: '+key)
                try:
                    result=wrangler(['r2','object','put','notemd-plugins/'+key,'--file',str(source),'--content-type','application/octet-stream'],'plugins-r2-upload.log')
                    print('R2 attempt',attempt+1,key,'exit',result.returncode,flush=True)
                except subprocess.TimeoutExpired:
                    print('R2 timeout; checking object before any retry',key,flush=True)
    verify_public_packages()
    print('Sumi package and signature read back completely; index unchanged')

def publish_index(entries):
    require_public_host()
    verify_public_packages()
    before=read_kv('plugins-index-before.json');candidate=merge_entries(before,entries)
    save('plugins-index-candidate.json',candidate)
    if candidate!=before:
        require(read_kv('plugins-index-prepublish.json')==before,'Concurrent index change; stop and rebase')
        try:
            result=wrangler(['kv:key','put','index','--path',str(HERE/'plugins-index-candidate.json'),'--binding','INDEX'],'plugins-kv-upload.log')
            print('KV write exit',result.returncode,flush=True)
        except subprocess.TimeoutExpired: print('KV timeout; read back before retry',flush=True)
    require(read_kv('plugins-index-kv-final.json')==candidate,'KV content differs; inspect before retry')
    for mode in ['normal','fresh']:
        target=HERE/f'plugins-index-public-{mode}.json'
        for attempt in range(36):
            code=fetch(INDEX if mode=='normal' else fresh(INDEX),target)
            if code==200 and json.loads(target.read_bytes())==candidate: break
            if attempt==35: raise RuntimeError('Public index did not converge; do not rewrite')
            time.sleep(10)
    require(candidate['plugins'][:len(before['plugins'])]==before['plugins'],'Historical entries changed')
    save('plugins-index-verification.json',{'ok':True,'before':len(before['plugins']),'after':len(candidate['plugins']),'onlyAdded':candidate['plugins'][len(before['plugins']):],'historicalEntriesUnchanged':True,'publicNormalFreshAndKvEqual':True,'compatibleHostPublic':True,'minimumHost':'>='+HOST})

def verify_wrangler_installation():
    # Local metadata only: even --version may run an update check in this CLI.
    installed=json.loads((ROOT/'plugins-registry/node_modules/wrangler/package.json').read_text())
    require(installed.get('name')=='wrangler' and installed.get('version')=='3.114.17' and WRANGLER.is_file(), 'Only existing repository Wrangler 3.114.17 allowed')

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['candidate-check','freeze','check','inspect','stage','publish-index'])
    parser.add_argument('--source',help='Exact final committed source; pending candidates cannot publish')
    args=parser.parse_args()
    if args.mode=='candidate-check':
        require(args.source is None, 'Candidate check must not claim a source commit')
        global FROZEN, ROWS, PUB
        FROZEN=prepare.check_candidate()
        ROWS=FROZEN['packages']
        PUB=prepare.public_key()
    elif args.mode=='freeze':
        freeze(args.source)
    else:
        load_frozen(args.source)
    entries=check_packages()
    verify_wrangler_installation()
    if args.mode=='inspect': inspect(entries)
    elif args.mode=='stage': stage()
    elif args.mode=='publish-index': publish_index(entries)
    elif args.mode=='candidate-check': print('Pending-source Sumi candidates checked; PUBLICATION BLOCKED until exact source freeze; no external writes')
    else: print('Frozen Sumi 0.1.16 dual architecture packages checked; no external writes')
if __name__=='__main__': main()
