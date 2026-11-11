#!/usr/bin/env python3
"""Full anonymous readback of all six public host assets; never publishes.

Use --transport browser or rest explicitly. Large files are downloaded over
every HTTP range, then assembled and SHA-256/minisign verified. No fallback.
"""
import argparse
import base64
import concurrent.futures
import datetime
import hashlib
import json
import re
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
SOURCE = None
TAG = 'v6.1111.3'
REPO = 'wizlijun/note.md'
API = 'https://api.github.com/repos/' + REPO
CHUNK = 2 * 1024 * 1024

class PublicRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        parsed = urllib.parse.urlparse(newurl)
        host = parsed.hostname or ''
        assert parsed.scheme == 'https' and not parsed.username and not parsed.password
        assert host in ('github.com', 'api.github.com') or host.endswith('.githubusercontent.com')
        return super().redirect_request(request, fp, code, msg, headers, newurl)

def check_response(body, headers, status, expected, start=None, total=None):
    assert status == (206 if start is not None else 200), 'Unexpected HTTP status'
    assert len(body) == expected, 'Response body length differs'
    assert int(headers.get('Content-Length', '-1')) == expected, 'Content-Length differs'
    if start is not None:
        assert headers.get('Content-Range') == f'bytes {start}-{start + expected - 1}/{total}', 'Content-Range differs'

def read(url, bound, start=None, total=None, asset=False):
    for attempt in range(4):
        try:
            headers = {'User-Agent': 'note-md-full-public-artifact-verification', 'Cache-Control': 'no-cache'}
            if asset and '/releases/assets/' in url:
                headers['Accept'] = 'application/octet-stream'
            if start is not None:
                headers['Range'] = f'bytes={start}-{start + bound - 1}'
            opener = urllib.request.build_opener(PublicRedirect())
            with opener.open(urllib.request.Request(url, headers=headers), timeout=60) as response:
                body = response.read(bound + 1)
                assert len(body) <= bound, 'Response exceeds bound'
                if asset:
                    check_response(body, response.headers, response.status, bound, start, total)
                else:
                    assert response.status == 200
                return body
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as error:
            label = urllib.parse.urlparse(url).path.rsplit('/', 1)[-1]
            print(f'ANONYMOUS RETRY asset={label} range_start={start} attempt={attempt + 1} status={getattr(error, "code", None)} type={type(error).__name__}', flush=True)
            if attempt == 3:
                raise RuntimeError('Anonymous endpoint failed after bounded retries; no fallback used') from None
            time.sleep(attempt + 1)

def save_exact(path, data):
    if path.exists():
        assert path.read_bytes() == data, 'Previously saved bytes changed: ' + path.name
    else:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

def api(path):
    return json.loads(read(API + path, 1024 * 1024))

