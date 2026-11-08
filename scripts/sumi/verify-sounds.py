#!/usr/bin/env python3
"""Validate Sumi's two supplied WAV packs; optionally require exact source bytes.
Read-only: no downloading, conversion, signing or publication.
"""
import argparse
import hashlib
import io
import json
from pathlib import Path
import wave

ROLES = {
    'typewriter': {'key': 'keys', 'space': 'space', 'enter': 'enter2', 'delete': 'delete', 'modifier': 'modifier', 'keyUp': None, 'spaceUp': None, 'click': None},
    'thock': {'key': 'keys', 'space': 'space', 'enter': 'enter', 'delete': 'delete', 'modifier': 'modifier', 'keyUp': 'release', 'spaceUp': 'release', 'click': 'click'},
}
METADATA = {'manifest.json', 'provenance.json'}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def expected_roles():
    return {pack: {role: [f'{pack}/{pack}-{sample}-1.wav'] if sample else [] for role, sample in roles.items()} for pack, roles in ROLES.items()}


def validate(root):
    root = Path(root)
    require(root.is_dir() and not root.is_symlink(), 'Missing or unsafe sounds directory')
    roles = expected_roles()
    expected = {name for values in roles.values() for names in values.values() for name in names}
    files = {}
    for path in root.rglob('*'):
        require(not path.is_symlink(), 'Sound resource symlink rejected')
        name = path.relative_to(root).as_posix()
        if path.is_dir():
            require(name in ROLES, 'Unexpected sound resource directory: ' + name)
        else:
            require(path.is_file(), 'Non-regular sound resource: ' + name)
            require(name in expected | METADATA, 'Unexpected sound resource: ' + name)
            require(path.stat().st_size <= 1024 * 1024, 'Oversized sound resource: ' + name)
            files[name] = path.read_bytes()
    require(set(files) == expected | METADATA, 'Sound resource inventory differs')
    manifest = json.loads(files['manifest.json'])
    require(manifest.get('schema') == 1, 'Unsupported sound catalog schema')
    require(manifest.get('packs') == [{'id': pack, 'roles': values} for pack, values in roles.items()], 'Sound pack roles differ')
    assets = manifest.get('assets', [])
    require(len(assets) == len(expected) and {a['file'] for a in assets} == expected, 'Sound asset inventory differs')
    for asset in assets:
        name = asset['file']
        raw = files[name]
        require(len(raw) == asset['size'] and hashlib.sha256(raw).hexdigest() == asset['sha256'], 'Sound asset digest differs: ' + name)
        with wave.open(io.BytesIO(raw), 'rb') as audio:
            frames = audio.getnframes()
            require(audio.getcomptype() == 'NONE' and audio.getnchannels() == 1 and audio.getsampwidth() == 2 and audio.getframerate() == 48000, 'Expected mono 48 kHz PCM16 WAV: ' + name)
            require(0 < frames <= 48000 and len(audio.readframes(frames)) == frames * 2, 'Incomplete or oversized WAV frames: ' + name)
            for field, value in {'format': 'pcm_s16le', 'sample_rate': 48000, 'channels': 1, 'bits_per_sample': 16, 'frame_count': frames}.items():
                require(asset.get(field) == value, 'Sound format metadata differs: ' + name + '/' + field)
    provenance = json.loads(files['provenance.json'])
    require(provenance.get('schema') == 1 and provenance.get('source_kind') == 'user_supplied', 'Sound provenance identity differs')
    require(isinstance(provenance.get('license_status'), str) and provenance['license_status'], 'Sound provenance license statement missing')
    expected_provenance = [{'file': a['file'], 'source_relative_path': a['file'], 'size': a['size'], 'sha256': a['sha256']} for a in assets]
    require(provenance.get('assets') == expected_provenance, 'Sound provenance assets differ')
    return files


def compare(root, reference=None):
    files = validate(root)
    if reference is not None:
        require(files == validate(reference), 'Prepared sound bytes differ from source')
    return {'ok': True, 'packs': list(ROLES), 'wavFiles': len(files) - len(METADATA), 'audioBytes': sum(len(raw) for name, raw in files.items() if name.endswith('.wav')), 'exactReferenceBytes': reference is not None}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', type=Path)
    parser.add_argument('--reference', type=Path)
    args = parser.parse_args()
    print(json.dumps(compare(args.root, args.reference), indent=2))


if __name__ == '__main__':
    main()
