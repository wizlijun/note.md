"""Explicit two-click acceptance. Only an isolated backend's own stream is recorded."""
import os,pathlib,json,subprocess,select,time,uuid,hashlib,array,sys
root=pathlib.Path(__file__).resolve().parent/'playback';root.mkdir(exist_ok=True)
binary=pathlib.Path('/home/bruce/.local/share/net.notemd.app/plugins/notemd.sumi/0.1.12/bin/notemd-sumi')
env={k:os.environ[k] for k in ['HOME','PATH','LANG','LC_ALL','TERM','USER','TMPDIR','XDG_RUNTIME_DIR'] if k in os.environ}
assert env.get('XDG_RUNTIME_DIR')=='/run/user/1000'
def pulse_list(kind):return json.loads(subprocess.check_output(['pactl','-f','json','list',kind],text=True))
def peak(raw):
 values=array.array('f');values.frombytes(raw[:len(raw)//4*4])
 if sys.byteorder!='little':values.byteswap()
 return max((abs(v) for v in values),default=0.)
results=[]
for preset in ['typewriter','thock']:
 work=root/preset;work.mkdir(exist_ok=True);(work/'vault').mkdir(exist_ok=True)
 err=(work/'backend-stderr.log').open('w');p=subprocess.Popen([str(binary)],env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=err,text=True,bufsize=1);seq=0;rec=None;capture=None;record_err=None;stream_id=None;original_stream_state=None;restored_stream_state=None;cleanup_error=None
 def rpc(method,params):
  global seq
  seq+=1;p.stdin.write(json.dumps({'jsonrpc':'2.0','id':seq,'method':'service.request','params':{'method':method,'params':params}})+'\n');p.stdin.flush();deadline=time.monotonic()+8
  while time.monotonic()<deadline:
   if not select.select([p.stdout],[],[],max(0,deadline-time.monotonic()))[0]:raise RuntimeError('RPC timeout '+method)
   line=p.stdout.readline()
   if not line:raise RuntimeError('backend exited')
   value=json.loads(line)
   if value.get('id')==seq:
    if 'error' in value:raise RuntimeError(value['error']['message'])
    return value['result']
   if 'method' in value and value.get('id') is not None:
    p.stdin.write(json.dumps({'jsonrpc':'2.0','id':value['id'],'result':None})+'\n');p.stdin.flush()
 try:
  instance=rpc('hello',{'version':1})['instance'];session=str(uuid.uuid4());token=str(uuid.uuid4())
  rpc('open',{'version':1,'instance':instance,'session':session,'vault':str(work/'vault'),'database':str(work/'private/db.sqlite'),'fontCache':str(work/'fonts')})
  envelope={'instance':instance,'session':session}
  def sound(payload):return rpc('sound',{**envelope,'payload':payload})
  assert sound({'operation':'configure','enabled':True,'preset':preset,'token':token,'expires_at_ms':int(time.time()*1000)+4000})['ready']
  streams=[s for s in pulse_list('sink-inputs') if s.get('properties',{}).get('application.process.id')==str(p.pid)]
  assert len(streams)==1,streams;stream=streams[0];stream_id=stream['index']
  assert stream['properties']['application.name']=='Sumi'
  original_stream_state={'volume':[channel['value'] for channel in stream['volume'].values()],'mute':stream['mute']}
  # Per-input only: never set sink volume or mute user streams.
  subprocess.run(['pactl','set-sink-input-volume',str(stream_id),'10%'],check=True)
  sink=next(s for s in pulse_list('sinks') if s['index']==stream['sink']);monitor=sink.get('monitor_source_name',sink.get('monitor_source'));assert isinstance(monitor,str)
  pcm=work/'own-stream.f32le';capture=pcm.open('wb');record_err=(work/'record-stderr.log').open('w')
  rec=subprocess.Popen(['parec','--raw','--format=float32le','--rate=48000','--channels=1','--latency-msec=20','--device='+monitor,'--monitor-stream='+str(stream_id),'--client-name=Sumi isolated acceptance'],stdout=capture,stderr=record_err)
  deadline=time.monotonic()+3
  while pcm.stat().st_size<48000*4*.3:
   assert rec.poll() is None,'recorder exited'
   if time.monotonic()>deadline:raise RuntimeError('monitor stream produced no baseline')
   time.sleep(.01)
  baseline_bytes=pcm.stat().st_size
  assert sound({'operation':'play','token':token,'roles':['key'],'expires_at_ms':int(time.time()*1000)+150})['ready']
  time.sleep(.7)
  assert sound({'operation':'stop','token':token})['ready']
  time.sleep(.1);rec.terminate();rec.wait(timeout=3);capture.close();capture=None
  raw=pcm.read_bytes();before=peak(raw[:baseline_bytes]);after=peak(raw[baseline_bytes:]);assert before<1e-7,('nonzero baseline',before);assert after>1e-7,('silent key',after)
  results.append({'preset':preset,'backendPid':p.pid,'streamId':stream_id,'streamVolume':'10%','monitorOwnStreamOnly':True,'baselineFrames':baseline_bytes//4,'recordedFrames':len(raw)//4,'baselinePeak':before,'afterKeyPeak':after,'rolesPlayed':['key'],'pcm':str(pcm)})
 finally:
  if rec is not None and rec.poll() is None:rec.terminate();rec.wait(timeout=3)
  if capture:capture.close()
  if record_err:record_err.close()
  # WirePlumber persists per-application stream settings: restore before destroy.
  if original_stream_state is not None and p.poll() is None:
   try:
    sound({'operation':'stop','token':token})
    owned=[s for s in pulse_list('sink-inputs') if s['index']==stream_id and s.get('properties',{}).get('application.process.id')==str(p.pid)]
    if owned:
     subprocess.run(['pactl','set-sink-input-volume',str(stream_id),*[str(v) for v in original_stream_state['volume']]],check=True)
     subprocess.run(['pactl','set-sink-input-mute',str(stream_id),'1' if original_stream_state['mute'] else '0'],check=True)
     state=next(s for s in pulse_list('sink-inputs') if s['index']==stream_id)
     restored_stream_state={'volume':[channel['value'] for channel in state['volume'].values()],'mute':state['mute']}
     assert restored_stream_state==original_stream_state
    else:raise RuntimeError('own stream disappeared before restoring its persistent volume')
   except Exception as error:
    cleanup_error=str(error)
   finally:
    try:sound({'operation':'configure','enabled':False,'preset':preset,'token':token})
    except Exception as error:cleanup_error=cleanup_error or str(error)
  p.stdin.close()
  try:p.wait(timeout=5)
  except subprocess.TimeoutExpired:p.terminate();p.wait(timeout=5)
  err.close()
  if results and results[-1]['backendPid']==p.pid:
   results[-1]['originalStreamState']=original_stream_state
   results[-1]['restoredStreamState']=restored_stream_state
   results[-1]['backendExited']=p.poll() is not None
   results[-1]['streamRemoved']=not any(s['index']==stream_id for s in pulse_list('sink-inputs'))
  if cleanup_error:raise RuntimeError('persistent stream state restore failed: '+cleanup_error)
(root/'result.json').write_text(json.dumps({'binary':str(binary),'binarySha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'results':results,'globalVolumeUnchanged':True,'existingBackendUntouched':True},indent=2)+'\n')
print(json.dumps(results,indent=2))
