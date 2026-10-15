"""Behavior tests use real archive bytes and SHA256, with no network/publication."""
import hashlib
import importlib.util
import io
import tarfile
import tempfile
import subprocess
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('prepare', Path(__file__).with_name('prepare.py'))
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)


class PrepareTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.version = '6.1231.2'
        self.names = [f'note.md_{self.version}_{arch}.deb' for arch in ('amd64', 'arm64')]
        # Build small but real Debian ar archives with control/data tar members.
        for arch, name in zip(('amd64', 'arm64'), self.names):
            members = [('debian-binary', b'2.0\n')]
            for member, filename, content in (
                ('control.tar.gz', 'control', f'Package: note-md\nVersion: {self.version}\nArchitecture: {arch}\n'.encode()),
                ('data.tar.gz', 'usr/share/doc/note.md/copyright', b'Apache-2.0\n')):
                buffer = io.BytesIO()
                with tarfile.open(fileobj=buffer, mode='w:gz') as archive:
                    entry = tarfile.TarInfo(filename)
                    entry.size = len(content)
                    archive.addfile(entry, io.BytesIO(content))
                members.append((member, buffer.getvalue()))
            data = b'!<arch>\n'
            for member, payload in members:
                header = f'{member + "/":<16}{0:<12}{0:<6}{0:<6}{"100644":<8}{len(payload):<10}`\n'.encode()
                data += header + payload + (b'\n' if len(payload) % 2 else b'')
            (self.root / name).write_bytes(data)
        self.write_sums()
        self.release = {'tagName': 'v' + self.version, 'isDraft': False, 'isPrerelease': False,
                        'assets': [{'name': name} for name in self.names + ['SHA256SUMS-linux.txt']]}
        self.output = self.root / 'output'

    def write_sums(self):
        (self.root / 'SHA256SUMS-linux.txt').write_text(''.join(
            hashlib.sha256((self.root / name).read_bytes()).hexdigest() + '  ' + name + '\n'
            for name in self.names))

    def run_prepare(self):
        return prepare.prepare(self.release, self.version, self.root, self.output)

    def test_exact_checksums_and_deterministic_recipe(self):
        self.run_prepare()
        recipe = (self.output / 'PKGBUILD').read_text()
        self.assertIn('pkgver=' + self.version, recipe)
        self.assertNotIn('UNPREPARED', recipe)
        subprocess.run(['bash', '-n', str(self.output / 'PKGBUILD')], check=True)
        subprocess.run(['bash', '-c', 'source "$1"; [[ ${#sha256sums_x86_64[@]} == 1 && ${#sha256sums_aarch64[@]} == 1 ]]', 'recipe-check', str(self.output / 'PKGBUILD')], check=True)
        for name in self.names:
            self.assertIn(hashlib.sha256((self.root / name).read_bytes()).hexdigest(), recipe)
        self.run_prepare()
        self.assertEqual(recipe, (self.output / 'PKGBUILD').read_text())
        self.assertEqual((self.output / '.omarchy/package.json').read_bytes(),
                         Path(__file__).with_name('notemd').joinpath('.omarchy/package.json').read_bytes())

    def test_tampered_download_creates_no_recipe(self):
        (self.root / self.names[1]).write_bytes(b'!<arch>\nchanged')
        with self.assertRaisesRegex(ValueError, 'checksum'):
            self.run_prepare()
        self.assertFalse(self.output.exists())

    def test_missing_duplicate_or_extra_checksum_rejected(self):
        sums = self.root / 'SHA256SUMS-linux.txt'
        original = sums.read_text()
        for bad in (original.splitlines()[0] + '\n', original + original.splitlines()[0] + '\n',
                    original + '0' * 64 + '  unrelated.deb\n'):
            sums.write_text(bad)
            with self.assertRaises(ValueError):
                self.run_prepare()
            self.assertFalse(self.output.exists())

    def test_unpublished_release_missing_arch_or_wrong_tag_rejected(self):
        for key, value in [('isDraft', True), ('isPrerelease', True), ('tagName', 'v1.0.0'),
                           ('assets', [{'name': self.names[0]}])]:
            original = self.release[key]
            self.release[key] = value
            with self.assertRaises(ValueError):
                self.run_prepare()
            self.assertFalse(self.output.exists())
            self.release[key] = original

    def test_checksum_of_html_is_not_a_deb(self):
        (self.root / self.names[0]).write_text('<html>not a deb</html>')
        self.write_sums()
        with self.assertRaisesRegex(ValueError, 'archive'):
            self.run_prepare()
        self.assertFalse(self.output.exists())

    def test_invalid_version_rejected_before_io(self):
        for value in ('v6.1231.2', '../1', '1;id', '1.0-beta'):
            with self.assertRaises(ValueError):
                prepare.validate_version(value)


if __name__ == '__main__':
    unittest.main()
