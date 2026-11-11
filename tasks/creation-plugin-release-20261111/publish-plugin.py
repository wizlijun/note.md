"""Two immutable creation plugin packages through existing Wrangler 3 + Account Token.
Default check is offline. inspect is read-only; stage/publish-index are explicit
future actions and are not run while preparing this script.
"""
import argparse,hashlib,json,os,re,signal,subprocess,sys,time,zipfile
from pathlib import Path
ROOT=Path('/Users/bruce/git/mdeditor')
HERE=Path(__file__).resolve().parent
SOURCE=ROOT
HOST='6.1111.1'
WRANGLER=ROOT/'plugins-registry/node_modules/.bin/wrangler'
CONFIG=ROOT/'plugins-registry/wrangler.toml'
INDEX='https://plugins.notemd.net/api/index.json'
PUBLIC=HERE/'plugins-public'
FROZEN = None
ROWS = []
PUB = None
EXPECTED = [('notemd.sumi', '0.1.15', 'aarch64-apple-darwin'),
            ('notemd.idea-spark', '1.3.9', 'universal')]
MANIFEST_PATHS = {'notemd.sumi': 'plugins-src/write/manifest.v2.json',
                  'notemd.idea-spark': 'plugins-src/idea-spark/manifest.v2.json'}
MIN_HOSTS = {'notemd.sumi': '>=6.1111.1', 'notemd.idea-spark': '>=6.1110.4'}


def load_frozen(expected_source=None):
    global FROZEN, ROWS, PUB, SOURCE
    path = HERE/'frozen-plugin-packages.json'
    require(path.is_file(), 'Source/package not frozen yet; do not build or publish from this template')
    FROZEN = json.loads(path.read_text())
    require(re.fullmatch('[0-9a-f]{40}', FROZEN.get('sourceCommit', '')), 'Exact frozen source commit required')
    if expected_source is not None:
        require(re.fullmatch('[0-9a-f]{40}', expected_source) and FROZEN['sourceCommit']==expected_source, 'Frozen input differs from explicitly selected final source')
    source_repository = FROZEN.get('sourceRepository', '')
    require(isinstance(source_repository, str) and source_repository and Path(source_repository).is_absolute(), 'Frozen source repository must be explicit and absolute')
    SOURCE = Path(source_repository).resolve()
    require(SOURCE.is_dir(), 'Frozen source repository no longer available')
    ROWS = FROZEN['packages']
    require([(r['id'],r['version'],r['arch']) for r in ROWS] ==
            EXPECTED, 'Only frozen Sumi 0.1.15 arm64 and IdeaSpark 1.3.9 universal are in scope')
    require(all(r.get('sourceCommit')==FROZEN['sourceCommit'] for r in ROWS),'Package/source receipt mismatch')
    require(len(ROWS[0].get('verification',{}).get('soundFiles',{}))==14,'Sumi must include verified sounds')
    key_source = subprocess.check_output(['git','-C',str(SOURCE),'show',FROZEN['sourceCommit']+':src-tauri/src/plugin_runtime/market.rs']).decode()
    PUB = re.search(r'PLUGIN_REGISTRY_PUBKEY: &str =\s*"([^"]+)"', key_source).group(1)


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
    return url + '?release=creation-20261111-' + str(time.time_ns())

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


def package_path(row): return ROOT/row['packagePath']
def download(row): return f"https://plugins.notemd.net/api/download/{row['id']}/{row['version']}/{row['arch']}"

def validate_manifest_and_entry(row, manifest, source_manifest, entry):
    require(manifest == source_manifest, 'Packaged manifest differs from final source')
    require((manifest['id'], manifest['version']) == (row['id'], row['version']), 'Package identity differs')
    minimum = MIN_HOSTS[row['id']]
    require(manifest['engines']['notemd'] == minimum, 'Minimum host must not change')
    menus = manifest.get('contributes', {}).get('menus', [])
    require(menus and all(menu.get('submenu') == 'create' for menu in menus), 'Manifest must use create submenu')
    expected = {
        'id': row['id'], 'version': row['version'], 'min_host': minimum,
        'archs': [row['arch']], 'size': row['bytes'],
        'sha256': {row['arch']: row['sha256']},
        'name': manifest['name'], 'category': 'create',
        'description': manifest.get('description'), 'i18n': manifest.get('i18n'),
        'icon_url': manifest.get('icon_url'), 'changelog_url': manifest.get('changelog_url'),
        'download': {row['arch']: download(row)},
    }
    require(entry == expected, 'Generated candidate differs from exact final manifest/package')


