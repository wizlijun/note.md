#!/usr/bin/env python3
"""Sumi-only Developer ID/notary gate. Signing requires --sign-and-notarize.
No upload to the marketplace. Credentials are never printed or included in receipts.
"""
import argparse, hashlib, json, os, re, shutil, subprocess, zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
IDENTIFIER = 'net.notemd.sumi.backend'
TARGETS = {'aarch64-apple-darwin': 'arm64', 'x86_64-apple-darwin': 'x86_64'}
SOURCE_DIRS = ['plugins-src/write/backend', 'sumi-protocol', 'write-core', 'notemd-plugin-sdk', 'plugin-protocol', 'plugins-src/write/resources/sumi', 'scripts/sumi/native-release.py', 'scripts/release-plugins.sh', 'plugins-src/write/manifest.v2.json', 'plugins-src/write/package.json', 'plugins-src/write/vite.config.ts']


def require(ok, message):
    if not ok: raise RuntimeError(message)


def sha(raw): return hashlib.sha256(raw).hexdigest()


def run(command, timeout=120):
    # Do not echo commands: notary authentication arguments contain credentials.
    result = subprocess.run(command, capture_output=True, text=True, timeout=timeout)
    require(result.returncode == 0, Path(command[0]).name + ' failed; operation stopped (credentials/output suppressed)')
    return result.stdout, result.stderr


def frozen_sources(commit):
    paths = subprocess.check_output(['git', '-C', str(ROOT), 'ls-tree', '-r', '--name-only', commit, '--', *SOURCE_DIRS], text=True).splitlines()
    require(paths and 'plugins-src/write/backend/src/main.rs' in paths, 'Frozen backend main missing')
    return {p: sha(subprocess.check_output(['git', '-C', str(ROOT), 'show', commit+':'+p])) for p in paths}


def signature_identity(text, team):
    def field(name):
        match = re.search(r'^'+name+r'=(.+)$', text, re.M)
        require(match is not None, 'Signature field missing: '+name)
        return match[1]
    require(field('Identifier') == IDENTIFIER, 'Wrong native signing identifier')
    require(field('TeamIdentifier') == team, 'Wrong native signing team')
    require(re.search(r'^Authority=Developer ID Application:', text, re.M), 'Developer ID Application signature required')
    require(re.search(r'^CodeDirectory .*(?:\(|,)runtime(?:\)|,)', text, re.M), 'Hardened runtime required')
    require(re.search(r'^Timestamp=.+$', text, re.M), 'Secure timestamp required')
    cdhash = field('CDHash')
    require(re.fullmatch('[0-9a-f]{40,64}', cdhash), 'Invalid native CDHash')
    return {'identifier': IDENTIFIER, 'team': team, 'cdhash': cdhash, 'runtime': True, 'timestamp': True}


def inspect_binary(binary, arch, team):
    require(binary.is_file() and not binary.is_symlink(), 'Missing/unsafe native binary')
    require(run(['/usr/bin/lipo', '-archs', str(binary)])[0].strip() == arch, 'Wrong native CPU')
    run(['/usr/bin/codesign', '--verify', '--strict', '--verbose=2', str(binary)])
    out, err = run(['/usr/bin/codesign', '-d', '--verbose=4', str(binary)])
    return {**signature_identity(out+err, team), 'sha256': sha(binary.read_bytes()), 'bytes': binary.stat().st_size, 'architecture': arch}


def accepted_ticket(log, receipt):
    require(log.get('status') == 'Accepted' and log.get('statusCode') == 0, 'Apple notarization not Accepted')
    require(log.get('jobId') == receipt['submission_id'], 'Wrong notarization job')
    require(log.get('sha256') == receipt['archive_sha256'], 'Notarized archive digest differs')
    require(any(t.get('cdhash') == receipt['binary']['cdhash'] and t.get('arch') == receipt['binary']['architecture'] for t in log.get('ticketContents', [])), 'Apple ticket does not cover final native CDHash/CPU')


