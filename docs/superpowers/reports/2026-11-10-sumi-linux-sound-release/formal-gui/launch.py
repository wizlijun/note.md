#!/usr/bin/env python3
"""Launch exact staged official host with read-only widget observer, no Pulse override."""
import argparse,hashlib,json,os,pathlib,subprocess
r=pathlib.Path(__file__).resolve().parent;repo=r.parents[1]
p=argparse.ArgumentParser();p.add_argument('--fixture',type=pathlib.Path,required=True);p.add_argument('--evidence',type=pathlib.Path,required=True);a=p.parse_args();f=a.fixture.resolve();e=a.evidence.resolve();assert f.is_relative_to(r) and e.is_relative_to(r)
s=json.loads((f/'release-selection.json').read_text());ready=json.loads((f/'ready.json').read_text());assert ready['release_selection']==s;assert s['tag'] in ['v6.1110.6','v6.1110.7']
binary=pathlib.Path(s['host_binary']);assert hashlib.sha256(binary.read_bytes()).hexdigest()==s['host_binary_sha256']
module=repo/'tasks/plugin-window-release/observer.so';e.mkdir(exist_ok=True,parents=True);(e/'observer').mkdir(exist_ok=True)
env=os.environ.copy()
for key in ['PULSE_SERVER','PULSE_RUNTIME_PATH','NOTEMD_INPUT_DIAGNOSTIC_DIR']:env.pop(key,None)
env['GTK_MODULES']=str(module);env['NOTEMD_WINDOW_AUDIT_DIR']=str(e/'observer')
proc=subprocess.Popen([str(f/'launch-host.sh'),str(binary)],env=env,stdout=(e/'host.log').open('a'),stderr=subprocess.STDOUT,start_new_session=True)
(e/'host-process.json').write_text(json.dumps({'pid':proc.pid,'tag':s['tag'],'host_binary_sha256':s['host_binary_sha256'],'observer_sha256':hashlib.sha256(module.read_bytes()).hexdigest(),'pulse_server_injected':False,'diagnostic_mutation_module_loaded':False},indent=2)+'\n');print(proc.pid)
