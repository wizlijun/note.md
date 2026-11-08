"""Metadata stays in the plugin source; only font payloads enter ignored dev cache."""
import contextlib, copy, hashlib, importlib.util, io, tempfile, unittest
from pathlib import Path
from unittest.mock import patch
s=importlib.util.spec_from_file_location('font_prepare',Path(__file__).with_name('prepare-sumi-font.py'))
m=importlib.util.module_from_spec(s);s.loader.exec_module(m)

class FontPreparationTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.cache=self.root/'dev';self.metadata=self.root/'resources'
        self.cache.mkdir();self.metadata.mkdir();self.assets=copy.deepcopy(m.ASSETS)
        for a in self.assets:
            a.update(size=4,sha256=hashlib.sha256(b'font').hexdigest())
            (self.cache if a.get('postscript') else self.metadata).joinpath(a['file']).write_bytes(b'font')
    def prepare(self, fetch=None):
        with patch.multiple(m,DEST=self.cache,RESOURCE_DIR=self.metadata,ASSETS=self.assets), patch.object(m.urllib.request,'urlopen',side_effect=fetch or AssertionError('Unexpected download')), contextlib.redirect_stdout(io.StringIO()):m.prepare()
    def test_all_nine_metadata_files_stay_out_of_font_cache_without_network(self):
        # Six upstream license assets have no `bundled` flag; they are metadata.
        self.assertEqual(sum(not a.get('postscript') and not a.get('bundled') for a in self.assets),6)
        self.prepare()
        self.assertEqual(len(list(self.cache.iterdir())),7)
        self.assertEqual(len(list(self.metadata.iterdir())),9)
        self.assertTrue(all(p.suffix in {'.ttf','.otf'} for p in self.cache.iterdir()))
    def test_missing_unflagged_license_requires_source_repair_not_download(self):
        a=next(a for a in self.assets if not a.get('postscript') and not a.get('bundled'))
        (self.metadata/a['file']).unlink()
        with self.assertRaisesRegex(ValueError,'tracked provenance missing'):self.prepare()
        self.assertFalse((self.cache/a['file']).exists())
    def test_missing_font_is_downloaded_only_to_development_cache(self):
        a=next(a for a in self.assets if a.get('postscript') and not a.get('archive_size'))
        (self.cache/a['file']).unlink();self.prepare(lambda *args,**kw:io.BytesIO(b'font'))
        self.assertEqual((self.cache/a['file']).read_bytes(),b'font')
        self.assertFalse((self.metadata/a['file']).exists())

if __name__=='__main__':unittest.main()
