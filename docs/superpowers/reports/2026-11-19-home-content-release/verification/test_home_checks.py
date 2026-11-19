import copy
import hashlib
import tempfile
import unittest
from pathlib import Path
import home_checks as h


class SourceTests(unittest.TestCase):
    def test_exact_accepted_source(self):
        report = h.verify_frozen_sources(['src/home.ts'], lambda _: b'accepted', lambda _: b'accepted')
        self.assertTrue(report['src/home.ts']['byteIdentical'])

    def test_same_ancestor_different_bytes_rejected(self):
        with self.assertRaises(AssertionError):
            h.verify_frozen_sources(['src/home.ts'], lambda _: b'accepted', lambda _: b'changed')


class CurrentSourceTests(unittest.TestCase):
    def setUp(self):
        self.root = Path('/Users/bruce/git/mdeditor')
        self.source = lambda p: (self.root / p).read_text()

    def test_current_accepted_source_layout(self):
        self.assertEqual(len(h.verify_home_source(self.source)), 17)

    def test_four_row_default_rejected(self):
        with self.assertRaises(AssertionError):
            h.verify_home_source(lambda p: self.source(p).replace('const COLLAPSED_ROWS = 3', 'const COLLAPSED_ROWS = 4'))

    def test_ai_content_action_rejected(self):
        with self.assertRaises(AssertionError):
            h.verify_home_source(lambda p: self.source(p).replace('<p>{t(\'homeAi.empty\')}</p>', '<button>Suggest</button><p>{t(\'homeAi.empty\')}</p>'))

    def test_home_edit_callback_missing_rejected(self):
        with self.assertRaises(AssertionError):
            h.verify_home_source(lambda p: self.source(p).replace('recordHomeEdit(file.tab.filePath, sotvaultStore.vaultRoot)', ''))


class EmbeddedTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.js = self.fixture('App-home.js', h.JS_ROLES)
        self.css = self.fixture('App-home.css', h.CSS_ROLES)
        self.hashes = {h.sha(p.read_bytes()) for p in [*self.js, *self.css]}

    def tearDown(self):
        self.temp.cleanup()

    def fixture(self, name, roles):
        path = self.root / name
        text = ' '.join(t for tokens in roles.values() for t in tokens)
        if 'eight-slots-pins-model-store' in roles:
            text += ' const SLOT=8;function fixture(){return {pins:Array(SLOT).fill(null)}};if(x>=SLOT){}'
            text += ' const ROWS=3,sections=derive(()=>[{kind:"new",title:t("homeContent.new")}]);if(section.items.length>ROWS&&expanded)render(section.items.slice(0,ROWS));'
        path.write_text(text)
        return {path: text}

    def test_complete_signed_module_witnesses(self):
        self.assertEqual(len(h.verify_home_resources(self.js, self.css, self.hashes)['compiledRoles']), 15)

    def test_each_role_missing_rejected(self):
        for token in ['data-home-slot', 'data-target-slot', 'home-apps.json', 'vaultOverview.showDetails', 'homeApps.commonFeatures']:
            with self.subTest(token=token), self.assertRaises(AssertionError):
                h.verify_home_resources({p: text.replace(token, '') for p, text in self.js.items()}, self.css, self.hashes)

    def test_complete_css_dark_palette_required(self):
        for token in ['#243744', '#203c37', '#3d3222', 'prefers-color-scheme:dark']:
            with self.subTest(token=token), self.assertRaises(AssertionError):
                h.verify_home_resources(self.js, {p: text.replace(token, '') for p, text in self.css.items()}, self.hashes)

    def test_unembedded_whole_module_rejected(self):
        for path in [*self.js, *self.css]:
            with self.subTest(path=path), self.assertRaises(AssertionError):
                h.verify_home_resources(self.js, self.css, self.hashes - {h.sha(path.read_bytes())})

    def test_seven_slot_compiled_default_rejected(self):
        with self.assertRaises(AssertionError):
            h.verify_home_resources({p: text.replace('SLOT=8;', 'SLOT=7;') for p, text in self.js.items()}, self.css, self.hashes)

    def test_four_row_compiled_default_rejected(self):
        with self.assertRaises(AssertionError):
            h.verify_home_resources({p: text.replace('ROWS=3,', 'ROWS=4,') for p, text in self.js.items()}, self.css, self.hashes)

    def test_wrong_show_all_threshold_or_slice_rejected(self):
        for changed in ['section.items.length>OTHER&&', 'section.items.slice(0,OTHER)']:
            original = 'section.items.length>ROWS&&' if 'length' in changed else 'section.items.slice(0,ROWS)'
            with self.subTest(changed=changed), self.assertRaises(AssertionError):
                h.verify_home_resources({p: text.replace(original, changed) for p, text in self.js.items()}, self.css, self.hashes)

    def test_share_only_module_rejected(self):
        with self.assertRaises(AssertionError):
            h.verify_home_resources(self.fixture('share-editor.js', h.JS_ROLES), self.css, self.hashes)