def full_asset(asset, prior, transport, out):
    name = asset['name']
    canonical = f'https://github.com/{REPO}/releases/download/{TAG}/{name}'
    assert asset['browser_download_url'] == canonical
    assert asset['url'] == f'{API}/releases/assets/{asset["id"]}'
    url = canonical if transport == 'browser' else asset['url']
    receipt_path = out / 'receipts' / (name + '.json')
    if receipt_path.exists():
        receipt = json.loads(receipt_path.read_text())
        data = (out / name).read_bytes()
        assert receipt['tag'] == TAG and receipt['transport'] == transport
        assert receipt['name'] == name and receipt['asset_id'] == str(asset['id']) and receipt['download_endpoint'] == url
        assert receipt['anonymous_full_file_download'] is True
        assert receipt['bytes'] == len(data) == asset['size'] == prior['bytes']
        digest = hashlib.sha256(data).hexdigest()
        assert receipt['sha256'] == digest == prior['sha256'] and receipt['github_digest'] == asset['digest'] == prior['github_digest'] == 'sha256:' + digest
        print('REUSED VERIFIED ANONYMOUS FULL FILE ' + name, flush=True)
        return dict(receipt, reused_verified_download=True)
    ranges = []
    if asset['size'] <= 1024 * 1024:
        data = read(url, asset['size'], asset=True)
    else:
        def fetch(start):
            length = min(CHUNK, asset['size'] - start)
            path = out / 'ranges' / name / f'{start:010d}-{start + length - 1:010d}.part'
            evidence_path = Path(str(path) + '.json')
            if evidence_path.exists():
                evidence = json.loads(evidence_path.read_text())
                body = path.read_bytes()
                assert evidence['asset_id'] == str(asset['id']) and evidence['download_endpoint'] == url and evidence['transport'] == transport
                assert evidence['tag'] == TAG and evidence['total'] == asset['size']
                assert evidence['start'] == start and evidence['end'] == start + length - 1 and evidence['http'] == 206
                assert evidence['bytes'] == len(body) == length and evidence['sha256'] == hashlib.sha256(body).hexdigest()
                return dict(evidence, reused_verified_range=True), body
            body = read(url, length, start, asset['size'], asset=True)
            save_exact(path, body)
            evidence = {'start': start, 'end': start + length - 1, 'bytes': length, 'sha256': hashlib.sha256(body).hexdigest(), 'http': 206, 'asset_id': str(asset['id']), 'download_endpoint': url, 'transport': transport, 'tag': TAG, 'total': asset['size'], 'downloaded_at_utc': datetime.datetime.now(datetime.timezone.utc).isoformat()}
            save_exact(evidence_path, (json.dumps(evidence, indent=2) + '\n').encode())
            return evidence, body
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            parts = list(pool.map(fetch, range(0, asset['size'], CHUNK)))
        ranges = [row for row, _ in parts]
        data = b''.join(body for _, body in parts)
    digest = hashlib.sha256(data).hexdigest()
    assert len(data) == asset['size'] == prior['bytes']
    assert digest == prior['sha256'] and 'sha256:' + digest == asset['digest'] == prior['github_digest']
    save_exact(out / name, data)
    print('FULL ANONYMOUS PASS ' + name, flush=True)
    receipt = {'name': name, 'asset_id': str(asset['id']), 'bytes': len(data), 'sha256': digest, 'github_digest': asset['digest'], 'anonymous_full_file_download': True, 'transport': transport, 'canonical_url': canonical, 'download_endpoint': url, 'download_path': str((out / name).relative_to(HERE)), 'ranges': ranges, 'tag': TAG, 'downloaded_at_utc': datetime.datetime.now(datetime.timezone.utc).isoformat()}
    save_exact(receipt_path, (json.dumps(receipt, indent=2) + '\n').encode())
    return receipt

def identity(release):
    return {(row['id'], row['name'], row['size'], row['digest'], row['state']) for row in release['assets']}

def validate_frozen(frozen, source):
    assert frozen['sourceCommit'] == source and frozen['version'] == '6.1111.3'
    expected = {'latest.json', 'note.md-6.1111.3-aarch64.dmg',
                'note.md-aarch64.app.tar.gz', 'note.md-aarch64.app.tar.gz.sig',
                'Faitc5-for-Sumi-0.5.0.14-arm64.pkg', 'faitc5-companion.json'}
    rows = frozen['assets']
    assert len(rows) == 6 and {r['name'] for r in rows} == expected, 'Exact six release assets required'
    for row in rows:
        path = Path(row['path'])
        assert path.is_absolute() and path.name == row['name'], 'Exact local frozen path required'
        assert path.stat().st_size == row['size'] and hashlib.sha256(path.read_bytes()).hexdigest() == row['sha256'], 'Frozen artifact bytes changed'
    return expected


