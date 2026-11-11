#!/usr/bin/env python3
"""Actual packaged host -> signed backend -> private null-sink PCM acceptance."""
import argparse,array,hashlib,json,os,pathlib,shlex,signal,subprocess,sys,time
import private as p
R=pathlib.Path(__file__).resolve().parent;F=R/'fixture';E=R/'evidence';E.mkdir(exist_ok=True)
REPO=pathlib.Path('/home/bruce/git/note.md')
parser=argparse.ArgumentParser()
parser.add_argument('--version',required=True)
parser.add_argument('--deb',type=pathlib.Path,required=True)
parser.add_argument('--source-commit',required=True)
parser.add_argument('--addon',type=pathlib.Path,required=True)
parser.add_argument('--addon-sha',required=True)
parser.add_argument('--addon-commit',required=True)
parser.add_argument('--expect',choices=['old','new'],required=True)
args=parser.parse_args()
deb=args.deb.resolve(strict=True);commit=args.source_commit
assert subprocess.check_output(['git','-C',str(REPO),'rev-parse','v'+args.version+'^{commit}'],text=True).strip()==commit
assert not F.exists(),'Fresh fixture required; retain existing evidence'
subprocess.run(['python3',str(R/'prepare.py'),'--deb',str(deb),'--source-commit',commit,'--addon',str(args.addon),'--addon-sha',args.addon_sha,'--addon-commit',args.addon_commit],check=True)
supervisor=F/'supervisor.py';supervisor.write_text(supervisor.read_text().replace('"GTK_IM_MODULE": "fcitx"','"GTK_IM_MODULE": "wayland"'))
processes=[];host=None;rec=None;capture=None;result={'passed':False,'version':args.version,'expected_behavior':args.expect,'addon_sha256':args.addon_sha,'addon_source_commit':args.addon_commit,'source_commit':commit,'private_audio_only':True,'hardware_audio_devices_opened':False,'user_audio_settings_modified':False}
def stop(proc):
 if proc is not None and proc.poll() is None:
  proc.terminate()
  try:proc.wait(5)
  except subprocess.TimeoutExpired:proc.kill();proc.wait(5)
def wait_for(check,seconds=20):
 deadline=time.monotonic()+seconds
 while time.monotonic()<deadline:
  value=check()
  if value:return value
  time.sleep(.1)
 raise RuntimeError('Timed out: '+getattr(check,'__name__','condition'))
