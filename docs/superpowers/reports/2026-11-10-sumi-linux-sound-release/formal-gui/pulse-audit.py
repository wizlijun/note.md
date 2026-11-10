#!/usr/bin/env python3
"""Fixture-only Pulse bridge and capture of an exact authenticated child stream."""
import argparse,array,hashlib,json,os,pathlib,signal,stat,subprocess,time
ROOT=pathlib.Path(__file__).resolve().parent
REPO=ROOT.parents[1]
def digest(p):return hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
def save(p,x):p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(x,indent=2)+'\n')
def process(pid):
 p=pathlib.Path('/proc')/str(pid)
 fields=(p/'stat').read_text().rsplit(') ',1)[1].split()
 return {'pid':pid,'ppid':int(fields[1]),'start_time':fields[19],'exe_sha256':digest(p/'exe')}
def fixture(path):
 f=path.resolve();assert f.is_relative_to(REPO/'tasks')
 ready=json.loads((f/'ready.json').read_text());sel=json.loads((f/'release-selection.json').read_text());assert ready['release_selection']==sel
 sup=process(ready['supervisor']['pid']);assert sup['start_time']==ready['supervisor']['start_time']
 runtime=pathlib.Path(ready['runtime']);assert runtime.is_dir() and runtime.stat().st_uid==os.getuid()
 return f,ready,sel,runtime
def pulse(server,*args):return subprocess.check_output(['pactl','--server='+server,*args],text=True)
def validate_child(host,child,sel,runtime):
 h=process(host);c=process(child);assert h['exe_sha256']==sel['host_binary_sha256']
 expected=next(p for p in sel['plugins'] if p['id']=='notemd.sumi')['files_sha256']['bin/notemd-sumi'];assert c['exe_sha256']==expected
 p=child
 for _ in range(10):
  if p==host:break
  p=process(p)['ppid']
 else:raise RuntimeError('backend is not a descendant of this formal host')
 env=dict(x.split(b'=',1) for x in (pathlib.Path('/proc')/str(child)/'environ').read_bytes().split(b'\0') if b'=' in x)
 return h,c,{'XDG_RUNTIME_DIR':env.get(b'XDG_RUNTIME_DIR',b'').decode(),'PULSE_SERVER_present':b'PULSE_SERVER' in env,'private_runtime_expected':str(runtime)}
