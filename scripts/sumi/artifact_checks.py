"""Shared read-only artifact checks extracted verbatim from
 tasks/diagram-transparent-release-20261107/verify-candidate.py.
The DMG helper additionally accepts a resource-check callback on its own mount.
"""
import hashlib
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import tarfile
import tempfile
EXPECTED_BUNDLE_ID = 'net.notemd.app'

def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def verify_app_identity(plist, version):
    require(plist.get('CFBundleIdentifier') == EXPECTED_BUNDLE_ID, 'candidate app identifier must be net.notemd.app')
    require(plist.get('CFBundleShortVersionString') == version, 'candidate app version mismatch')
    require(plist.get('CFBundleExecutable') == 'notemd', 'candidate app executable mismatch')


def verify_archive_identity(archive, version):
    with tarfile.open(archive, 'r:gz') as bundle:
        members = [m for m in bundle.getmembers() if m.name.removeprefix('./') == 'note.md.app/Contents/Info.plist']
        require(len(members) == 1 and members[0].isfile() and 0 < members[0].size <= 1024 * 1024, 'updater must contain one bounded regular Info.plist')
        source = bundle.extractfile(members[0])
        require(source is not None, 'updater Info.plist cannot be read')
        with source:
            plist = plistlib.loads(source.read())
    verify_app_identity(plist, version)
    return {key: plist[key] for key in ['CFBundleIdentifier', 'CFBundleShortVersionString', 'CFBundleExecutable']}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def file_info(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return {'path': str(path), 'bytes': path.stat().st_size, 'sha256': digest.hexdigest()}


def unpack_binary(archive, relative, destination):
    with tarfile.open(archive, 'r:gz') as bundle:
        members = [m for m in bundle.getmembers() if m.name.removeprefix('./') == relative]
        require(len(members) == 1 and members[0].isfile(), 'updater must contain exactly one regular Mach-O member')
        source = bundle.extractfile(members[0])
        require(source is not None, 'updater Mach-O cannot be read')
        with source, destination.open('wb') as output:
            shutil.copyfileobj(source, output)
        require(destination.stat().st_size == members[0].size, 'truncated updater Mach-O')


def check_command(report, args):
    result = subprocess.run(args, text=True, capture_output=True, timeout=120)
    report.setdefault('commands', []).append({'argv': args, 'exit': result.returncode, 'stdout': result.stdout.strip(), 'stderr': result.stderr.strip()})
    require(result.returncode == 0, f'candidate check failed: {args[0]} ({result.returncode})')
    return result.stdout.strip()


def verify_dmg_binary(report, dmg, expected_sha256, version, verify_resources=None):
    # The mountpoint is created empty for this one invocation. Detach only the
    # device explicitly returned by this attach for that exact mountpoint.
    temporary = Path(tempfile.mkdtemp(prefix='notemd-diagram-transparent-dmg-'))
    mountpoint = temporary / 'mount'
    mountpoint.mkdir()
    device = None
    try:
        command = ['/usr/bin/hdiutil', 'attach', '-readonly', '-nobrowse', '-plist', '-mountpoint', str(mountpoint), str(dmg)]
        result = subprocess.run(command, text=True, capture_output=True, timeout=120)
        report.setdefault('commands', []).append({'argv': command, 'exit': result.returncode, 'stdout': result.stdout.strip(), 'stderr': result.stderr.strip()})
        try:
            entities = plistlib.loads(result.stdout.encode()).get('system-entities', [])
        except (ValueError, plistlib.InvalidFileException):
            entities = []
        matches = [entry for entry in entities if entry.get('mount-point') and Path(entry['mount-point']).resolve() == mountpoint.resolve()]
        if len(matches) == 1 and re.fullmatch(r'/dev/disk[0-9]+(?:s[0-9]+)*', matches[0].get('dev-entry', '')):
            device = matches[0]['dev-entry']
        require(result.returncode == 0 and device is not None, 'DMG readonly attach did not confirm our exact mountpoint/device')
        app = mountpoint / 'note.md.app'
        plist = plistlib.loads((app / 'Contents/Info.plist').read_bytes())
        verify_app_identity(plist, version)
        if verify_resources is not None:
            verify_resources(app)
        binary = app / 'Contents/MacOS/notemd'
        info = file_info(binary)
        require(info['sha256'] == expected_sha256, 'DMG Mach-O differs from verified app and updater')
        check_command(report, ['/usr/bin/codesign', '--verify', '--deep', '--strict', '--verbose=2', str(app)])
        report['dmg'].update({'mach_o_sha256': info['sha256'], 'mach_o_bytes': info['bytes'], 'app_version': version, 'app_identifier': plist['CFBundleIdentifier'], 'candidate_and_updater_byte_identical': True, 'mount_readonly': True})
    finally:
        if device is not None:
            # A failed detach preserves the path for inspection; never remove a
            # mounted directory or use an unrelated pre-existing volume name.
            check_command(report, ['/usr/bin/hdiutil', 'detach', device])
            report.setdefault('dmg', {})['detached_device'] = device
        if not mountpoint.is_mount() and mountpoint.exists() and not any(mountpoint.iterdir()):
            mountpoint.rmdir()
            temporary.rmdir()
        else:
            report['dmg_mount_preserved_for_inspection'] = str(mountpoint)
