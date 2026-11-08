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
GOOGLE = 'https://raw.githubusercontent.com/google/fonts/03c54f8f0fae0c403c43f326068d9060121c9bd1/ofl/courierprime/'
ADOBE = 'https://raw.githubusercontent.com/adobe-fonts/source-han-serif/2.003R/'
ASSETS = [
    dict(file='CourierPrime-Regular.ttf', url=GOOGLE + 'CourierPrime-Regular.ttf', size=71188, sha256='72f793376f8e2841656bf21d77a5de010f2929bd6956a22ee848ad0c7eb978af'),
    dict(file='CourierPrime-OFL.txt', url=GOOGLE + 'OFL.txt', size=4403, sha256='9a755af092b494944c99f471be6fddd19b006a448fefdc4717e4ee0aa09a97b0'),
    dict(file='ZhuqueFangsong-Regular.ttf', url='https://github.com/TrionesType/zhuque/releases/download/v0.212/ZhuqueFangsong-v0.212.zip', size=8824084, sha256='558c62730844fe54ba220146ed62f859d4e2880188d92d985f8921c6e3743bc4', archive_size=5743932, archive_sha256='bb8b661a7643d2296a72d9d10530a00949419c4e527fb61783f73c2ba1a8c062'),
    dict(file='ZhuqueFangsong-LICENSE.txt', url='https://raw.githubusercontent.com/TrionesType/zhuque/v0.212/LICENSE.txt', size=4389, sha256='66cc01ad4df62fca6936431a426104cb32a52ce8da49de9a7d643e02d7659043'),
    dict(file='SourceHanSerifSC-Regular.otf', url=ADOBE + 'OTF/SimplifiedChinese/SourceHanSerifSC-Regular.otf', size=24543332, sha256='78aa7a328fd974df2d688c8a9fd74a33d8334dfa84ab24d9d11efb2ffc464117'),
    dict(file='OFL.txt', url=ADOBE + 'LICENSE.txt', size=4463, sha256='9ff5bb567e1b92c801fc1069e5fbf992ff8efccacb9db94e5959a5b3ba9bb903'),
    {'file': 'IBMPlexMono-Light.ttf', 'size': 135216, 'sha256': '780bcf65509d72a35ec114b57bcbe220dc6b77d8ea2e9b25e294be3c570c5025', 'postscript': 'IBMPlexMono-Light', 'license': 'OFL-1.1', 'url': 'https://raw.githubusercontent.com/google/fonts/03c54f8f0fae0c403c43f326068d9060121c9bd1/ofl/ibmplexmono/IBMPlexMono-Light.ttf'},
    {'file': 'IBMPlexMono-OFL.txt', 'size': 4456, 'sha256': '7e6b2818edbd8f6a01ae80641cc8f16a51080d08fb4e532be3a0b6f74adb07da', 'url': 'https://raw.githubusercontent.com/google/fonts/03c54f8f0fae0c403c43f326068d9060121c9bd1/ofl/ibmplexmono/OFL.txt'},
    {'file': 'IBMPlexSansSC-Light.otf', 'size': 7084864, 'sha256': '1df4e4de4f669c593c56b6a55e89c451ed2ef64c2669c068ea44ba6f7b24819c', 'postscript': 'IBMPlexSansSC-Light', 'license': 'OFL-1.1', 'url': 'https://raw.githubusercontent.com/IBM/plex/222657a016f31e6d913ede88520de7dec84dc81b/packages/plex-sans-sc/fonts/complete/otf/hinted/IBMPlexSansSC-Light.otf'},
    {'file': 'IBMPlexSansSC-LICENSE.txt', 'size': 4456, 'sha256': '7e6b2818edbd8f6a01ae80641cc8f16a51080d08fb4e532be3a0b6f74adb07da', 'url': 'https://raw.githubusercontent.com/IBM/plex/222657a016f31e6d913ede88520de7dec84dc81b/packages/plex-sans-sc/LICENSE.txt'},
    {'file': 'LXGWWenKaiMonoLite-Regular.ttf', 'size': 13977916, 'sha256': 'fcdac2729fab750009af0046b23c5bb6f3a351658adb76ef6f28fdf57037d1c2', 'postscript': 'LXGWWenKaiMonoLite-Regular', 'license': 'OFL-1.1', 'url': 'https://github.com/lxgw/LxgwWenKai-Lite/releases/download/v1.530/LXGWWenKaiMonoLite-Regular.ttf'},
    {'file': 'LXGWWenKaiMonoLite-OFL.txt', 'size': 5176, 'sha256': '0333a85fe077b6849f8e417acc44e8bd879442ceb681e271acf93e2d57fd4e2e', 'url': 'https://raw.githubusercontent.com/lxgw/LxgwWenKai-Lite/v1.530/OFL.txt'},
    {'file': 'SpecialElite-Regular.ttf', 'size': 166180, 'sha256': 'a776fcb4ceb8bdf03e2967688ebdad42680de5b91a7e62c17e718ae212d14bc4', 'postscript': 'SpecialElite-Regular', 'license': 'Apache-2.0', 'url': 'https://raw.githubusercontent.com/google/fonts/03c54f8f0fae0c403c43f326068d9060121c9bd1/apache/specialelite/SpecialElite-Regular.ttf'},
    {'file': 'SpecialElite-LICENSE.txt', 'size': 11358, 'sha256': 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30', 'url': 'https://raw.githubusercontent.com/google/fonts/03c54f8f0fae0c403c43f326068d9060121c9bd1/apache/specialelite/LICENSE.txt'},
    {'file': 'YouyouYisong.ttf', 'size': 29365160, 'sha256': '021a6e2fb95a2216da6344bc2ad6ffdff65362882a55b083ac48ddb27f8aab99', 'postscript': 'youyou-yisong', 'license': 'LicenseRef-Embedded-Public-Domain', 'url': 'https://raw.githubusercontent.com/zispace/hanzi-fonts-ext/1a1cafe893fbfec448c263fbcbbd4737a79c5dee/%E6%9C%AA%E7%9F%A5%E6%9D%A5%E4%BF%A1-%E5%8F%88%E5%8F%88%E6%84%8F%E5%AE%8B/%E5%8F%88%E5%8F%88%E6%84%8F%E5%AE%8B.ttf'},
    {'file': 'YouyouYisong-PROVENANCE.json', 'size': 3822, 'sha256': '7da08373d074182c264be7b66686e8204757781bfecd0ce28f656f1c8b95bdf8', 'bundled': True},
    {'file': 'YouyouYisong-NOTICE.txt', 'size': 775, 'sha256': '5c03bb8bc3bbbbe05976c99f29eafbf6a4147b0656bc275fd2da75f0d8d1c3da', 'bundled': True},
]


def valid(data, size, sha256):
    return len(data) == size and hashlib.sha256(data).hexdigest() == sha256


CASCADES = {'Sumi Typewriter': ['Courier Prime', 'Zhuque Fangsong (technical preview)', 'Source Han Serif SC'], 'Sumi Plex': ['IBMPlexMono-Light', 'IBMPlexSansSC-Light', 'SourceHanSerifSC-Regular'], 'Sumi WenKai': ['LXGWWenKaiMonoLite-Regular', 'SourceHanSerifSC-Regular'], 'Sumi Elite': ['SpecialElite-Regular', 'youyou-yisong', 'SourceHanSerifSC-Regular']}


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
    manifest = {'alias': 'Sumi Typewriter', 'families': CASCADES['Sumi Typewriter'], 'cascades': CASCADES, 'assets': ASSETS}
    (DEST / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    print('Sumi: three selected cascades and legacy Typewriter fonts, licenses and provenance verified')


if __name__ == '__main__':
    prepare()
