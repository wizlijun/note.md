from pathlib import Path
import subprocess, os, time, json, hashlib, re, datetime, shutil

ROOT = Path('/Users/bruce/git/mdeditor')
TASK = ROOT / 'tasks/release-2026-11-19-evidence'
SOURCE = ROOT / 'tasks/vault-release-20261114/source'
LOG = TASK / 'release-build.log'
VERSION = '6.1119.2'

def now(): return datetime.datetime.now(datetime.timezone.utc).isoformat()
def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def git(*args): return subprocess.check_output(['git', *args], cwd=SOURCE).decode().strip()
def save(name, data): (TASK/name).write_text(json.dumps(data, ensure_ascii=False, indent=2)+'\n')

assert not git('status', '--porcelain')
assert git('rev-parse', 'HEAD') == git('rev-parse', 'origin/main')
pre = git('rev-parse', 'HEAD')
environment = {
    'NOTEMD_EMPTY_ENV_DIR': str(TASK/'empty-env'), 'RUSTUP_TOOLCHAIN': '1.99.0',
    'CARGO_INCREMENTAL': '0', 'CARGO_PROFILE_DEV_DEBUG': '0',
    'CARGO_PROFILE_TEST_DEBUG': '0', 'CARGO_BUILD_JOBS': '2',
    'CARGO_NET_OFFLINE': 'true', 'CARGO_TARGET_DIR': str(ROOT/'src-tauri/target'),
}
env = os.environ.copy(); env.update(environment)
env['PATH'] = str(ROOT/'tasks/vault-reveal-fix-20261117/transport-bin')+':'+str(Path.home()/'.cargo/bin')+':'+env['PATH']
command = ['bash', 'scripts/release.sh', VERSION, '--arm64-only', '--fcitx5-package', str(ROOT/'tasks/vault-reveal-fix-20261117/host/Fcitx5-for-Sumi-0.5.0.15-arm64.pkg')]
debug = ROOT/'src-tauri/target/debug'
assert not debug.exists(), 'Expected no previous debug artifacts before this controlled build'
save('observed-command.json', {'preBumpCommit':pre, 'command':command, 'environment':environment, 'startedAt':now(), 'source':str(SOURCE)})
with LOG.open('w') as log:
    process = subprocess.Popen(['bash', '-c', 'set -a; source "$1"; set +a; shift; exec "$@"', 'release', str(ROOT/'.env.release'), *command], cwd=SOURCE, env=env, stdout=log, stderr=subprocess.STDOUT)
    cleaned = captured = False
    while process.poll() is None:
        text = LOG.read_text(errors='replace')
        if not cleaned and 'bumping versions to '+VERSION in text:
            entries = {str(p.relative_to(debug)):p.stat().st_size for p in debug.rglob('*') if p.is_file()} if debug.exists() else {}
            save('debug-cache-cleanup.json', {'files':len(entries), 'bytes':sum(entries.values()), 'manifest':entries, 'boundary':'Only regenerable debug output created by completed release tests; release caches and source preserved.'})
            if debug.exists(): shutil.rmtree(debug)
            cleaned = True
        if not captured and ('Compiling notemd v'+VERSION in text or 'Signing ' in text):
            files = subprocess.check_output(['git','ls-files','-z'],cwd=SOURCE).decode().split('\0')
            manifest = {p:digest(SOURCE/p) for p in files if p and (SOURCE/p).is_file()}
            dist = {str(p.relative_to(SOURCE/'dist')):digest(p) for p in (SOURCE/'dist').rglob('*') if p.is_file()}
            assert dist and json.loads((SOURCE/'package.json').read_text())['version']==VERSION
            save('build-inputs-candidate.json', {'pre_bump_commit':pre, 'capturedAt':now(), 'tracked_file_sha256':manifest, 'dist_sha256':dist, 'allowed_changes':['package.json','src-tauri/tauri.conf.json','src-tauri/Cargo.toml','src-tauri/Cargo.lock','CHANGELOG.md','CHANGELOG.zh-CN.md'], 'release_command':command, 'environment':environment})
            captured = True
        if not (TASK/'notary-app-submitted-archive.json').exists():
            matches = re.findall(r'Signing (/[^\n]+/note\.md\.zip)',text)
            if matches:
                path=Path(matches[-1].strip())
                if path.is_file():
                    save('notary-app-submitted-archive.json', {'stage':'signed App archive before notarization/stapling', 'path_observed_in_build_log':str(path), 'bytes':path.stat().st_size, 'sha256':digest(path), 'captured_at':now()})
        if not (TASK/'notary-dmg-submitted-archive.json').exists() and 'notarizing distributable DMG for aarch64' in text:
            path=Path('/tmp')/('note.md-'+VERSION+'-aarch64.dmg')
            if path.is_file():
                save('notary-dmg-submitted-archive.json', {'stage':'signed DMG submitted before stapling', 'path':str(path), 'bytes':path.stat().st_size, 'sha256':digest(path), 'captured_at':now()})
        time.sleep(0.5)
    save('release-exit.json', {'exitCode':process.returncode,'finishedAt':now(),'capturedInputs':captured})
    print(json.dumps({'exitCode':process.returncode,'capturedInputs':captured}))
    raise SystemExit(process.returncode)
