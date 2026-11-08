"""Offline orchestration tests: no Apple command or network request is executed."""
import contextlib, hashlib, importlib.util, io, json, os, subprocess, tempfile, unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
s=importlib.util.spec_from_file_location('native_release',Path(__file__).with_name('native-release.py'))
n=importlib.util.module_from_spec(s);s.loader.exec_module(n)

class NativeReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name).resolve();(self.root/'source.rs').write_text('frozen')
        self.input=self.root/'input';self.input.write_bytes(b'unsigned backend')
        self.args=SimpleNamespace(target='aarch64-apple-darwin',source='a'*40,binary=self.input,output_dir=self.root/'evidence')
        self.calls=[];self.wait_timeout=False;self.invalid=False
        self.env={'APPLE_TEAM_ID':'ABCDEFGHIJ','APPLE_SIGNING_IDENTITY':'Developer ID Application: Test (ABCDEFGHIJ)','SUMI_NOTARY_PROFILE':'fixture-profile'}
        self.job='12345678-1234-1234-1234-123456789abc'
    def inspect(self,binary,arch,team):
        return {'identifier':n.IDENTIFIER,'team':team,'cdhash':'a'*40,'runtime':True,'timestamp':True,'sha256':n.sha(binary.read_bytes()),'bytes':binary.stat().st_size,'architecture':arch}
    def tool_run(self,command,timeout=120):
        self.calls.append(command)
        if command[0].endswith('codesign'):
            p=Path(command[-1]);p.write_bytes(p.read_bytes()+b' signed');return '', ''
        operation=command[2]
        if operation=='submit':return json.dumps({'id':self.job}),''
        if operation=='wait':
            if self.wait_timeout:raise subprocess.TimeoutExpired(command,timeout)
            return json.dumps({'status':'Invalid' if self.invalid else 'Accepted'}),''
        if operation=='log':
            state=json.loads((self.args.output_dir/'state.json').read_text())
            Path(command[4]).write_text(json.dumps({'jobId':self.job,'sha256':state['archive_sha256'],'status':'Accepted','statusCode':0,'ticketContents':[{'cdhash':'a'*40,'arch':'arm64'}]}))
            return '', ''
        raise AssertionError('Unexpected external command')
    def execute(self):
        with patch.dict(os.environ,self.env,clear=True), patch.object(n,'ROOT',self.root), patch.object(n,'frozen_sources',return_value={'source.rs':n.sha(b'frozen')}), patch.object(n,'run',side_effect=self.tool_run), patch.object(n,'inspect_binary',side_effect=self.inspect), patch.object(n,'assessment',return_value={'exit_code':3,'stderr':'not an app','notarized_developer_id':False}), contextlib.redirect_stdout(io.StringIO()):
            n.execute(self.args)
    def test_success_records_final_byte_binding_and_does_not_claim_spctl_pass(self):
        self.execute();r=json.loads((self.args.output_dir/'receipt.json').read_text())
        self.assertEqual(r['status'],'Accepted');self.assertEqual(r['binary']['sha256'],n.sha((self.args.output_dir/'notemd-sumi').read_bytes()))
        self.assertFalse(r['spctl']['notarized_developer_id'])
    def test_source_freeze_covers_all_local_compiled_crates(self):
        self.assertTrue({'plugins-src/write/backend','sumi-protocol','write-core','notemd-plugin-sdk','plugin-protocol'} <= set(n.SOURCE_DIRS))

    def test_missing_identity_rejected_before_any_external_command(self):
        self.env.pop('APPLE_SIGNING_IDENTITY')
        with self.assertRaises(RuntimeError):self.execute()
        self.assertEqual(self.calls,[])
    def test_changed_source_rejected_before_signing(self):
        (self.root/'source.rs').write_text('changed')
        with self.assertRaises(RuntimeError):self.execute()
        self.assertEqual(self.calls,[])
    def test_wait_timeout_resumes_same_submission_without_resigning(self):
        self.wait_timeout=True
        with self.assertRaises(subprocess.TimeoutExpired):self.execute()
        self.assertEqual(json.loads((self.args.output_dir/'state.json').read_text())['submission_id'],self.job)
        self.wait_timeout=False;self.execute()
        self.assertEqual(sum(c[0].endswith('codesign') for c in self.calls),1)
        self.assertEqual(sum(len(c)>2 and c[2]=='submit' for c in self.calls),1)
    def test_ambiguous_submit_never_automatically_resubmits(self):
        original=self.tool_run
        def fail(command,timeout=120):
            if len(command)>2 and command[2]=='submit':raise RuntimeError('ambiguous submit')
            return original(command,timeout)
        self.tool_run=fail
        with self.assertRaises(RuntimeError):self.execute()
        self.tool_run=original
        with self.assertRaisesRegex(RuntimeError,'Previous submit outcome unknown'):self.execute()
        self.assertFalse(any(len(c)>2 and c[2]=='submit' for c in self.calls))
    def test_invalid_notary_does_not_create_receipt(self):
        self.invalid=True
        with self.assertRaises(RuntimeError):self.execute()
        self.assertFalse((self.args.output_dir/'receipt.json').exists())
    def test_changed_signed_binary_rejected_on_resume(self):
        self.execute();(self.args.output_dir/'notemd-sumi').write_bytes(b'changed')
        with self.assertRaises(RuntimeError):self.execute()
    def test_changed_archive_rejected_on_resume(self):
        self.execute();(self.args.output_dir/'notemd-sumi-notary.zip').write_bytes(b'changed')
        with self.assertRaises(RuntimeError):self.execute()

if __name__=='__main__':unittest.main()
