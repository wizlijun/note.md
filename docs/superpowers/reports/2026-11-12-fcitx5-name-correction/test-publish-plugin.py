import copy
import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('publisher', Path(__file__).with_name('publish-plugin.py'))
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


def entry():
    return dict(id='notemd.sumi', version='0.1.16', min_host='>=6.1111.1', category='create',
                archs=p.prepare.ARCHS[:], size=30, name='Sumi Write',
                sha256={a: 'a' * 64 for a in p.prepare.ARCHS},
                download={a: p.download(dict(id='notemd.sumi', version='0.1.16', arch=a)) for a in p.prepare.ARCHS})


class AppendOnlyTests(unittest.TestCase):
    def setUp(self):
        self.live = {'schema': 7, 'unknown': {'preserve': True}, 'plugins': [
            dict(id='notemd.sumi', version='0.1.15', archs=p.prepare.ARCHS[:],
                 sha256={'arm': 'original', 'linux': 'original'}, category='create'),
            dict(id='other', version='1.0.0', category='inspiration', unknown=[1, 2]),
        ]}

    def test_append_preserves_every_old_field_and_does_not_mutate_inputs(self):
        original = copy.deepcopy(self.live)
        result = p.merge_entries(self.live, [entry()])
        self.assertEqual(result, {**original, 'plugins': original['plugins'] + [entry()]})
        self.assertEqual(self.live, original)
        result['plugins'][0]['sha256']['linux'] = 'changed'
        self.assertEqual(self.live, original)

    def test_idempotent_exact_same_version(self):
        once = p.merge_entries(self.live, [entry()])
        self.assertEqual(p.merge_entries(once, [entry()]), once)

    def test_every_occupied_field_conflict_fails(self):
        for field, value in [('name', 'wrong'), ('size', 1), ('sha256', {'arm': 'wrong'}),
                             ('category', 'reading'), ('i18n', {'en': {'name': 'changed'}})]:
            occupied = entry()
            occupied[field] = value
            with self.subTest(field=field), self.assertRaises(RuntimeError):
                p.merge_entries({**self.live, 'plugins': self.live['plugins'] + [occupied]}, [entry()])

    def test_scope_minimum_host_and_architecture_cannot_drift(self):
        for field, value in [('id', 'other'), ('version', '0.1.15'), ('min_host', '>=0'),
                             ('category', 'reading'), ('archs', [p.prepare.ARCHS[0]]),
                             ('sha256', {}), ('download', {})]:
            candidate = entry()
            candidate[field] = value
            with self.subTest(field=field), self.assertRaises(RuntimeError):
                p.merge_entries(self.live, [candidate])

    def test_wrong_download_destination_fails(self):
        candidate = entry()
        candidate['download'][p.prepare.ARCHS[0]] = 'https://example.invalid/package'
        with self.assertRaises(RuntimeError):
            p.merge_entries(self.live, [candidate])

    def test_duplicate_old_identity_and_multiple_new_entries_fail(self):
        with self.assertRaises(RuntimeError):
            p.merge_entries({**self.live, 'plugins': self.live['plugins'] * 2}, [entry()])
        with self.assertRaises(RuntimeError):
            p.merge_entries(self.live, [entry(), entry()])


class PublicationBoundaries(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.rows = []
        for arch in p.prepare.ARCHS:
            package = self.root / (arch + '.notemdpkg')
            package.write_bytes(('package-' + arch).encode())
            Path(str(package) + '.minisig').write_bytes(('sig-' + arch).encode())
            self.rows.append(dict(id='notemd.sumi', version='0.1.16', arch=arch, packagePath=str(package)))
        self.patches = [patch.object(p, 'ROWS', self.rows), patch.object(p, 'PUBLIC', self.root / 'public')]
        for item in self.patches:
            item.start()

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        self.temp.cleanup()

    def test_last_signature_conflict_prevents_all_r2_writes(self):
        calls = []

        def fetch(url, destination):
            calls.append(url)
            if len(calls) < 4:
                destination.write_bytes(b'not found')
                return 404
            destination.write_bytes(b'occupied conflicting signature')
            return 200

        with patch.object(p, 'fetch', side_effect=fetch), patch.object(p, 'wrangler') as wrangler, \
                patch.object(p, 'save'):
            with self.assertRaises(RuntimeError):
                p.stage()
            wrangler.assert_not_called()

    def test_uncertain_network_state_cannot_be_treated_as_absence(self):
        with patch.object(p, 'fetch', return_value=503), patch.object(p, 'wrangler') as wrangler:
            with self.assertRaises(RuntimeError):
                p.stage()
            wrangler.assert_not_called()

    def test_identical_objects_are_not_reuploaded(self):
        def fetch(url, destination):
            arch = next(a for a in p.prepare.ARCHS if a in url)
            suffix = '.minisig' if '.minisig' in url else ''
            destination.write_bytes((self.root / (arch + '.notemdpkg' + suffix)).read_bytes())
            return 200

        with patch.object(p, 'fetch', side_effect=fetch), patch.object(p, 'wrangler') as wrangler, \
                patch.object(p, 'save'), patch.object(p, 'verify_public_packages') as verify:
            p.stage()
            wrangler.assert_not_called()
            verify.assert_called_once()

    def test_concurrent_index_change_stops_before_kv_write(self):
        before = {'plugins': []}
        changed = {'plugins': [dict(id='other', version='1')]}
        with patch.object(p, 'require_public_host'), patch.object(p, 'verify_public_packages'), \
                patch.object(p, 'read_kv', side_effect=[before, changed]), patch.object(p, 'save'), \
                patch.object(p, 'wrangler') as wrangler:
            with self.assertRaises(RuntimeError):
                p.publish_index([entry()])
            wrangler.assert_not_called()

    def test_unfrozen_candidate_cannot_reach_online_commands(self):
        with patch.object(p.prepare, 'check_candidate', side_effect=FileNotFoundError('no freeze')), \
                patch.object(p, 'fetch') as fetch, patch.object(p, 'wrangler') as wrangler:
            with self.assertRaises(FileNotFoundError):
                p.load_frozen('a' * 40)
            fetch.assert_not_called()
            wrangler.assert_not_called()

    def test_bad_or_missing_source_fails_before_credentials(self):
        for source in [None, 'HEAD', 'shortsha']:
            with self.subTest(source=source), patch.object(p, 'env') as env:
                with self.assertRaises(RuntimeError):
                    p.load_frozen(source)
                env.assert_not_called()


class RealCandidateChecks(unittest.TestCase):
    def test_signed_candidate_checks_offline_and_does_not_claim_a_source(self):
        with patch.object(p, 'fetch') as fetch, patch.object(p, 'wrangler') as wrangler:
            candidate = p.prepare.check_candidate()
            self.assertIsNone(candidate['sourceCommit'])
            self.assertEqual(len(candidate['packages']), 2)
            fetch.assert_not_called()
            wrangler.assert_not_called()

    def test_existing_head_cannot_be_mislabelled_as_dirty_build_source(self):
        head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=p.ROOT, text=True).strip()
        # At preparation time .16 and its spelling correction are not committed.
        if json.loads(subprocess.check_output(['git', 'show', head + ':plugins-src/write/package.json'], cwd=p.ROOT))['version'] == '0.1.16':
            self.skipTest('Final source was committed after candidate preparation')
        with self.assertRaises(RuntimeError):
            p.freeze(head)
        self.assertFalse((p.HERE / 'frozen-plugin-packages.json').exists())


if __name__ == '__main__':
    unittest.main()
