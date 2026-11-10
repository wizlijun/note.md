#!/usr/bin/env python3
"""Launch only exact staged official bytes with an explicit read-only module allowlist."""
import hashlib,json,os,pathlib,subprocess
r=pathlib.Path(__file__).resolve().parent;repo=r.parents[1];f=r/'fixture';selection=json.loads((f/'release-selection.json').read_text());ready=json.loads((f/'ready.json').read_text());assert ready['release_selection']==selection;assert selection['tag']=='v6.1110.6'
binary=pathlib.Path(selection['host_binary']);assert hashlib.sha256(binary.read_bytes()).hexdigest()==selection['host_binary_sha256']
modules=[repo/'tasks/plugin-window-release/observer.so',repo/'tasks/sumi-focus-v5/frame-observer.so',r/'input-observer.so'];assert all('diagnostic' not in str(p) and 'probe.so' not in str(p) for p in modules)
e=r/'evidence';e.mkdir(exist_ok=True);(e/'observer').mkdir(exist_ok=True);(e/'frames').mkdir(exist_ok=True)
env=os.environ.copy();env.pop('NOTEMD_INPUT_DIAGNOSTIC_DIR',None);env['GTK_MODULES']=':'.join(map(str,modules));env['NOTEMD_WINDOW_AUDIT_DIR']=str(e/'observer');env['NOTEMD_FOCUS_AUDIT_DIR']=str(e/'frames');env['NOTEMD_INPUT_AUDIT_FILE']=str(e/'input-events.jsonl')
p=subprocess.Popen([str(f/'launch-host.sh'),str(binary)],env=env,stdout=(e/'host.log').open('a'),stderr=subprocess.STDOUT,start_new_session=True)
(r/'host-process.json').write_text(json.dumps({'pid':p.pid,'tag':selection['tag'],'host_binary_sha256':selection['host_binary_sha256'],'diagnostic_mutation_module_loaded':False,'read_only_modules_sha256':{str(m):hashlib.sha256(m.read_bytes()).hexdigest() for m in modules}},indent=2)+'\n');print(p.pid)