def peak(raw):
 values=array.array('f');values.frombytes(raw[:len(raw)//4*4])
 if sys.byteorder!='little':values.byteswap()
 return max((abs(v) for v in values),default=0.)
def textviews():
 path=E/'observer/gtk-tree.jsonl'
 if not path.exists():return []
 try:rows=[json.loads(line) for line in path.read_text().splitlines()]
 except json.JSONDecodeError:return []
 return [r for r in rows if r.get('type')=='GtkTextView' and r.get('mapped')]
def preedit():
 path=E/'observer/preedit.jsonl'
 return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []
try:
 subprocess.run(['python3',str(F/'control.py'),'start'],check=True)
 ready=json.loads((F/'ready.json').read_text());selection=json.loads((F/'release-selection.json').read_text())
 introspection=(F/'addon-introspection.txt').read_text();result['typing_bridge_available']='SetActiveWithTyping' in introspection and 'TypingKey' in introspection
 assert result['typing_bridge_available']==(args.expect=='new')
 result['mapped_addon_sha256']=ready['addon_sha256']
 result['keyboard_helper_sha256']=hashlib.sha256((R/'input-tools/keyboard').read_bytes()).hexdigest()
 result['keyboard_source_sha256']=hashlib.sha256((R/'input-tools/keyboard.source.c').read_bytes()).hexdigest()
 if args.expect=='new':assert (R/'input-tools/keyboard.source.c').read_bytes()==subprocess.check_output(['git','-C',str(REPO),'show',commit+':scripts/sumi/probe-pointer/keyboard.c'])
 env=os.environ.copy()
 for key in ['DISPLAY','WAYLAND_DISPLAY','SWAYSOCK','HYPRLAND_INSTANCE_SIGNATURE','PULSE_SERVER','PULSE_SINK','PIPEWIRE_REMOTE','PIPEWIRE_RUNTIME_DIR']:env.pop(key,None)
 for line in (F/'environment.sh').read_text().splitlines():
  words=shlex.split(line)
  if words and words[0]=='export':key,value=words[1].split('=',1);env[key]=value
 assert env['XDG_RUNTIME_DIR']==ready['runtime'] and env['GTK_IM_MODULE']=='wayland'
 env['PIPEWIRE_RUNTIME_DIR']=ready['runtime'];env['PULSE_SERVER']='unix:'+str(pathlib.Path(ready['runtime'])/'pulse/native')
 def run(args,**kw):return subprocess.run(args,env=env,check=True,capture_output=True,text=True,**kw)
 def plist(kind):return json.loads(run(['pactl','-f','json','list',kind]).stdout)
 for command in [['pipewire'],['wireplumber','--profile','policy'],['pipewire-pulse']]:
  proc=subprocess.Popen(command,env=env,stdout=(E/(command[0]+'.log')).open('w'),stderr=subprocess.STDOUT);processes.append(proc);time.sleep(.3);assert proc.poll() is None
 wait_for(lambda:pathlib.Path(ready['runtime'],'pulse/native').is_socket())
 run(['pactl','load-module','module-null-sink','sink_name=sumi_audit'])
 wait_for(lambda:plist('sinks'))
 run(['pactl','set-default-sink','sumi_audit'])
 sinks=plist('sinks');assert len(sinks)==1 and sinks[0]['name']=='sumi_audit'
 result['private_pulse_server']=env['PULSE_SERVER'];result['private_sinks']=sinks
 (E/'observer').mkdir(exist_ok=True)
 host_env=env.copy();host_env.update(GTK_MODULES=str(R/'observer.so'),NOTEMD_WINDOW_AUDIT_DIR=str(E/'observer'))
 binary=pathlib.Path(selection['host_binary']);assert hashlib.sha256(binary.read_bytes()).hexdigest()==selection['host_binary_sha256']
 host=subprocess.Popen([str(F/'launch-host.sh'),str(binary),'--action','plugin:notemd.sumi:main'],env=host_env,stdout=(E/'host.log').open('w'),stderr=subprocess.STDOUT,start_new_session=True)
 (E/'host-process.json').write_text(json.dumps({'pid':host.pid,'source_commit':commit,'host_binary_sha256':selection['host_binary_sha256']},indent=2)+'\n')
 view=wait_for(textviews,40)[0]
 windows=p.windows();(E/'initial-windows.json').write_text(json.dumps(windows,indent=2)+'\n')
 window=next(w for w in windows if 'Sumi' in (w.get('name') or '') or '玄霜' in (w.get('name') or ''))
 rect=window['rect'];xy=view['toplevelPosition'];a=view['allocation']
 p.click(rect['x']+xy[0]+a[2]/2,rect['y']+xy[1]+a[3]/2)
 time.sleep(1)
 def sumi_streams():return [s for s in plist('sink-inputs') if s.get('properties',{}).get('application.name')=='Sumi']
 stream=wait_for(sumi_streams,20)[0];pid=int(stream['properties']['application.process.id'])
 backend=pathlib.Path(f'/proc/{pid}/exe');actual_backend=hashlib.sha256(backend.read_bytes()).hexdigest()
 assert actual_backend==selection['plugin_files_sha256']['bin/notemd-sumi']
 assert pathlib.Path(os.readlink(backend))==pathlib.Path(selection['plugin_directory'])/'bin/notemd-sumi'
 result.update(host_pid=host.pid,host_binary_sha256=selection['host_binary_sha256'],deb_sha256=selection['deb_sha256'],plugin_version=selection['plugin_version'],plugin_backend_sha256=actual_backend,plugin_signature_verification=selection['plugins'][0]['signature_verification'],stream=stream)
 # Activate the real private Fcitx pinyin engine before baseline recording.
 for method,im_args in [('SetCurrentIM',['pinyin']),('Activate',[])]:
  run(['gdbus','call','--session','--dest','org.fcitx.Fcitx5','--object-path','/controller','--method','org.fcitx.Fcitx.Controller1.'+method,*im_args])
 time.sleep(.5)
 pcm=E/'own-stream.f32le';capture=pcm.open('wb')
 rec=subprocess.Popen(['parec','--raw','--format=float32le','--rate=48000','--channels=1','--latency-msec=20','--device=sumi_audit.monitor','--monitor-stream='+str(stream['index'])],env=env,stdout=capture,stderr=(E/'recorder.log').open('w'))
 wait_for(lambda:pcm.stat().st_size>=48000*4*.3)
 baseline_bytes=pcm.stat().st_size;baseline_peak=peak(pcm.read_bytes());assert baseline_peak<1e-7,baseline_peak
 stages=[]
 def document():
  path=E/'observer/document.jsonl'
  if path.exists():
   lines=path.read_text().splitlines()
   if lines:return json.loads(lines[-1])['text']
  views=textviews();return views[0]['text'] if views else None
 def stage(name,key,expected_document,expected_preedit,old_audible):
  # Separate each gesture by a silent interval; no prior key tail may count.
  time.sleep(.3);before=pcm.stat().st_size;p.key(key);key_finished_us=int(time.time()*1000000)
  def input_settled():
   # Observe a fresh real GTK main-loop sample, not an assumed IM latency.
   path=E/'observer/gtk-tree.jsonl'
   if not path.exists():return False
   try:sample=json.loads(path.read_text().splitlines()[0])
   except (ValueError,IndexError):return False
   events=preedit();current=events[-1]['preedit'] if events else ''
   return sample.get('timeUs',0)>key_finished_us and document()==expected_document and (expected_preedit is None or current==expected_preedit)
  wait_for(input_settled,8);time.sleep(.35);after=pcm.stat().st_size
  events=preedit();actual_preedit=events[-1]['preedit'] if events else ''
  actual_doc=document()
  assert actual_doc==expected_document,(name,'document',actual_doc,expected_document)
  if expected_preedit is not None:assert actual_preedit==expected_preedit,(name,'preedit',actual_preedit,expected_preedit)
  value=peak(pcm.read_bytes()[before:after]);audible=args.expect=='new' or old_audible
  stages.append({'name':name,'key':key,'from_byte':before,'to_byte':after,'peak':value,'preedit':actual_preedit,'document_text':actual_doc,'expected_audible':audible})
  (R/'stages-progress.json').write_text(json.dumps(stages,ensure_ascii=False,indent=2)+'\n')
  assert (value>1e-7) if audible else (value<1e-7),(name,'audio',value,audible)
 for letter,value in zip('nihao',['n','ni','ni h','ni ha','ni hao']):stage('pinyin-'+letter,letter,'',value,True)
 p.capture('composition-before-commit')
 stage('space-select','Space','你好','',False)
 stage('chinese-period','.','你好。','',False)
 stage('chinese-comma',',','你好。，','',False)
 stage('return-compose-n','n','你好。，','n',True)
 stage('return-compose-i','i','你好。，','ni',True)
 stage('return-confirm','Return','你好。，ni','',False)
 stage('delete-compose-n','n','你好。，ni','n',True)
 stage('delete-compose-i','i','你好。，ni','ni',True)
 stage('delete-nonempty','BackSpace','你好。，ni','n',True)
 stage('delete-to-empty','BackSpace','你好。，ni','',False)
 for letter,value in zip('nihao',['n','ni','ni h','ni ha','ni hao']):stage('navigation-compose-'+letter,letter,'你好。，ni',value,True)
 stage('left-navigation','Left','你好。，ni','ni hao',False)
 stage('right-navigation','Right','你好。，ni','ni hao',False)
 stage('numeric-selection','1','你好。，ni你好','',False)
 p.capture('committed')
 run(['gdbus','call','--session','--dest','org.fcitx.Fcitx5','--object-path','/controller','--method','org.fcitx.Fcitx.Controller1.Deactivate'])
 time.sleep(.2)
 stage('latin-positive-control','x','你好。，ni你好x','',True)
 result['latin_positive_control_peak']=stages[-1]['peak']
 stop(rec);capture.close();capture=None
 result.update(passed=True,baseline_peak=baseline_peak,baseline_bytes=baseline_bytes,key_stages=stages,committed_text=document(),pcm_sha256=hashlib.sha256(pcm.read_bytes()).hexdigest(),pcm_bytes=pcm.stat().st_size,im_module='wayland')
finally:
 stop(rec)
 if capture:capture.close()
 if host and host.poll() is None:
  os.killpg(host.pid,signal.SIGTERM)
  try:host.wait(5)
  except subprocess.TimeoutExpired:os.killpg(host.pid,signal.SIGKILL);host.wait(5)
 for proc in reversed(processes):stop(proc)
 subprocess.run(['python3',str(F/'control.py'),'stop'],check=True)
 result['private_fixture_stopped']=not (F/'ready.json').exists();result['private_audio_processes_stopped']=all(proc.poll() is not None for proc in processes)
 if 'stream' in result:result['plugin_backend_exited']=not pathlib.Path('/proc/'+result['stream']['properties']['application.process.id']).exists()
 (R/'verification.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({k:v for k,v in result.items() if k not in ['private_sinks','stream']},indent=2))
