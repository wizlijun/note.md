#!/usr/bin/env python3
"""Prepare only synthetic Sumi GUI acceptance data; --install writes unique App Support."""
from pathlib import Path
import argparse, hashlib, json, shutil, tempfile

repo=Path(__file__).resolve().parents[3]
work=repo/'tasks/sumi-native/host-acceptance'
identity='net.notemd.sumi.acceptance'
vault=work/'vault'
stage=work/'seed'
args=argparse.ArgumentParser()
args.add_argument('--install',action='store_true',help='Copy the prepared seed into the unique acceptance App Support directory')
args.add_argument('--benchmark-dir',default=str(Path(tempfile.gettempdir())/'sumi-editor-benchmark'),help='Optional prebuilt isolated benchmark artifacts; no production plugin source is changed')
args=args.parse_args()

def write(path,value):
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n')

def no_symlink(path):
    for part in [path,*path.parents]:
        if part.is_symlink():raise SystemExit(f'Refusing symbolic link: {part}')

no_symlink(work);no_symlink(vault);no_symlink(stage)
vault.mkdir(parents=True,exist_ok=True)
# Keep runtime config/evidence beside the existing isolated Vault. The tracked
# template is portable; resolve its plist only for this checkout's runtime file.
config=json.loads((Path(__file__).parent/'tauri.acceptance.json').read_text())
config['bundle']['macOS']['infoPlist']=str(Path(__file__).parent/'Info.plist')
write(work/'tauri.acceptance.json',config)
if (vault/'.git').exists():raise SystemExit('Acceptance Vault must not be a git repository')
(vault/'.sumi-acceptance-vault').write_text('sumi-acceptance-only\n')
(vault/'inbox/writings').mkdir(parents=True,exist_ok=True)
readme=vault/'Acceptance.md'
if not readme.exists():readme.write_text('# Sumi 隔离验收\n\n此目录仅含合成测试文字；不连接正式 Vault。\n')
marker={'identifier':identity,'vault':str(vault),'purpose':'Sumi isolated GUI acceptance'}
write(stage/'.sumi-acceptance.json',marker)
write(stage/'shared.json',{'version':1,'sotvault':str(vault)})
write(stage/'settings.json',{'locale':'zh','mcpServer':{'enabled':False},'dailyNotes':{'enabled':False},'recentFiles':[],'autoSave':False})
plugin=repo/'plugins-src/write'
manifest=json.loads((plugin/'manifest.v2.json').read_text())
if manifest['id']!='notemd.sumi':raise SystemExit('Unexpected plugin identity')
if not (plugin/'dist/index.html').is_file():raise SystemExit('Build the production Sumi plugin before preparing acceptance')
current=stage/'plugins/notemd.sumi/current'
no_symlink(current)
if (current/'ui').exists():shutil.rmtree(current/'ui')
shutil.copytree(plugin/'dist',current/'ui')
benchmark=Path(args.benchmark_dir).resolve()
if (benchmark/'identity.json').is_file():
    no_symlink(benchmark)
    build=json.loads((benchmark/'identity.json').read_text())
    for relative,expected in build['artifacts'].items():
        source=benchmark/'web'/relative
        no_symlink(source)
        if not source.resolve().is_relative_to((benchmark/'web').resolve()):raise SystemExit('Benchmark path escaped build')
        if hashlib.sha256(source.read_bytes()).hexdigest()!=expected:raise SystemExit(f'Benchmark artifact changed: {relative}')
    target=current/'ui/benchmark'
    shutil.copytree(benchmark/'web',target)
    shutil.copytree(benchmark/'corpus',target/'corpus')
    shutil.copy2(benchmark/'identity.json',target/'identity.json')
    fonts=repo/'src-tauri/resources/sumi'
    font_manifest=json.loads((fonts/'manifest.json').read_text())
    (target/'fonts').mkdir()
    shutil.copy2(fonts/'manifest.json',target/'fonts/manifest.json')
    for asset in font_manifest['assets']:
        source=fonts/asset['file'];no_symlink(source)
        if hashlib.sha256(source.read_bytes()).hexdigest()!=asset['sha256']:raise SystemExit('Benchmark font hash mismatch')
        shutil.copy2(source,target/'fonts'/asset['file'])
    manifest['contributes']['windows'].append({'id':'benchmark','entry':'benchmark/index.html','title':'Sumi 同机性能验收','width':1100,'height':900,'resizable':True,'open_command':'benchmark'})
    manifest['contributes']['menus'].append({'location':'plugins','submenu':'experience','label':'Sumi 同机性能验收','command':'benchmark'})
    manifest['activation']['events'].append('onCommand:benchmark')
    manifest.setdefault('i18n',{}).setdefault('zh',{}).setdefault('menus',{})['benchmark']='Sumi 同机性能验收'
    print('Included isolated benchmark window (main Sumi window unchanged)')
write(current/'manifest.json',manifest)
write(stage/'plugins/state.json',{'installed':{'notemd.sumi':{'version':manifest['version'],'enabled':True}}})
files={str(p.relative_to(stage)):hashlib.sha256(p.read_bytes()).hexdigest() for p in stage.rglob('*') if p.is_file()}
write(work/'seed-hashes.json',files)
if args.install:
    destination=Path.home()/'Library/Application Support'/identity
    no_symlink(destination)
    if destination.exists():
        own=destination/'.sumi-acceptance.json'
        if not own.is_file() or json.loads(own.read_text())!=marker:raise SystemExit('Refusing an existing unmarked acceptance directory')
        # Do not reset existing drafts, credentials, preferences, or SQLite state.
        shared=json.loads((destination/'shared.json').read_text())
        if shared.get('sotvault')!=str(vault):raise SystemExit('Existing acceptance Vault changed')
        target=destination/'plugins/notemd.sumi/current'
        if target.exists():shutil.rmtree(target)
        shutil.copytree(current,target)
        shutil.copy2(stage/'plugins/state.json',destination/'plugins/state.json')
    else:
        shutil.copytree(stage,destination)
    print(f'Prepared isolated App Support: {destination}')
else:
    print(f'Prepared reviewable seed only: {stage}')
print(f'Vault: {vault}')
