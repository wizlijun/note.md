"""Exercise the tracked preparation script in a synthetic checkout/home only."""
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parent


class PreparationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='sumi-prepare-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve() / 'checkout'
        self.scripts = self.root / 'scripts/sumi/acceptance'
        shutil.copytree(SOURCE, self.scripts, ignore=shutil.ignore_patterns('__pycache__'))
        self.home = Path(self.temp.name).resolve() / 'home'
        self.home.mkdir()
        self.work = self.root / 'tasks/sumi-native/host-acceptance'
        self.plugin = self.root / 'plugins-src/write'
        (self.plugin / 'dist').mkdir(parents=True)
        (self.plugin / 'dist/index.html').write_text('production main')
        self.manifest = {'id': 'notemd.sumi', 'version': '0.1.0', 'capabilities': ['vault.read'],
                         'activation': {'events': ['onCommand:open']},
                         'contributes': {'windows': [{'id': 'main', 'entry': 'index.html'}], 'menus': []}}
        (self.plugin / 'manifest.v2.json').write_text(json.dumps(self.manifest))
        self.benchmark = Path(self.temp.name) / 'benchmark'

    def run_prepare(self, *args):
        return subprocess.run(['python3', str(self.scripts / 'prepare.py'), '--benchmark-dir', str(self.benchmark), *args],
                              env={**os.environ, 'HOME': str(self.home)}, text=True, capture_output=True)

    def test_paths_config_and_reinstall_preserve_user_state(self):
        result = self.run_prepare('--install')
        self.assertEqual(result.returncode, 0, result.stderr)
        support = self.home / 'Library/Application Support/net.notemd.sumi.acceptance'
        vault = self.work / 'vault'
        self.assertEqual(json.loads((support / 'shared.json').read_text())['sotvault'], str(vault))
        self.assertEqual((vault / '.sumi-acceptance-vault').read_text(), 'sumi-acceptance-only\n')
        config = json.loads((self.work / 'tauri.acceptance.json').read_text())
        self.assertEqual(config['bundle']['macOS']['infoPlist'], str(self.scripts / 'Info.plist'))
        self.assertEqual(plistlib.loads(Path(config['bundle']['macOS']['infoPlist']).read_bytes())['CFBundleDocumentTypes'], [])
        draft = vault / 'inbox/writings/keep.writing.md'
        draft.write_text('do not reset')
        database = support / 'sumi.sqlite'
        database.write_bytes(b'preserve existing database')
        settings = support / 'settings.json'
        settings.write_text('{"custom":true}')
        self.assertEqual(self.run_prepare('--install').returncode, 0)
        self.assertEqual(draft.read_text(), 'do not reset')
        self.assertEqual(database.read_bytes(), b'preserve existing database')
        self.assertEqual(settings.read_text(), '{"custom":true}')

    def test_benchmark_only_adds_isolated_window_and_checks_artifacts(self):
        (self.benchmark / 'web').mkdir(parents=True)
        (self.benchmark / 'web/index.html').write_text('benchmark')
        (self.benchmark / 'corpus').mkdir()
        (self.benchmark / 'corpus/10000.json').write_text('{}')
        digest = hashlib.sha256(b'benchmark').hexdigest()
        (self.benchmark / 'identity.json').write_text(json.dumps({'artifacts': {'index.html': digest}}))
        fonts = self.root / 'src-tauri/resources/sumi'
        fonts.mkdir(parents=True)
        (fonts / 'font.ttf').write_bytes(b'font fixture')
        metadata = self.plugin / 'resources/sumi'
        metadata.mkdir(parents=True)
        (metadata / 'manifest.json').write_text(json.dumps({'assets': [{'file': 'font.ttf', 'postscript': 'Fixture', 'sha256': hashlib.sha256(b'font fixture').hexdigest()}]}))
        result = self.run_prepare()
        self.assertEqual(result.returncode, 0, result.stderr)
        current = self.work / 'seed/plugins/notemd.sumi/current'
        seeded = json.loads((current / 'manifest.json').read_text())
        self.assertEqual(seeded['contributes']['windows'][0], self.manifest['contributes']['windows'][0])
        self.assertEqual(seeded['contributes']['windows'][1]['entry'], 'benchmark/index.html')
        self.assertEqual(seeded['capabilities'], self.manifest['capabilities'])
        self.assertEqual(json.loads((self.plugin / 'manifest.v2.json').read_text()), self.manifest)
        self.assertTrue((current / 'ui/benchmark/corpus/10000.json').is_file())
        self.assertTrue((current / 'ui/benchmark/fonts/font.ttf').is_file())
        (self.benchmark / 'web/index.html').write_text('changed')
        rejected = self.run_prepare()
        self.assertNotEqual(rejected.returncode, 0)
        self.assertIn('Benchmark artifact changed', rejected.stderr)

    def test_native_backend_is_explicit_and_hash_bound(self):
        self.manifest['binary'] = {'aarch64-apple-darwin': 'bin/notemd-sumi'}
        (self.plugin / 'manifest.v2.json').write_text(json.dumps(self.manifest))
        result = self.run_prepare()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Explicit isolated backend', result.stderr)
        binary = self.root / 'isolated-backend'
        binary.write_bytes(b'isolated native fixture')
        options = ['--backend-binary', str(binary), '--backend-sha256', hashlib.sha256(binary.read_bytes()).hexdigest()]
        result = self.run_prepare(*options)
        self.assertEqual(result.returncode, 0, result.stderr)
        staged = self.work / 'seed/plugins/notemd.sumi/current/bin/notemd-sumi'
        self.assertEqual(staged.read_bytes(), binary.read_bytes())
        self.assertTrue(staged.stat().st_mode & 0o100)
        binary.write_bytes(b'changed')
        rejected = self.run_prepare(*options)
        self.assertNotEqual(rejected.returncode, 0)
        self.assertIn('backend hash mismatch', rejected.stderr)

    def test_refuses_symlink_work_directory(self):
        self.work.parent.mkdir(parents=True)
        self.work.symlink_to(self.home, target_is_directory=True)
        result = self.run_prepare()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Refusing symbolic link', result.stderr)
        self.assertFalse((self.home / 'vault').exists())


if __name__ == '__main__':
    unittest.main()
