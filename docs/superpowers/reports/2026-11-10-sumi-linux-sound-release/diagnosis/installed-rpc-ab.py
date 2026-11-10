import os,pathlib,json,subprocess,select,time,uuid,hashlib
root=pathlib.Path(__file__).resolve().parent
binary=pathlib.Path('/home/bruce/.local/share/net.notemd.app/plugins/notemd.sumi/0.1.12/bin/notemd-sumi')
base={k:os.environ[k] for k in ['HOME','PATH','LANG','LC_ALL','TERM','USER','TMPDIR'] if k in os.environ}
results=[]
for name,env in [('sanitized',base),('with_runtime',{**base,'XDG_RUNTIME_DIR':'/run/user/1000'})]:
 work=root/name;work.mkdir(exist_ok=True);(work/'vault').mkdir(exist_ok=True)
 errors=(work/'stderr.log').open('w');p=subprocess.Popen([str(binary)],env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=errors,text=True,bufsize=1);seq=0
 def rpc(method,params):
  global seq
  seq+=1;request={'jsonrpc':'2.0','id':seq,'method':'service.request','params':{'method':method,'params':params}}
  p.stdin.write(json.dumps(request)+'\n');p.stdin.flush();deadline=time.monotonic()+8
  while time.monotonic()<deadline:
   if not select.select([p.stdout],[],[],max(0,deadline-time.monotonic()))[0]:raise RuntimeError('RPC timeout '+method)
   line=p.stdout.readline()
   if not line:raise RuntimeError('backend exited')
   reply=json.loads(line)
   if reply.get('id')==seq:return reply
   if 'method' in reply and reply.get('id') is not None:
    p.stdin.write(json.dumps({'jsonrpc':'2.0','id':reply['id'],'result':None})+'\n');p.stdin.flush()
 try:
  hello=rpc('hello',{'version':1});instance=hello['result']['instance'];session=str(uuid.uuid4())
  opened=rpc('open',{'version':1,'instance':instance,'session':session,'vault':str(work/'vault'),'database':str(work/'private/db.sqlite'),'fontCache':str(work/'fonts')})
  assert 'result' in opened,opened
  envelope={'instance':instance,'session':session};token=str(uuid.uuid4());start=time.monotonic()
  configured=rpc('sound',{**envelope,'payload':{'operation':'configure','enabled':True,'preset':'typewriter','token':token,'expires_at_ms':int(time.time()*1000)+4000}})
  elapsed=time.monotonic()-start;time.sleep(.15)
  streams=json.loads(subprocess.check_output(['pactl','-f','json','list','sink-inputs'],text=True))
  own=[{'index':s['index'],'application':s.get('properties',{}).get('application.name'),'media':s.get('properties',{}).get('media.name'),'processId':s.get('properties',{}).get('application.process.id')} for s in streams if s.get('properties',{}).get('application.process.id')==str(p.pid)]
  status=rpc('sound',{**envelope,'payload':{'operation':'status'}})
  stopped=rpc('sound',{**envelope,'payload':{'operation':'stop','token':token}})
  disabled=rpc('sound',{**envelope,'payload':{'operation':'configure','enabled':False,'preset':'typewriter','token':token}})
  results.append({'case':name,'pid':p.pid,'environmentKeys':sorted(env),'configure':configured,'configureSeconds':elapsed,'stream':own,'status':status,'stop':stopped,'disable':disabled,'samplesPlayed':0})
 finally:
  p.stdin.close()
  try:p.wait(timeout=5)
  except subprocess.TimeoutExpired:p.terminate();p.wait(timeout=5)
  errors.close()
r={'installedBinary':str(binary),'binarySha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'results':results}
(root/'installed-rpc-ab.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps(r,indent=2))
