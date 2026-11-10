#!/usr/bin/env python3
"""Generate an unsubmitted recipe from verified assets of an explicit published tag."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile

REPO = 'wizlijun/note.md'
TEMPLATE = Path(__file__).with_name('notemd')


def validate_version(value):
    if not re.fullmatch(r'[0-9]+(?:\.[0-9]+)*', value):
        raise ValueError('version must be numeric, without the v prefix')
    return value


def prepare(release, version, downloads, output, *, amd64_only=False):
    validate_version(version)
    architectures = ('amd64',) if amd64_only else ('amd64', 'arm64')
    names = [f'note.md_{version}_{arch}.deb' for arch in architectures]
    required = set(names + ['SHA256SUMS-linux.txt'])
    if (release.get('tagName') != 'v' + version or release.get('isDraft') is not False
            or release.get('isPrerelease') is not False):
        raise ValueError('requires the exact published, non-prerelease tag')
    if not required.issubset({asset['name'] for asset in release['assets']}):
        raise ValueError('release is missing required Linux assets')
    checksums = {}
    for line in (downloads / 'SHA256SUMS-linux.txt').read_text().splitlines():
        match = re.fullmatch(r'([0-9a-fA-F]{64})  (.+)', line)
        if not match or match[2] not in names or match[2] in checksums:
            raise ValueError('invalid, duplicate or unexpected checksum entry')
        checksums[match[2]] = match[1].lower()
    if set(checksums) != set(names):
        raise ValueError('checksum manifest must contain exactly the selected debs')
    for name in names:
        data = (downloads / name).read_bytes()
        if hashlib.sha256(data).hexdigest() != checksums[name]:
            raise ValueError(f'checksum mismatch: {name}')
        if not data.startswith(b'!<arch>\n'):
            raise ValueError(f'not a Debian ar archive: {name}')
    recipe = (TEMPLATE / 'PKGBUILD').read_text()
    start = recipe.index('pkgver=UNPREPARED')
    end = recipe.index('pkgrel=', start)
    recipe = recipe[:start] + f'pkgver={version}\n' + recipe[end:]
    if amd64_only:
        recipe = recipe.replace("arch=('x86_64' 'aarch64')", "arch=('x86_64')")
        recipe = recipe.replace('noextract=("${_deb_x86_64}" "${_deb_aarch64}")', 'noextract=("${_deb_x86_64}")')
        recipe = ''.join(line for line in recipe.splitlines(keepends=True)
                         if not line.startswith(('_deb_aarch64=', 'source_aarch64=', 'sha256sums_aarch64=')))
    for arch, name in zip(('x86_64', 'aarch64'), names):
        recipe = recipe.replace(f'sha256sums_{arch}=()', f"sha256sums_{arch}=('{checksums[name]}')")
    # Do not create a usable output until every downloaded asset has passed validation.
    output.mkdir(parents=True, exist_ok=True)
    (output / '.omarchy').mkdir(exist_ok=True)
    (output / 'PKGBUILD').write_text(recipe)
    (output / '.omarchy/package.json').write_bytes((TEMPLATE / '.omarchy/package.json').read_bytes())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('version', type=validate_version, help='explicit published version, without v')
    parser.add_argument('--output', type=Path, required=True, help='new downstream recipe directory')
    parser.add_argument('--amd64-only', action='store_true', help='explicit x86_64-only release; default requires both architectures')
    args = parser.parse_args()
    if args.output.exists():
        parser.error('output already exists; choose a new directory')
    tag = 'v' + args.version
    release = json.loads(subprocess.check_output([
        'gh', 'release', 'view', tag, '--repo', REPO, '--json', 'tagName,isDraft,isPrerelease,assets'], text=True))
    # Fail before downloading unpublished tags or incomplete releases.
    architectures = ('amd64',) if args.amd64_only else ('amd64', 'arm64')
    required = [f'note.md_{args.version}_{arch}.deb' for arch in architectures] + ['SHA256SUMS-linux.txt']
    if (release.get('tagName') != tag or release.get('isDraft') is not False
            or release.get('isPrerelease') is not False
            or not set(required).issubset({asset['name'] for asset in release['assets']})):
        parser.error('requires a published stable release with the selected debs and SHA256SUMS-linux.txt')
    with tempfile.TemporaryDirectory(prefix='notemd-omarchy-') as temp:
        command = ['gh', 'release', 'download', tag, '--repo', REPO, '--dir', temp]
        for name in required:
            command.extend(['--pattern', name])
        subprocess.run(command, check=True)
        prepare(release, args.version, Path(temp), args.output, amd64_only=args.amd64_only)
    print(f'Verified {", ".join(architectures)} debs; unsubmitted recipe written to {args.output}')


if __name__ == '__main__':
    main()