class NotaryTests(unittest.TestCase):
    def setUp(self):
        self.cdhash = 'd' * 40
        self.log = dict(jobId='a'*8+'-'+'a'*4+'-'+'a'*4+'-'+'a'*4+'-'+'a'*12, status='Accepted', statusCode=0, issues=None, sha256='a'*64, archiveFilename='note.md-6.1119.1-aarch64.dmg', ticketContents=[])
        self.details = 'TeamIdentifier=T5G56DH47L\nCDHash=' + self.cdhash + '\n'

    def app(self):
        self.log['ticketContents'] = [dict(path='note.md.zip/'+path, cdhash=self.cdhash, arch='arm64', digestAlgorithm='SHA-256') for path in ['note.md.app', 'note.md.app/Contents/MacOS/notemd']]
        return h.verify_notary(self.log, self.details, 'app')

    def test_current_submitted_archive_binds_apple_job(self):
        capture = dict(path_observed_in_build_log='/var/folders/current/note.md.zip', bytes=100, sha256='a'*64, captured_at='current')
        self.log['archiveFilename'] = 'note.md.zip'
        result = h.verify_app_archive_binding(capture, 'Signing /var/folders/current/note.md.zip', self.log, self.log['jobId'])
        self.assertTrue(result['byteShaMatches'])
        with self.assertRaises(AssertionError):
            h.verify_app_archive_binding(dict(capture, sha256='b'*64), 'Signing /var/folders/current/note.md.zip', self.log, self.log['jobId'])
        with self.assertRaises(AssertionError):
            h.verify_app_archive_binding(capture, 'Signing /var/folders/old/note.md.zip', self.log, self.log['jobId'])

    def test_explicit_app_job_id_required_without_id_in_build_log(self):
        capture = dict(path_observed_in_build_log='/var/folders/current/note.md.zip', bytes=100, sha256='a'*64, captured_at='current')
        self.log['archiveFilename'] = 'note.md.zip'
        raw_build_log = 'Signing /var/folders/current/note.md.zip'
        self.assertNotIn(self.log['jobId'], raw_build_log)
        self.assertTrue(h.verify_app_archive_binding(capture, raw_build_log, self.log, self.log['jobId'])['byteShaMatches'])
        with self.assertRaises(AssertionError):
            h.verify_app_archive_binding(capture, raw_build_log, self.log, 'b'*8+'-'+'b'*4+'-'+'b'*4+'-'+'b'*4+'-'+'b'*12)
        with self.assertRaises(AssertionError):
            h.verify_app_archive_binding(capture, raw_build_log, self.log, '')

    def test_app_and_dmg_tickets_bound(self):
        self.assertTrue(self.app()['ticketMatchesApp'])
        self.log['ticketContents'] = [dict(path=self.log['archiveFilename'], cdhash=self.cdhash, digestAlgorithm='SHA-256')]
        self.assertTrue(h.verify_notary(self.log, self.details, 'dmg')['ticketMatchesDmg'])

    def test_old_or_mismatched_cdhash_rejected(self):
        self.app()
        self.log['ticketContents'][0]['cdhash'] = 'e'*40
        with self.assertRaises(AssertionError):
            h.verify_notary(self.log, self.details, 'app')

    def test_unaccepted_or_wrong_arch_rejected(self):
        self.app()
        for field, value in [('status', 'In Progress'), ('statusCode', 4000), ('issues', [])]:
            bad = dict(self.log, **{field: value})
            with self.subTest(field=field), self.assertRaises(AssertionError):
                h.verify_notary(bad, self.details, 'app')
        self.log['ticketContents'][1]['arch'] = 'x86_64'
        with self.assertRaises(AssertionError):
            h.verify_notary(self.log, self.details, 'app')


if __name__ == '__main__':
    unittest.main()