def check_packages():
    generated=json.loads((SOURCE/'dist-plugins/index.json').read_text())
    result=[]
    for row in ROWS:
        path=package_path(row)
        require(path.name == row['arch'] + '.notemdpkg', 'Unexpected package basename/R2 key')
        require(digest(path)==row['sha256'] and path.stat().st_size==row['bytes'],'Frozen package bytes differ')
        require(digest(Path(str(path)+'.minisig'))==row['signatureSha256'],'Frozen signature differs')
        signature(path)
        with zipfile.ZipFile(path) as archive:
            names=[x.filename for x in archive.infolist() if not x.is_dir()]
            require(len(names)==len(set(names)) and {n:hashlib.sha256(archive.read(n)).hexdigest() for n in names}==row['files'],'Frozen package inventory changed')
            manifest=json.loads(archive.read('manifest.json'))
        source_manifest=json.loads(subprocess.check_output(['git','-C',str(SOURCE),'show',FROZEN['sourceCommit']+':'+MANIFEST_PATHS[row['id']]]))
        if row['id'] == 'notemd.sumi':
            require(not any(name.startswith('ui/sounds/') for name in row['files']),'Duplicate UI sounds forbidden')
            expected_sounds={'resources/sounds/'+name:sha for name,sha in row['verification']['soundFiles'].items()}
            require({name:sha for name,sha in row['files'].items() if name.startswith('resources/sounds/')}==expected_sounds,'Frozen sound inventory differs')
            for name,sha in expected_sounds.items():
                raw=subprocess.check_output(['git','-C',str(SOURCE),'show',FROZEN['sourceCommit']+':plugins-src/write/'+name])
                require(hashlib.sha256(raw).hexdigest()==sha,'Sound bytes differ from final source')
        matches=[e for e in generated['plugins'] if (e['id'],e['version'])==(row['id'],row['version'])]
        require(len(matches)==1,'Expected one generated candidate entry')
        entry=matches[0]
        validate_manifest_and_entry(row, manifest, source_manifest, entry)
        result.append(entry)
    return result


def migrated_history(live, entries):
    # New-version conflicts must be checked before migration: category alone
    # cannot legitimize a conflicting previously occupied release identity.
    new_keys = {(e['id'], e['version']) for e in entries}
    return [{**e, 'category': 'create'}
            if e['id'] in MANIFEST_PATHS and (e['id'], e['version']) not in new_keys
            else e for e in live['plugins']]


def merge_entries(live, entries):
    require([(e.get('id'), e.get('version')) for e in entries] ==
            [(id, version) for id, version, _ in EXPECTED], 'Only both frozen versions may be appended')
    require(all(e.get('category') == 'create' for e in entries), 'New entries must use create')
    keys=[(x['id'],x['version']) for x in live['plugins']]
    require(len(keys)==len(set(keys)),'Duplicate existing registry identities')
    result=migrated_history(live, entries)
    for entry in entries:
        existing=[x for x in result if (x['id'],x['version'])==(entry['id'],entry['version'])]
        if existing: require(existing==[entry],'Existing immutable registry entry differs')
        else: result.append(entry)
    return {**live,'plugins':result}


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
    print('Both packages and signatures read back completely; index unchanged')

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
    require(candidate['plugins'][:len(before['plugins'])]==migrated_history(before,entries),'Unauthorized historical entry change')
    save('plugins-index-verification.json',{'ok':True,'before':len(before['plugins']),'after':len(candidate['plugins']),'onlyAdded':candidate['plugins'][len(before['plugins']):],'historicalFieldsPreservedExceptApprovedCategories':True,'categoryChanges':[{'id':old['id'],'version':old['version'],'from':old.get('category'),'to':new.get('category')} for old,new in zip(before['plugins'],candidate['plugins']) if old!=new],'publicNormalFreshAndKvEqual':True,'compatibleHostPublic':True,'minimumHosts':MIN_HOSTS})

def verify_wrangler_installation():
    # Local metadata only: even --version may run an update check in this CLI.
    installed=json.loads((ROOT/'plugins-registry/node_modules/wrangler/package.json').read_text())
    require(installed.get('name')=='wrangler' and installed.get('version')=='3.114.17' and WRANGLER.is_file(), 'Only existing repository Wrangler 3.114.17 allowed')

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode',nargs='?',default='check',choices=['check','inspect','stage','publish-index'])
    parser.add_argument('--source',required=True,help='Exact final feature source SHA, matching frozen package evidence')
    args=parser.parse_args();mode=args.mode
    load_frozen(args.source)
    entries=check_packages()
    verify_wrangler_installation()
    if mode=='inspect':inspect(entries)
    elif mode=='stage':stage()
    elif mode=='publish-index':publish_index(entries)
    else:print('Both frozen packages, signatures, index candidates and Wrangler checked; no external writes')
if __name__=='__main__':main()