def main():
    global SOURCE
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True)
    parser.add_argument('--repository', required=True, type=Path)
    parser.add_argument('--assets', required=True, type=Path)
    parser.add_argument('--transport', required=True, choices=['browser', 'rest'])
    args = parser.parse_args()
    SOURCE = args.repository.resolve()
    assert re.fullmatch('[0-9a-f]{40}', args.source)
    assert subprocess.check_output(['git', '-C', str(SOURCE), 'rev-parse', TAG + '^{commit}'], text=True).strip() == args.source
    frozen = json.loads(args.assets.read_text())
    names = validate_frozen(frozen, args.source)
    release = api('/releases/tags/' + TAG)
    assert release['tag_name'] == TAG and release['draft'] is False and release['prerelease'] is False
    assert len(release['assets']) == 6 and {a['name'] for a in release['assets']} == names
    ref = api('/git/ref/tags/' + TAG)['object']
    tag_object = ref['sha']
    if ref['type'] == 'tag':
        ref = api('/git/tags/' + ref['sha'])['object']
    assert ref['type'] == 'commit' and ref['sha'] == args.source
    prior = {row['name']: dict(bytes=row['size'], sha256=row['sha256'], github_digest='sha256:'+row['sha256']) for row in frozen['assets']}
    for row in release['assets']:
        old = prior[row['name']]
        assert row['size'] == old['bytes'] and row['digest'] == old['github_digest'] and row['state'] == 'uploaded'
    out = HERE / ('host-public-full-' + args.transport)
    records = [full_asset(asset, prior[asset['name']], args.transport, out) for asset in release['assets']]
    latest = json.loads((out / 'latest.json').read_bytes())
    assert latest['version'] == '6.1111.3' and set(latest['platforms']) == {'darwin-aarch64'}
    platform = latest['platforms']['darwin-aarch64']
    assert platform['url'] == f'https://github.com/{REPO}/releases/download/{TAG}/note.md-aarch64.app.tar.gz'
    signature = (out / 'note.md-aarch64.app.tar.gz.sig').read_bytes()
    assert platform['signature'].strip() == signature.decode().strip()
    config = json.loads(subprocess.check_output(['git', '-C', str(SOURCE), 'show', args.source + ':src-tauri/tauri.conf.json'], text=True))
    key = base64.b64decode(config['plugins']['updater']['pubkey'], validate=True).decode().splitlines()[1]
    save_exact(out / 'updater.minisig', base64.b64decode(signature.strip(), validate=True))
    subprocess.run(['minisign', '-V', '-P', key, '-m', str(out / 'note.md-aarch64.app.tar.gz'), '-x', str(out / 'updater.minisig')], check=True, capture_output=True)
    approved = json.loads(subprocess.check_output(['git', '-C', str(SOURCE), 'show', args.source + ':scripts/release-companions/faitc5.json'], text=True))
    companion = json.loads((out / 'faitc5-companion.json').read_bytes())
    assert companion == approved, 'Public companion metadata differs from frozen release approval'
    package = (out / approved['filename']).read_bytes()
    assert len(package) == approved['bytes'] and hashlib.sha256(package).hexdigest() == approved['sha256']
    after = api('/releases/tags/' + TAG)
    assert after['tag_name'] == TAG and after['draft'] is False and after['prerelease'] is False and identity(after) == identity(release)
    assert api('/git/ref/tags/' + TAG)['object']['sha'] == tag_object
    report = {'status': 'passed', 'verified_at_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'tag': TAG, 'commit': args.source, 'tag_object': tag_object, 'transport': args.transport, 'anonymous_full_file_download': True, 'assets': records, 'updater_signature_verified': True, 'faitc5_companion_verified': True, 'frozen_assets': str(args.assets.resolve()), 'signature_message': 'entire anonymously downloaded public tar', 'canonical_browser_download_endpoint_verified': args.transport == 'browser', 'evidence_boundary': 'All six assets were fully anonymously downloaded; large files contain every range and their assembled entire SHA-256 matches the exact frozen local assets and unchanged public asset identity.', 'mutations': 'none: read-only public verification', 'fallback_used': False}
    (HERE / ('public-host-full-' + args.transport + '-verification.json')).write_text(json.dumps(report, indent=2) + '\n')
    print('FULL PUBLIC HOST VERIFICATION PASSED: ' + args.transport)

if __name__ == '__main__':
    main()