def main():
 def interrupted(signum,frame):raise KeyboardInterrupt('capture interrupted; restoring own stream')
 signal.signal(signal.SIGTERM,interrupted)
 ap=argparse.ArgumentParser();ap.add_argument('action',choices=['bridge','inspect','record']);ap.add_argument('--fixture',type=pathlib.Path,required=True);ap.add_argument('--host-pid',type=int);ap.add_argument('--backend-pid',type=int);ap.add_argument('--output',type=pathlib.Path,required=True);ap.add_argument('--seconds',type=float,default=8);a=ap.parse_args()
 f,ready,sel,runtime=fixture(a.fixture);out=a.output.resolve();assert out.is_relative_to(ROOT);out.mkdir(parents=True,exist_ok=True)
 real=pathlib.Path('/run/user')/str(os.getuid())/'pulse/native';assert stat.S_ISSOCK(real.stat().st_mode) and real.stat().st_uid==os.getuid()
 link=runtime/'pulse/native';server='unix:'+str(real)
 if a.action=='bridge':
  link.parent.mkdir(mode=0o700,exist_ok=True)
  if link.is_symlink():assert link.resolve()==real
  else:assert not link.exists();link.symlink_to(real)
  save(out/'pulse-bridge.json',{'fixture':str(f),'private_runtime':str(runtime),'link':str(link),'target':str(real),'same_uid':os.getuid(),'production_modification':False,'host_PULSE_SERVER_injected':False});return
 assert link.is_symlink() and link.resolve()==real
 assert a.host_pid and a.backend_pid
 h,c,env=validate_child(a.host_pid,a.backend_pid,sel,runtime)
 streams=[s for s in json.loads(pulse(server,'--format=json','list','sink-inputs')) if s.get('properties',{}).get('application.process.id')==str(a.backend_pid) and s.get('properties',{}).get('application.name')=='Sumi']
 report={'host':h,'backend':c,'backend_environment':env,'streams':streams,'monotonic_ns':time.monotonic_ns()}
 save(out/'stream-inspection.json',report)
 if a.action=='inspect':print(json.dumps(report));return
 assert env['XDG_RUNTIME_DIR']==str(runtime) and not env['PULSE_SERVER_present'];assert len(streams)==1
 stream=streams[0];idx=stream['index'];sink=next(s for s in json.loads(pulse(server,'--format=json','list','sinks')) if s['index']==stream['sink'])
 # Revalidate identity immediately before touching only this stream's volume.
 assert process(a.backend_pid)==c
 fresh=next(s for s in json.loads(pulse(server,'--format=json','list','sink-inputs')) if s['index']==idx);assert fresh['properties']['application.process.id']==str(a.backend_pid)
 original={'volume':[v['value'] for v in fresh['volume'].values()],'mute':fresh['mute']}
 save(out/'original-volume.json',original)
 monitor=sink.get('monitor_source_name',sink.get('monitor_source'));assert isinstance(monitor,str)
 cmd=['parec','--server='+server,'--monitor-stream='+str(idx),'--device='+monitor,'--client-name=Sumi-private-release-audit','--stream-name=Only-Sumi-test-stream','--raw','--format=float32le','--rate=48000','--channels=1','--latency-msec=20']
 assert 1<=a.seconds<=20
 raw=out/'own-stream.f32le';start=time.monotonic_ns();rec=None
 try:
  pulse(server,'set-sink-input-volume',str(idx),'10%')
  with raw.open('wb') as audio,(out/'parec.log').open('wb') as log:
   rec=subprocess.Popen(cmd,stdout=audio,stderr=log)
   print(json.dumps({'armed':True,'recorder_pid':rec.pid,'own_stream_index':idx,'duration':a.seconds}),flush=True)
   time.sleep(a.seconds)
 finally:
  if rec is not None and rec.poll() is None:rec.terminate();rec.wait(timeout=5)
  # The caller must stop typing and leave the plugin open during capture/restore.
  # Never close the stream before restoration: WirePlumber persists its volume.
  restore={'original':original,'restored':False,'only_own_stream':True}
  try:
   assert process(a.backend_pid)==c
   owned=next(s for s in json.loads(pulse(server,'--format=json','list','sink-inputs')) if s['index']==idx and s.get('properties',{}).get('application.process.id')==str(a.backend_pid))
   pulse(server,'set-sink-input-volume',str(idx),*[str(v) for v in original['volume']])
   pulse(server,'set-sink-input-mute',str(idx),'1' if original['mute'] else '0')
   state=next(s for s in json.loads(pulse(server,'--format=json','list','sink-inputs')) if s['index']==idx and s.get('properties',{}).get('application.process.id')==str(a.backend_pid))
   actual={'volume':[v['value'] for v in state['volume'].values()],'mute':state['mute']}
   assert actual==original
   restore.update(restored=True,actual=actual)
  except Exception as exc:
   restore['error']=str(exc);raise
  finally:save(out/'volume-restoration.json',restore)
 values=array.array('f');values.frombytes(raw.read_bytes());assert os.sys.byteorder=='little';block=4800
 windows=[{'start_seconds':i/48000,'peak':max(map(abs,values[i:i+block]),default=0),'rms':(sum(v*v for v in values[i:i+block])/max(1,len(values[i:i+block])))**.5} for i in range(0,len(values),block)]
 save(out/'waveform.json',{'command':cmd,'stream_id':idx,'backend':c,'volume':'10% own sink-input only','monitor_stream_isolation':True,'start_monotonic_ns':start,'end_monotonic_ns':time.monotonic_ns(),'bytes':raw.stat().st_size,'sha256':digest(raw),'windows_100ms':windows,'peak':max(map(abs,values),default=0),'baseline_300ms_peak':max(map(abs,values[:14400]),default=0),'tail_500ms_peak':max(map(abs,values[-24000:]),default=0)})
if __name__=='__main__':main()
