"""Verify then test this exact notarized package in temporary Vaults.
Default check never spawns the backend. --execute runs offline Cargo test drivers;
only synthetic test data is used and signing/account credentials are not inherited.
"""
from pathlib import Path
import argparse,datetime,hashlib,importlib.util,json,os,re,subprocess,tempfile,time
HERE=Path(__file__).resolve().parent
HOST_DRIVER='sumi::service::tests::actual_host_proxy_saves_rebinds_and_flushes_native_process'
HOST_SOURCES=['src-tauri/src/sumi/service.rs','src-tauri/src/sumi/durability.rs','src-tauri/src/sumi/journal.rs','src-tauri/src/plugin_runtime/process.rs']

def require(ok,message):
 if not ok:raise RuntimeError(message)
def sha(raw):return hashlib.sha256(raw).hexdigest()
def source(repo,commit,path):return subprocess.check_output(['git','-C',str(repo),'show',commit+':'+path])
def helper(repo,commit,path):
 target=repo/path;require(target.read_bytes()==source(repo,commit,path),'Probe helper differs from selected source: '+path)
 spec=importlib.util.spec_from_file_location('probe_'+target.stem.replace('-','_'),target);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

def prepare(args):
 require(re.fullmatch('[0-9a-f]{40}',args.source),'Exact source commit required')
 repo=args.repo.resolve();native=helper(repo,args.source,'scripts/sumi/native-release.py');verifier=helper(repo,args.source,'scripts/sumi/verify-release.py')
 receipt=json.loads((args.native_dir/'receipt.json').read_bytes());notary=(args.native_dir/'apple-notary-log.json').read_bytes()
 require(receipt.get('status')=='Accepted' and receipt.get('apple_log_sha256')==sha(notary),'Apple Accepted receipt missing or changed')
 require(receipt.get('team')=='T5G56DH47L' and receipt.get('target')=='aarch64-apple-darwin','Unexpected native team/target')
 native.accepted_ticket(json.loads(notary),receipt)
 expected=native.frozen_sources(args.source)
 require(receipt.get('source_sha256')==expected,'Native receipt differs from selected source inputs')
 for path,digest in expected.items():require(sha((repo/path).read_bytes())==digest,'Current test/product input differs: '+path)
 host={path:sha(source(repo,args.source,path)) for path in HOST_SOURCES}
 for path,digest in host.items():require(sha((repo/path).read_bytes())==digest,'Actual host driver differs: '+path)
 files=verifier.zip_files(args.package)
 require(files['manifest.json']==source(repo,args.source,'plugins-src/write/manifest.v2.json'),'Package manifest differs from selected source')
 manifest=json.loads(files['manifest.json']);require((manifest['id'],manifest['version'],manifest['engines']['notemd'])==('notemd.sumi','0.1.13','>=6.1110.8'),'Unexpected package identity')
 binary=args.native_dir/'notemd-sumi';require(binary.read_bytes()==files['bin/notemd-sumi'],'Packaged binary differs from notarized binary')
 inspected=native.inspect_binary(binary,'arm64','T5G56DH47L');require(inspected==receipt['binary'],'Notarized binary identity changed')
 key=re.search(rb'PLUGIN_REGISTRY_PUBKEY: &str =\s*"([^"]+)"',source(repo,args.source,'src-tauri/src/plugin_runtime/market.rs'))[1].decode()
 signed=subprocess.run(['minisign','-Vm',str(args.package),'-x',str(args.package)+'.minisig','-P',key],capture_output=True)
 require(signed.returncode==0,'Package Minisign verification failed')
 return {'receipt':receipt,'files':files,'nativeSources':expected,'hostSources':host,'binarySha256':inspected['sha256'],'binaryBytes':inspected['bytes'],'packageSha256':sha(args.package.read_bytes())}

def isolated_environment(binary):
 env={key:os.environ[key] for key in ['HOME','PATH','TMPDIR','LANG','CARGO_HOME','RUSTUP_HOME','SDKROOT'] if key in os.environ}
 env.update(RUSTUP_TOOLCHAIN='1.99.0',CARGO_BUILD_JOBS='2',CARGO_NET_OFFLINE='true',CARGO_TERM_COLOR='never',CARGO_PROFILE_DEV_DEBUG='0',CARGO_PROFILE_TEST_DEBUG='0',
            SUMI_TEST_BINARY=str(binary),SUMI_TEST_BACKEND=str(binary),SUMI_TEST_PACKAGED_SOUNDS='1',pnpm_config_verify_deps_before_run='false')
 return env

def successful_tests(log,required):
 passed=set(re.findall(r'^test ([\w:]+) \.\.\. ok\s*$',log,re.M))
 require('test result: ok.' in log and set(required)<=passed,'Expected semantic tests did not all pass (zero-test runs are rejected)')
 return sorted(passed)

