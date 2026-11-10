import importlib.util
import struct
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('verify_linux', Path(__file__).with_name('verify-linux-binary.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class LinuxBinaryTests(unittest.TestCase):
    def test_target_permissions_and_truncation_are_checked(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'notemd-sumi'
            raw = bytearray(120)
            raw[:7] = b'\x7fELF\x02\x01\x01'
            struct.pack_into('<HHI', raw, 16, 3, 62, 1)
            struct.pack_into('<Q', raw, 32, 64)
            struct.pack_into('<HH', raw, 54, 56, 1)
            path.write_bytes(raw)
            path.chmod(0o755)
            self.assertEqual(module.verify(path, 'x86_64-unknown-linux-gnu')['bytes'], 120)
            for invalid in (raw[:64], b'not ELF', raw[:18] + b'\xb7\x00' + raw[20:]):
                path.write_bytes(invalid)
                with self.assertRaises(ValueError):
                    module.verify(path, 'x86_64-unknown-linux-gnu')
            path.write_bytes(raw)
            path.chmod(0o644)
            with self.assertRaises(ValueError):
                module.verify(path, 'x86_64-unknown-linux-gnu')


if __name__ == '__main__':
    unittest.main()
