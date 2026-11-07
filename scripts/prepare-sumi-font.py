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
GOOGLE = 'https://raw.githubusercontent.com/google/fonts/03c54f8f0fae0c403c43f326068d9060121c9bd1/apache/specialelite/'
ADOBE = 'https://raw.githubusercontent.com/adobe-fonts/source-han-serif/2.003R/'
ASSETS = [
    dict(file='SpecialElite-Regular.ttf', url=GOOGLE + 'SpecialElite-Regular.ttf', size=166180, sha256='a776fcb4ceb8bdf03e2967688ebdad42680de5b91a7e62c17e718ae212d14bc4'),
    dict(file='SpecialElite-LICENSE.txt', url=GOOGLE + 'LICENSE.txt', size=11358, sha256='cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30'),
    dict(file='ZhuqueFangsong-Regular.ttf', url='https://github.com/TrionesType/zhuque/releases/download/v0.212/ZhuqueFangsong-v0.212.zip', size=8824084, sha256='558c62730844fe54ba220146ed62f859d4e2880188d92d985f8921c6e3743bc4', archive_size=5743932, archive_sha256='bb8b661a7643d2296a72d9d10530a00949419c4e527fb61783f73c2ba1a8c062'),
    dict(file='ZhuqueFangsong-LICENSE.txt', url='https://raw.githubusercontent.com/TrionesType/zhuque/v0.212/LICENSE.txt', size=4389, sha256='66cc01ad4df62fca6936431a426104cb32a52ce8da49de9a7d643e02d7659043'),
    dict(file='SourceHanSerifSC-Regular.otf', url=ADOBE + 'OTF/SimplifiedChinese/SourceHanSerifSC-Regular.otf', size=24543332, sha256='78aa7a328fd974df2d688c8a9fd74a33d8334dfa84ab24d9d11efb2ffc464117'),
    dict(file='OFL.txt', url=ADOBE + 'LICENSE.txt', size=4463, sha256='9ff5bb567e1b92c801fc1069e5fbf992ff8efccacb9db94e5959a5b3ba9bb903'),
]


def valid(data, size, sha256):
    return len(data) == size and hashlib.sha256(data).hexdigest() == sha256


def prepare():
    pending = {}
    for asset in ASSETS:
        path = DEST / asset['file']
        if path.exists() and valid(path.read_bytes(), asset['size'], asset['sha256']):
            continue
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
                # Read only the fixed member; never extract archive paths to disk.
                data = archive.read(asset['file'])
        if not valid(data, asset['size'], asset['sha256']):
            raise ValueError(f"{asset['file']}: extracted font mismatch; resources unchanged")
        pending[path] = data
    DEST.mkdir(parents=True, exist_ok=True)
    for path, data in pending.items():
        temporary = path.with_suffix(path.suffix + '.download')
        temporary.write_bytes(data)
        temporary.replace(path)
    manifest = {'alias': 'Sumi Typewriter', 'families': ['Special Elite', 'Zhuque Fangsong (technical preview)', 'Source Han Serif SC'], 'assets': ASSETS}
    (DEST / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    print('Sumi Typewriter: three pinned fonts and their licenses verified')


if __name__ == '__main__':
    prepare()