def suites(repo,host_target):
 backend=repo/'plugins-src/write/backend/target'
 return [
  ('signed-stdio',['/Users/bruce/git/mdeditor/plugins-src/write/backend/target/debug/deps/stdio-5442d1830ea5803a','--nocapture'],
   ['real_stdio_advertises_and_serves_atomic_observation','real_stdio_commit_kill_reopen_replay_and_private_boundary'],backend,'exact signed package binary; actual kill/reopen and observation RPC'),
  ('host-journal-crash',['/Users/bruce/git/mdeditor/plugins-src/write/backend/target/debug/deps/notemd_sumi_backend-c02c6cf3a45c2042','host_proxy_harness','--nocapture'],
   ['host_proxy_harness::host_sigkill_before_backend_commit_recovers_accepted_input_on_first_load','host_proxy_harness::host_sigkill_after_backend_commit_before_ack_replays_exactly_once','host_proxy_harness::journaled_import_survives_host_crash_and_new_external_files_without_blocking_load'],backend,'compiled production host proxy plus real SQLite worker; test-driver subprocess SIGKILL, not a claim these subprocesses are the signed backend'),
  ('signed-host-proxy',['/Users/bruce/git/mdeditor/src-tauri/target/debug/deps/notemd_lib-7596bddb9d0ec10e',HOST_DRIVER,'--exact','--ignored','--nocapture','--test-threads=1'],
   [HOST_DRIVER],host_target,'actual host transport spawns the exact signed package via SUMI_TEST_BACKEND; isolated Vault and process rebind')]

def main():
 parser=argparse.ArgumentParser(description=__doc__)
 parser.add_argument('--repo',type=Path,required=True);parser.add_argument('--source',required=True)
 parser.add_argument('--native-dir',type=Path,required=True);parser.add_argument('--package',type=Path,required=True)
 parser.add_argument('--host-target-dir',type=Path,required=True,help='Explicit test cache, different from any actively building release target')
 parser.add_argument('--output-dir',type=Path,default=HERE/'signed-probe');parser.add_argument('--execute',action='store_true')
 args=parser.parse_args();args.repo=args.repo.resolve();args.native_dir=args.native_dir.resolve();args.package=args.package.resolve();args.host_target_dir=args.host_target_dir.resolve();args.output_dir=args.output_dir.resolve()
 prepared=prepare(args)
 if not args.execute:
  print(json.dumps({'ok':True,'binary_sha256':prepared['binarySha256'],'source':args.source,'spawned':False,'executeRequired':True}));return
 require(not args.output_dir.exists(),'Probe evidence already exists; preserve it before a deliberate new run')
 args.output_dir.mkdir(parents=True)
 outcomes=[]
 with tempfile.TemporaryDirectory(prefix='sumi-notarized-isolated-package-') as temporary:
  installed=Path(temporary)
  for name,raw in prepared['files'].items():
   path=installed/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(raw);path.chmod(0o755 if name=='bin/notemd-sumi' else 0o644)
  binary=installed/'bin/notemd-sumi'
  sounds=helper(args.repo,args.source,'scripts/sumi/verify-sounds.py');sounds.validate(installed/'resources/sounds')
  env=isolated_environment(binary)
  for name,command,required,target,scope in suites(args.repo,args.host_target_dir):
   task_env={**env,'CARGO_TARGET_DIR':str(target)};path=args.output_dir/(name+'.log');start=time.monotonic()
   with path.open('w') as log:result=subprocess.run(command,cwd=args.repo,env=task_env,stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT,timeout=1800)
   require(result.returncode==0,'Isolated suite failed; inspect '+str(path))
   raw=path.read_text();passed=successful_tests(raw,required)
   outcome={'suite':name,'command':command,'testDriverSha256':sha(Path(command[0]).read_bytes()),'passed':passed,'count':len(passed),'exitCode':0,'elapsedSeconds':round(time.monotonic()-start,3),'logSha256':sha(path.read_bytes()),'scope':scope}
   outcomes.append(outcome);print(json.dumps({'suite':name,'passed':len(passed),'exitCode':0}),flush=True)
  require(sha(binary.read_bytes())==prepared['binarySha256'],'Installed binary changed during probe')
  for path,digest in {**prepared['nativeSources'],**prepared['hostSources']}.items():require(sha((args.repo/path).read_bytes())==digest,'Test/product source changed during probe: '+path)
 report={'ok':True,'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'source':prepared['receipt']['source_commit'],'selectedSource':args.source,
  'binary_sha256':prepared['binarySha256'],'binary_bytes':prepared['binaryBytes'],'package_sha256':prepared['packageSha256'],
  'spawned':True,'exit_code':0,'isolated_vault':True,'network_started':False,'account_access':False,'cargoOffline':True,
  'packaged_sound_banks':['typewriter','thock'],'sound_samples_scheduled':0,'suites':outcomes,'host_driver_source_sha256':prepared['hostSources'],
  'wrapperSha256':sha(Path(__file__).read_bytes()),'scope':'Real notarized packaged binary executed by stdio and host transport drivers; host journal SIGKILL tested separately with compiled production proxy and SQLite worker. Synthetic temporary Vaults only; child credentials excluded.'}
 (args.output_dir/'actual-native-process-probe.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
 print(json.dumps({'ok':True,'binary_sha256':report['binary_sha256'],'spawned':True,'exit_code':0,'isolated_vault':True,'report':str(args.output_dir/'actual-native-process-probe.json')}),flush=True)
if __name__=='__main__':main()