def assessment(binary):
    result = subprocess.run(['/usr/sbin/spctl', '--assess', '--type', 'execute', '--verbose=4', str(binary)], capture_output=True, text=True, timeout=120)
    text = result.stdout+result.stderr
    return {'exit_code': result.returncode, 'stdout': result.stdout, 'stderr': result.stderr,
            'notarized_developer_id': result.returncode == 0 and 'Notarized Developer ID' in text,
            'scope': 'Raw CLI assessment is recorded verbatim; nonzero is not converted to success. Apple Accepted/CDHash binding is independently required; actual isolated process acceptance remains required.'}


def execute(args):
    require(args.target in TARGETS, 'Unsupported native target')
    require(re.fullmatch('[0-9a-f]{40}', args.source or ''), 'Exact frozen source commit required')
    team = os.environ.get('APPLE_TEAM_ID', '')
    require(re.fullmatch('[A-Z0-9]{10}', team), 'APPLE_TEAM_ID required')
    identity = os.environ.get('APPLE_SIGNING_IDENTITY', '')
    require(identity.startswith('Developer ID Application:') and '('+team+')' in identity, 'Explicit matching Developer ID Application identity required')
    auth = []
    if os.environ.get('SUMI_NOTARY_PROFILE'):
        auth = ['--keychain-profile', os.environ['SUMI_NOTARY_PROFILE']]
    else:
        require(all(os.environ.get(k) for k in ['APPLE_ID','APPLE_PASSWORD']), 'Notary credentials or SUMI_NOTARY_PROFILE required')
        auth = ['--apple-id', os.environ['APPLE_ID'], '--password', os.environ['APPLE_PASSWORD'], '--team-id', team]
    sources = frozen_sources(args.source)
    for path, digest in sources.items():
        require((ROOT/path).is_file() and sha((ROOT/path).read_bytes()) == digest, 'Working source differs from frozen source: '+path)
    original = args.binary.resolve(strict=True)
    input_sha = sha(original.read_bytes())
    require(not any(p.is_symlink() for p in [args.output_dir, *args.output_dir.parents]), 'Unsafe native evidence directory')
    out = args.output_dir.resolve()
    state_path = out/'state.json'
    binary = out/'notemd-sumi'
    archive = out/'notemd-sumi-notary.zip'
    if state_path.exists():
        state = json.loads(state_path.read_text())
        require(state['input_sha256'] == input_sha and state['source_sha256'] == sources and state['team'] == team and state['target'] == args.target, 'Existing native evidence belongs to different inputs; do not overwrite')
        require(inspect_binary(binary, TARGETS[args.target], team) == state['binary'], 'Signed binary changed before resume')
        require(sha(archive.read_bytes()) == state['archive_sha256'], 'Notary archive changed before resume')
    else:
        require(not out.exists() or not any(out.iterdir()), 'Partial native evidence exists without state; review before retry')
        out.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(original, binary);binary.chmod(0o755)
        run(['/usr/bin/codesign', '--force', '--options', 'runtime', '--timestamp', '--identifier', IDENTIFIER, '--sign', identity, str(binary)])
        inspected = inspect_binary(binary, TARGETS[args.target], team)
        with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED) as z:
            z.write(binary, 'notemd-sumi')
        state = {'schema':1, 'source_commit':args.source, 'source_sha256':sources, 'team':team, 'target':args.target,
                 'input_sha256':input_sha, 'binary':inspected, 'archive_sha256':sha(archive.read_bytes()), 'submission_id':None}
        state_path.write_text(json.dumps(state,indent=2)+'\n')
    if not state['submission_id']:
        # A failed/ambiguous submit must never silently be repeated. Preserve an
        # attempt marker even if transport fails before returning Apple's job ID.
        attempt = out/'submission-attempt.json'
        require(not attempt.exists(), 'Previous submit outcome unknown; recover its Apple job ID before retry (no automatic resubmission)')
        attempt.write_text(json.dumps({'archive_sha256':state['archive_sha256'], 'source_commit':args.source})+'\n')
        stdout, _ = run(['/usr/bin/xcrun','notarytool','submit',str(archive),*auth,'--output-format','json'], timeout=600)
        submitted = json.loads(stdout)
        require(re.fullmatch(r'[0-9a-fA-F-]{36}', submitted.get('id','')), 'Apple did not return a submission ID')
        state['submission_id'] = submitted['id'];state_path.write_text(json.dumps(state,indent=2)+'\n')
    job = state['submission_id']
    stdout, _ = run(['/usr/bin/xcrun','notarytool','wait',job,*auth,'--output-format','json','--timeout','20m'], timeout=1230)
    require(json.loads(stdout).get('status') == 'Accepted', 'Notary wait is not Accepted; preserve this job and stop')
    log_path = out/'apple-notary-log.json'
    run(['/usr/bin/xcrun','notarytool','log',job,str(log_path),*auth], timeout=120)
    log = json.loads(log_path.read_text());accepted_ticket(log,state)
    require(inspect_binary(binary,TARGETS[args.target],team) == state['binary'], 'Final native signature changed')
    state.update(status='Accepted', apple_log_sha256=sha(log_path.read_bytes()), spctl=assessment(binary))
    (out/'receipt.json').write_text(json.dumps(state,indent=2)+'\n')
    print(json.dumps({'ok':True,'status':'Accepted','receipt':str(out/'receipt.json'),'signed_binary':str(binary),'spctl_accepted':state['spctl']['notarized_developer_id']}))


