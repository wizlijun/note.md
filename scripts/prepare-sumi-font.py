#!/usr/bin/env python3
"""Verify/download pinned Sumi fonts and licenses. No system font installation."""
import hashlib
import io
import json
from pathlib import Path
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parent.parent
DEST = ROOT / 'src-tauri/resources/sumi'
# The tracked manifest is the single source for both development preparation and
# the runtime download catalog; font binaries remain ignored development assets.
MANIFEST = json.loads((DEST / 'manifest.json').read_text())
ASSETS = MANIFEST['assets']
CASCADES = MANIFEST['cascades']


def valid(data, size, sha256):
    return len(data) == size and hashlib.sha256(data).hexdigest() == sha256


# Retire only these obsolete bundled files, after every selected asset verifies.
OBSOLETE = ['CourierPrime-Regular.ttf', 'CourierPrime-OFL.txt', 'SourceHanSerifSC-Regular.otf', 'OFL.txt', 'SpecialElite-Regular.ttf', 'SpecialElite-LICENSE.txt', 'YouyouYisong.ttf', 'YouyouYisong-NOTICE.txt', 'YouyouYisong-PROVENANCE.json']


def prepare():
    pending = {}
    for asset in ASSETS:
        path = DEST / asset['file']
        if path.exists() and valid(path.read_bytes(), asset['size'], asset['sha256']):
            continue
        if asset.get('bundled'):
            raise ValueError(f"{asset['file']}: tracked provenance missing or changed; restore the pinned source document")
        size = asset.get('archive_size', asset['size'])
        sha = asset.get('archive_sha256', asset['sha256'])
        with urllib.request.urlopen(asset['url'], timeout=60) as response:
            data = response.read(size + 1)
        if not valid(data, size, sha):
            raise ValueError(f"{asset['file']}: download size/SHA-256 mismatch; resources unchanged")
        if 'archive_size' in asset:
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                if archive.namelist() != [asset['file']] or archive.getinfo(asset['file']).file_size != asset['size']:
                    raise ValueError('Unexpected Zhuque archive structure; resources unchanged')
                data = archive.read(asset['file'])
        if not valid(data, asset['size'], asset['sha256']):
            raise ValueError(f"{asset['file']}: extracted font mismatch; resources unchanged")
        pending[path] = data
    DEST.mkdir(parents=True, exist_ok=True)
    for path, data in pending.items():
        temporary = path.with_suffix(path.suffix + '.download')
        temporary.write_bytes(data)
        temporary.replace(path)
    for obsolete in OBSOLETE:
        (DEST / obsolete).unlink(missing_ok=True)
    fonts = sum('postscript' in asset for asset in ASSETS)
    print(f'Sumi: {len(CASCADES)} selected cascades, {fonts} fonts, licenses and provenance verified; obsolete fonts removed')


if __name__ == '__main__':
    prepare()
