#!/usr/bin/env python3
"""Test UI staging limited to build fixtures and one explicit acceptance path."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil

HERE = Path(__file__).resolve().parent
SANDBOX = HERE.parent
ACCEPTANCE_UI = SANDBOX.parent / 'sumi-omarchy-acceptance/data/net.notemd.app/plugins/notemd.sumi/0.1.10/ui'
ASSET = 'sumi-detach-mount-regression.js'


def hashes(root):
    files = [path for path in root.rglob('*') if path.is_file()]
    if any(path.is_symlink() for path in root.rglob('*')):
        raise SystemExit('Refusing a UI directory containing symlinks')
    return {str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(files)}


def contained(path):
    path = path.resolve()
    if not path.is_relative_to(SANDBOX) or path == SANDBOX:
        raise SystemExit('Path must be inside the isolated tasks/omarchy-build directory')
    return path


def isolated_ui(path):
    path = path.resolve()
    if path == ACCEPTANCE_UI.resolve():
        return path
    return contained(path)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['install', 'restore'])
    parser.add_argument('--record', required=True, type=Path,
                        help='Fresh evidence directory on install; same directory on restore')
    parser.add_argument('--ui', type=Path)
    args = parser.parse_args()
    record = contained(args.record)
    if args.action == 'install':
        if args.ui is None:
            parser.error('install requires --ui')
        ui = isolated_ui(args.ui)
        if not (ui / 'index.html').is_file() or (ui / ASSET).exists():
            raise SystemExit('Expected existing UI index and no injected harness asset')
        if record.exists() or record.is_relative_to(ui):
            raise SystemExit('Record must be a fresh directory outside the UI')
        before = hashes(ui)
        record.mkdir(parents=True)
        shutil.copy2(ui / 'index.html', record / 'original-index.html')
        (record / 'baseline.json').write_text(json.dumps({'ui': str(ui), 'files': before}, indent=2))
        shutil.copyfile(HERE / 'harness.js', ui / ASSET)
        (ui / 'index.html').write_bytes((HERE / 'index.html').read_bytes())
        (record / 'staged.json').write_text(json.dumps({'files': hashes(ui)}, indent=2))
        print(json.dumps({'staged': str(ui), 'record': str(record), 'executed': False}))
    else:
        baseline = json.loads((record / 'baseline.json').read_text())
        staged = json.loads((record / 'staged.json').read_text())
        ui = isolated_ui(Path(baseline['ui']))
        current = hashes(ui)
        for name in ['index.html', ASSET]:
            if current.get(name) != staged['files'].get(name):
                raise SystemExit(f'Refusing to overwrite an unexpected edit: {name}')
        shutil.copy2(record / 'original-index.html', ui / 'index.html')
        (ui / ASSET).unlink()
        after = hashes(ui)
        result = {'allOriginalHashesRestored': after == baseline['files'], 'files': len(after)}
        (record / 'ui-restored.json').write_text(json.dumps(result, indent=2))
        print(json.dumps(result))
        if not result['allOriginalHashesRestored']:
            raise SystemExit('Other UI assets changed during the run; inspect baseline/staged hashes')


if __name__ == '__main__':
    main()
