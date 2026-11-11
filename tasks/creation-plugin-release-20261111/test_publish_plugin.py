import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('publisher', Path(__file__).with_name('publish-plugin.py'))
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


def entries():
    return [dict(id='notemd.sumi', version='0.1.15', category='create', min_host='>=6.1111.1'),
            dict(id='notemd.idea-spark', version='1.3.9', category='create', min_host='>=6.1110.4')]


class MergeTests(unittest.TestCase):
    def setUp(self):
        self.live = {'schema': 7, 'unknown': {'preserve': True}, 'plugins': [
            dict(id='notemd.sumi', version='0.1.14', category='tools', sha256={'arm': 'old'}, download={'arm': 'old-url'}, name='Old Sumi'),
            dict(id='notemd.idea-spark', version='1.3.8', category='inspiration', i18n={'zh': {'name': '旧名字'}}, min_host='>=6.1110.4'),
            dict(id='other', version='1.0.0', category='inspiration', unknown=[1, 2]),
            dict(id='notemd.sumi', version='0.1.6', archs=['linux'], size=123),
        ]}

    def test_only_two_historical_categories_change_and_inputs_unchanged(self):
        original = copy.deepcopy(self.live)
        result = p.merge_entries(self.live, entries())
        expected = copy.deepcopy(self.live)
        for row in expected['plugins']:
            if row['id'] in {'notemd.sumi', 'notemd.idea-spark'}:
                row['category'] = 'create'
        expected['plugins'] += entries()
        self.assertEqual(result, expected)
        self.assertEqual(self.live, original)

    def test_idempotent_after_success(self):
        once = p.merge_entries(self.live, entries())
        self.assertEqual(p.merge_entries(once, entries()), once)

    def test_same_version_conflict_not_hidden_by_category_rewrite(self):
        for field, value in [('category', 'inspiration'), ('min_host', '>=0.0.0'), ('sha256', {'arm': 'changed'})]:
            live = copy.deepcopy(self.live)
            conflict = copy.deepcopy(entries()[0]); conflict[field] = value
            live['plugins'].append(conflict)
            with self.subTest(field=field), self.assertRaises(RuntimeError):
                p.merge_entries(live, entries())

    def test_duplicate_existing_identity_rejected(self):
        self.live['plugins'].append(copy.deepcopy(self.live['plugins'][0]))
        with self.assertRaises(RuntimeError): p.merge_entries(self.live, entries())

    def test_extra_missing_wrong_identity_or_category_rejected(self):
        variants = [entries()[:1], entries() + [dict(id='other', version='2')], list(reversed(entries()))]
        for field, value in [('id', 'evil'), ('version', '0.1.14'), ('category', 'tools')]:
            changed = entries(); changed[0][field] = value; variants.append(changed)
        for changed in variants:
            with self.subTest(changed=changed), self.assertRaises(RuntimeError):
                p.merge_entries(self.live, changed)


class ManifestTests(unittest.TestCase):
    def fixture(self, identity='notemd.sumi'):
        id, version, arch = next(e for e in p.EXPECTED if e[0] == identity)
        row = dict(id=id, version=version, arch=arch, bytes=100, sha256='ab'*32)
        manifest = dict(id=id, version=version, name='Current name',
                        engines={'notemd': p.MIN_HOSTS[id]},
                        contributes={'menus': [{'submenu': 'create', 'command': 'open'}]},
                        i18n={'zh': {'name': '当前名字'}})
        entry = dict(id=id, version=version, name=manifest['name'], min_host=p.MIN_HOSTS[id],
                     category='create', archs=[arch], size=100, sha256={arch: row['sha256']},
                     download={arch:p.download(row)}, i18n=manifest['i18n'], description=None,
                     icon_url=None, changelog_url=None)
        return row, manifest, entry

    def test_both_exact_manifest_entries(self):
        for id in p.MANIFEST_PATHS:
            row, manifest, entry = self.fixture(id)
            p.validate_manifest_and_entry(row, manifest, copy.deepcopy(manifest), entry)

    def test_no_extra_or_tampered_candidate_fields(self):
        for field, value in [('name', 'stale'), ('category', 'inspiration'), ('min_host', '>=0.0.0'),
                             ('sha256', {}), ('archs', ['wrong']), ('download', {}),
                             ('size', 101), ('i18n', None), ('unknown', 'injected')]:
            row, manifest, entry = self.fixture(); entry[field] = value
            with self.subTest(field=field), self.assertRaises(RuntimeError):
                p.validate_manifest_and_entry(row, manifest, manifest, entry)

    def test_source_manifest_must_match_all_fields(self):
        row, manifest, entry = self.fixture(); source = copy.deepcopy(manifest)
        source['capabilities'] = ['secret']
        with self.assertRaisesRegex(RuntimeError, 'final source'):
            p.validate_manifest_and_entry(row, manifest, source, entry)

    def test_package_source_agreement_cannot_lower_engine_or_restore_legacy_menu(self):
        for id in p.MANIFEST_PATHS:
            for change in ['engine', 'submenu']:
                row, manifest, entry = self.fixture(id)
                if change == 'engine': manifest['engines']['notemd'] = '>=0.0.0'
                else: manifest['contributes']['menus'][0]['submenu'] = 'inspiration'
                with self.subTest(id=id, change=change), self.assertRaises(RuntimeError):
                    p.validate_manifest_and_entry(row, manifest, manifest, entry)


class NetworkMutationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.pkg = self.root / 'aarch64-apple-darwin.notemdpkg'
        self.pkg.write_bytes(b'package'); Path(str(self.pkg) + '.minisig').write_bytes(b'signature')
        self.row = dict(id='notemd.sumi', version='0.1.15', arch='aarch64-apple-darwin', packagePath=str(self.pkg))
        self.patches = [patch.object(p, 'HERE', self.root), patch.object(p, 'PUBLIC', self.root/'public'), patch.object(p, 'ROWS', [self.row])]
        for item in self.patches: item.start()

    def tearDown(self):
        for item in self.patches: item.stop()
        self.temp.cleanup()

    def test_uncertain_preflight_does_not_write(self):
        with patch.object(p, 'fetch', return_value=503), patch.object(p, 'wrangler') as write:
            with self.assertRaises(RuntimeError): p.stage()
            write.assert_not_called()

    def test_conflicting_second_object_does_not_partially_write(self):
        def fetch(url, path):
            if '.minisig' in url: path.write_bytes(b'conflict'); return 200
            return 404
        with patch.object(p, 'fetch', side_effect=fetch), patch.object(p, 'wrangler') as write:
            with self.assertRaises(RuntimeError): p.stage()
            write.assert_not_called()

    def test_timeout_landed_object_is_read_before_retry(self):
        landed = set(); actions = []
        def fetch(url, path):
            key = 'signature' if '.minisig' in url else 'package'
            actions.append(('read', key))
            if key in landed: path.write_bytes(key.encode()); return 200
            return 404
        def write(args, log):
            key = 'signature' if '.minisig' in args[3] else 'package'
            landed.add(key); actions.append(('write', key))
            raise p.subprocess.TimeoutExpired('wrangler', 600)
        with patch.object(p, 'fetch', side_effect=fetch), patch.object(p, 'wrangler', side_effect=write), patch.object(p, 'verify_public_packages') as verify:
            p.stage()
            self.assertEqual([a for a in actions if a[0]=='write'], [('write','package'), ('write','signature')])
            for index, action in enumerate(actions):
                if action[0]=='write': self.assertEqual(actions[index+1], ('read',action[1]))
            verify.assert_called_once()

    def test_index_concurrent_change_blocks_write(self):
        before = {'plugins': []}; concurrent = {'plugins': [dict(id='other', version='1')]}
        with patch.object(p, 'require_public_host'), patch.object(p, 'verify_public_packages'), patch.object(p, 'read_kv', side_effect=[before, concurrent]), patch.object(p, 'wrangler') as write:
            with self.assertRaisesRegex(RuntimeError, 'Concurrent'): p.publish_index(entries())
            write.assert_not_called()


    def test_host_gate_failure_prevents_kv_and_upload(self):
        with patch.object(p, 'require_public_host', side_effect=RuntimeError('Host not public')), patch.object(p, 'verify_public_packages') as verify, patch.object(p, 'wrangler') as write:
            with self.assertRaisesRegex(RuntimeError, 'Host'): p.publish_index(entries())
            verify.assert_not_called(); write.assert_not_called()

    def test_public_package_failure_prevents_kv_write(self):
        with patch.object(p, 'require_public_host'), patch.object(p, 'verify_public_packages', side_effect=RuntimeError('Wrong signature')), patch.object(p, 'read_kv') as kv, patch.object(p, 'wrangler') as write:
            with self.assertRaisesRegex(RuntimeError, 'signature'): p.publish_index(entries())
            kv.assert_not_called(); write.assert_not_called()

    def test_index_timeout_after_landing_reads_back_and_does_not_rewrite(self):
        before = {'plugins': [dict(id='notemd.sumi',version='0.1.6',category='tools')]}
        candidate = p.merge_entries(before, entries())
        def fetch(url, target): target.write_text(json.dumps(candidate)); return 200
        with patch.object(p, 'require_public_host'), patch.object(p, 'verify_public_packages'), patch.object(p, 'read_kv', side_effect=[before, before, candidate]), patch.object(p, 'fetch', side_effect=fetch), patch.object(p, 'wrangler', side_effect=p.subprocess.TimeoutExpired('wrangler', 600)) as write:
            p.publish_index(entries())
            write.assert_called_once()
            report = json.loads((self.root/'plugins-index-verification.json').read_text())
            self.assertTrue(report['ok'])
            self.assertEqual(report['categoryChanges'], [{'id':'notemd.sumi','version':'0.1.6','from':'tools','to':'create'}])
            self.assertTrue(report['historicalFieldsPreservedExceptApprovedCategories'])


if __name__ == '__main__': unittest.main()
