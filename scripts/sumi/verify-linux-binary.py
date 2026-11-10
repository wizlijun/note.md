"""Reject wrong-architecture/non-executable Sumi binaries before packaging."""
import argparse
import hashlib
import json
import struct
from pathlib import Path


def verify(path: Path, target: str) -> dict:
    if target != 'x86_64-unknown-linux-gnu':
        raise ValueError('unsupported Sumi Linux target')
    if path.is_symlink() or not path.is_file() or not path.stat().st_mode & 0o111:
        raise ValueError('Sumi backend must be a regular executable')
    raw = path.read_bytes()
    if len(raw) < 64 or raw[:7] != b'\x7fELF\x02\x01\x01':
        raise ValueError('Sumi backend must be little-endian ELF64')
    kind, machine, version = struct.unpack_from('<HHI', raw, 16)
    if kind not in (2, 3) or machine != 62 or version != 1:
        raise ValueError('Sumi backend ELF target does not match x86_64')
    # Require program headers: a relocatable object or truncated header is not a program.
    offset = struct.unpack_from('<Q', raw, 32)[0]
    size, count = struct.unpack_from('<HH', raw, 54)
    if offset < 64 or size != 56 or count == 0 or offset + size * count > len(raw):
        raise ValueError('Sumi backend has no valid ELF program headers')
    return {'target': target, 'sha256': hashlib.sha256(raw).hexdigest(), 'bytes': len(raw)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('binary', type=Path)
    parser.add_argument('--target', required=True)
    args = parser.parse_args()
    print(json.dumps(verify(args.binary, args.target)))