def self_test():
    def reject(f):
        try: f()
        except RuntimeError: return
        raise RuntimeError('Negative signature fixture accepted')
    good='Identifier='+IDENTIFIER+'\nTeamIdentifier=ABCDEFGHIJ\nAuthority=Developer ID Application: Example (ABCDEFGHIJ)\nCodeDirectory v=20500 size=123 flags=0x10000(runtime) hashes=1+2\nTimestamp=Nov 8, 2026\nCDHash='+'a'*40+'\n'
    sig=signature_identity(good,'ABCDEFGHIJ')
    for old,new in [('ABCDEFGHIJ','ZZZZZZZZZZ'),('Developer ID Application:','Apple Development:'),('(runtime)','(adhoc)'),('Timestamp=','Signed Time='),('Identifier='+IDENTIFIER,'Identifier=wrong')]:
        reject(lambda old=old,new=new:signature_identity(good.replace(old,new),'ABCDEFGHIJ'))
    receipt={'submission_id':'job','archive_sha256':'digest','binary':{**sig,'architecture':'arm64'}}
    log={'status':'Accepted','statusCode':0,'jobId':'job','sha256':'digest','ticketContents':[{'cdhash':'a'*40,'arch':'arm64'}]}
    accepted_ticket(log,receipt)
    for key,value in [('status','Invalid'),('statusCode',1),('jobId','other'),('sha256','changed'),('ticketContents',[])]:
        reject(lambda key=key,value=value:accepted_ticket({**log,key:value},receipt))
    reject(lambda:accepted_ticket({**log,'ticketContents':[{'cdhash':'a'*40,'arch':'x86_64'}]},receipt))
    return {'ok':True,'checks':['DeveloperID-team-runtime-timestamp-identifier','Apple-Accepted-job-archive-CDHash-CPU-binding'],'externalMutations':False}


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--self-test',action='store_true');p.add_argument('--sign-and-notarize',action='store_true')
    p.add_argument('--binary',type=Path);p.add_argument('--target',choices=TARGETS);p.add_argument('--source');p.add_argument('--output-dir',type=Path)
    a=p.parse_args()
    try:
        if a.self_test:print(json.dumps(self_test()));return 0
        require(a.sign_and_notarize and a.binary and a.target and a.source and a.output_dir, 'Explicit --sign-and-notarize and all frozen inputs required')
        execute(a);return 0
    except Exception as e:
        # Timeout exceptions contain command arguments. Never print repr(e).
        message='Operation timed out; preserve existing job/evidence and resume' if isinstance(e,subprocess.TimeoutExpired) else str(e) if isinstance(e,RuntimeError) else type(e).__name__
        print(json.dumps({'ok':False,'error':message}));return 1
if __name__=='__main__':raise SystemExit(main())
