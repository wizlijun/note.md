#!/usr/bin/env python3
"""Explicit isolated IMK validation. No action without a chosen command."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys

repo=Path(__file__).resolve().parents[3]
root=repo/'tasks/sumi-macos-ime-imk'
ctl=root/'build/tisctl'
source=root/'build/SumiMarkerProbe.app'
destination=Path.home()/'Library/Input Methods/SumiMarkerProbe.app'
recovery=root/'evidence/recovery.json'
installed=root/'evidence/installed-files.json'

def call(*args,check=True):
    result=subprocess.run([str(ctl),*map(str,args)],capture_output=True,text=True)
    value=json.loads(result.stdout) if result.stdout else {}
    if check and result.returncode:
        raise RuntimeError(f'TIS {args[0]} failed: {value}; {result.stderr}')
    return value

def files(path):
    return {str(p.relative_to(path)):hashlib.sha256(p.read_bytes()).hexdigest() for p in path.rglob('*') if p.is_file()}

def save_recovery(new_install=False):
    if new_install or not recovery.exists():
        recovery.parent.mkdir(parents=True,exist_ok=True)
        recovery.write_text(json.dumps(call('snapshot'),ensure_ascii=False,indent=2))
        recovery.chmod(0o600)

def restore():
    if recovery.exists():
        result=call('restore',recovery)
        after=call('inspect')
        expected=json.loads(recovery.read_text())
        if after['current']!=expected['current']:
            raise RuntimeError('Current input source did not restore; retain recovery.json and retry restore.')
        return result

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('command',choices=['inspect','install-register','run','restore','remove'])
args=parser.parse_args()
if args.command=='inspect':
    print(json.dumps(call('inspect'),ensure_ascii=False,indent=2))
elif args.command=='install-register':
    if destination.exists():raise RuntimeError(f'Refusing to replace existing {destination}')
    save_recovery(new_install=True)
    destination.parent.mkdir(parents=True,exist_ok=True)
    shutil.copytree(source,destination)
    installed.write_text(json.dumps(files(destination),indent=2))
    try:
        print(json.dumps(call('register',destination)))
        state=call('inspect')
        if state['probe'] is None:
            raise RuntimeError('Registration returned but no source exists in a fresh process. Stop here; a login refresh may be required. Do not kill system services or rewrite HIToolbox preferences.')
        print(json.dumps(call('enable-parent')))
        print(json.dumps(call('enable')))
        state=call('inspect')
        if not state['probe'] or not state['probe']['enabled'] or not state['probe']['selectable'] or not state.get('parent') or not state['parent']['enabled']:
            raise RuntimeError(f'Probe source is not enabled/selectable: {state["probe"]}')
        print('Registered and enabled only; no input source was selected or probe window opened.')
    except BaseException:
        restore()
        raise
elif args.command=='run':
    state=call('inspect')
    if not state['probe'] or not state['probe']['enabled'] or not state['probe']['selectable'] or not state.get('parent') or not state['parent']['enabled']:
        raise RuntimeError('Source must be registered and enabled before running.')
    save_recovery()
    for filename in ['ime.jsonl','host.jsonl']:
        path=root/'evidence'/filename
        if path.exists():path.unlink()
    try:
        subprocess.run([str(root/'build/SumiMarkerProbeHost.app/Contents/MacOS/SumiMarkerProbeHost'),'--run'],check=True,timeout=18)
        ime=[json.loads(line) for line in (root/'evidence/ime.jsonl').read_text().splitlines()]
        host=[json.loads(line) for line in (root/'evidence/host.jsonl').read_text().splitlines()]
        keys=[row for row in ime if row.get('phase')=='key']
        assert [row['key'] for row in keys]==['a','b','c'],keys
        assert [row['expectedMarker'] for row in keys]==[True,False,True],keys
        assert [row['markerCount'] for row in keys]==[1,0,1],keys
        assert all(row['clientBundle']=='com.notemd.SumiMarkerProbeHost' for row in keys)
        assert keys[0]['pid']!=host[0]['pid'],'Must cross process boundary'
        assert host[-1]['phase']=='finish' and host[-1]['success'],host[-1]
        print('PASS: true IMK cross-process marker transfer and body/search/body isolation; three remote insertText commits.')
    finally:
        restore()
        call('stop',check=False)
elif args.command=='restore':
    print(json.dumps(restore()))
elif args.command=='remove':
    restore()
    call('stop',check=False)
    if destination.exists():
        if not installed.exists() or files(destination)!=json.loads(installed.read_text()):
            raise RuntimeError('Installed bundle differs from this probe manifest; refusing removal.')
        shutil.rmtree(destination)
    print('Removed only the exact probe bundle. macOS has no public TIS unregister; a disabled cache entry may remain until system refresh.')
