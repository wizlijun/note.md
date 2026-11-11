import copy
import hashlib
import importlib.util
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('verify', Path(__file__).with_name('verify-public-host-full.py'))
v = importlib.util.module_from_spec(spec); spec.loader.exec_module(v)

class FrozenTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.root = Path(self.temp.name)
        names = ['latest.json','note.md-6.1111.2-aarch64.dmg','note.md-aarch64.app.tar.gz',
                 'note.md-aarch64.app.tar.gz.sig','Faitc5-for-Sumi-0.5.0.13-arm64.pkg','faitc5-companion.json']
        self.frozen = dict(sourceCommit='a'*40,version='6.1111.2',assets=[])
        for name in names:
            path=self.root/name;path.write_bytes(name.encode())
            self.frozen['assets'].append(dict(name=name,path=str(path),size=len(name),sha256=hashlib.sha256(name.encode()).hexdigest()))
    def tearDown(self): self.temp.cleanup()
    def test_all_six_exact(self): self.assertEqual(len(v.validate_frozen(self.frozen,'a'*40)),6)
    def test_source_mismatch(self):
        with self.assertRaises(AssertionError):v.validate_frozen(self.frozen,'b'*40)
    def test_version_mismatch(self):
        self.frozen['version']='6.1111.1'
        with self.assertRaises(AssertionError):v.validate_frozen(self.frozen,'a'*40)
    def test_missing_or_extra_assets(self):
        for rows in [self.frozen['assets'][:5],self.frozen['assets']+[self.frozen['assets'][0]]]:
            with self.subTest(count=len(rows)),self.assertRaises(AssertionError):v.validate_frozen(dict(self.frozen,assets=rows),'a'*40)
    def test_same_count_duplicate(self):
        self.frozen['assets'][-1]=self.frozen['assets'][0]
        with self.assertRaises(AssertionError):v.validate_frozen(self.frozen,'a'*40)
    def test_changed_bytes(self):
        Path(self.frozen['assets'][0]['path']).write_bytes(b'changed')
        with self.assertRaises(AssertionError):v.validate_frozen(self.frozen,'a'*40)
    def test_tampered_digest(self):
        self.frozen['assets'][0]['sha256']='b'*64
        with self.assertRaises(AssertionError):v.validate_frozen(self.frozen,'a'*40)

class ResponseTests(unittest.TestCase):
    def test_full_and_ranged(self):
        v.check_response(b'abc',{'Content-Length':'3'},200,3)
        v.check_response(b'abc',{'Content-Length':'3','Content-Range':'bytes 4-6/10'},206,3,4,10)
    def test_wrong_range_or_full_status(self):
        variants=[(200,{'Content-Length':'3','Content-Range':'bytes 4-6/10'}),
                  (206,{'Content-Length':'3','Content-Range':'bytes 3-5/10'}),
                  (206,{'Content-Length':'4','Content-Range':'bytes 4-6/10'})]
        for status,headers in variants:
            with self.subTest(status=status,headers=headers),self.assertRaises(AssertionError):v.check_response(b'abc',headers,status,3,4,10)
    def test_truncated_body(self):
        with self.assertRaises(AssertionError):v.check_response(b'ab',{'Content-Length':'3'},200,3)

if __name__=='__main__':unittest.main()
