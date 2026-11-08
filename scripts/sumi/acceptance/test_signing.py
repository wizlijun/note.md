import copy
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from signing import BUNDLE_ID, configure, requested_identity, signature_report


class SigningTests(unittest.TestCase):
    def test_default_and_explicit_identity(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(requested_identity(), '-')
        with patch.dict(os.environ, {'SUMI_ACCEPTANCE_SIGNING_IDENTITY': ''}):
            with self.assertRaises(ValueError):
                requested_identity()

    def test_generated_config_only_changes_signer(self):
        template = Path(__file__).with_name('tauri.acceptance.json')
        original_bytes = template.read_bytes()
        original = json.loads(original_bytes)
        expected = copy.deepcopy(original)
        expected['bundle']['macOS']['signingIdentity'] = 'Developer ID Application: Example (TEAM)'
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / 'generated.json'
            target.write_bytes(original_bytes)
            configure(target, expected['bundle']['macOS']['signingIdentity'])
            self.assertEqual(json.loads(target.read_text()), expected)
            wrong = copy.deepcopy(original)
            wrong['identifier'] = 'net.notemd.app'
            target.write_text(json.dumps(wrong))
            with self.assertRaises(ValueError):
                configure(target, '-')
            self.assertEqual(json.loads(target.read_text()), wrong)
        self.assertEqual(template.read_bytes(), original_bytes)

    def test_actual_signature_must_match_request(self):
        identity = 'Developer ID Application: Example (TEAM)'
        adhoc = f'Identifier={BUNDLE_ID}\nSignature=adhoc\nCDHash=abc\n# designated => cdhash H"abc"\n'
        signed = f'Identifier={BUNDLE_ID}\nAuthority={identity}\nAuthority=Apple Root CA\nTeamIdentifier=TEAM\nCDHash=def\ndesignated => identifier "{BUNDLE_ID}" and anchor apple generic\n'
        self.assertEqual(signature_report(adhoc, '-')['cdHash'], 'abc')
        self.assertEqual(signature_report(signed, identity)['authority'], identity)
        for metadata, requested in [(adhoc, identity), (signed, '-'),
                                    (signed, 'Other Certificate'),
                                    (signed.replace('and anchor apple generic', 'and cdhash H"def"'), identity),
                                    (signed.replace(BUNDLE_ID, 'net.notemd.app'), identity),
                                    ('Identifier=' + BUNDLE_ID, identity)]:
            with self.subTest(metadata=metadata, requested=requested):
                with self.assertRaises(ValueError):
                    signature_report(metadata, requested)


if __name__ == '__main__':
    unittest.main()
