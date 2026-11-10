#!/usr/bin/env python3
import json,os,pathlib,subprocess,time,signal
ROOT=pathlib.Path(__file__).resolve().parent;REPO=ROOT.parents[1];SWAY=REPO/'tasks/omarchy-build/headless/sysroot/usr'
for d in ['runtime','config','data','cache','state']:(ROOT/d).mkdir(exist_ok=True)
os.chmod(ROOT/'runtime',0o700)
for key in ['DISPLAY','WAYLAND_DISPLAY','SWAYSOCK','HYPRLAND_INSTANCE_SIGNATURE','LD_LIBRARY_PATH']:os.environ.pop(key,None)
os.environ.update(XDG_RUNTIME_DIR=str(ROOT/'runtime'),XDG_CONFIG_HOME=str(ROOT/'config'),XDG_DATA_HOME=str(ROOT/'data'),XDG_CACHE_HOME=str(ROOT/'cache'),XDG_STATE_HOME=str(ROOT/'state'),GDK_BACKEND='wayland',GTK_IM_MODULE='gtk-im-context-simple',NO_AT_BRIDGE='1',GTK_USE_PORTAL='0',GIO_USE_VFS='local',XDG_CURRENT_DESKTOP='sway')
config=ROOT/'sway.conf';config.write_text('xwayland disable\noutput HEADLESS-1 mode 1200x900 scale 1\nseat seat0 fallback true\nfor_window [app_id=".*"] floating enable\nfor_window [app_id=".*"] border none\n')
env=dict(os.environ);env.update(LD_LIBRARY_PATH=str(SWAY/'lib'),WLR_BACKENDS='headless',WLR_RENDERER='pixman',WLR_LIBINPUT_NO_DEVICES='1',WLR_HEADLESS_OUTPUTS='1')
sway=subprocess.Popen([str(SWAY/'bin/sway'),'-c',str(config)],env=env,stdout=(ROOT/'sway.log').open('w'),stderr=subprocess.STDOUT)
try:
 for _ in range(100):
  sockets=[p for p in (ROOT/'runtime').glob('wayland-*') if p.is_socket()]
  if sockets:break
  if sway.poll() is not None:raise RuntimeError('Private Sway failed')
  time.sleep(.05)
 else:raise RuntimeError('No private compositor socket')
 os.environ['WAYLAND_DISPLAY']=sockets[0].name
 import gi
 gi.require_version('Gtk','3.0');gi.require_version('WebKit2','4.1')
 from gi.repository import Gtk,WebKit2,GLib
 manager=WebKit2.UserContentManager();manager.register_script_message_handler('evidence')
 view=WebKit2.WebView.new_with_user_content_manager(manager)
 view.get_settings().set_hardware_acceleration_policy(WebKit2.HardwareAccelerationPolicy.NEVER)
 window=Gtk.Window(title='Isolated Linux updater verification');window.set_default_size(1100,820);window.add(view)
 result={'status':'timeout'};snapshots=[]
 def snapshot_done(webview,task,name):
  try:
   surface=webview.get_snapshot_finish(task);surface.write_to_png(str(ROOT/(name+'.png')));snapshots.append(name+'.png')
  except Exception as error:(ROOT/(name+'-snapshot-error.txt')).write_text(str(error))
 def evidence(manager,message):
  nonlocal_dummy=None
  data=json.loads(message.get_js_value().to_string());name=data['id'];(ROOT/(name+'.json')).write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n')
  print(name,flush=True)
  if name in ['complete','failed']:
   result.update(data);GLib.timeout_add(700,lambda:Gtk.main_quit() or False)
  else:view.get_snapshot(WebKit2.SnapshotRegion.FULL_DOCUMENT,WebKit2.SnapshotOptions.NONE,None,snapshot_done,name)
 manager.connect('script-message-received::evidence',evidence)
 window.connect('destroy',lambda *_:Gtk.main_quit())
 window.show_all();view.load_uri('http://127.0.0.1:5188/tasks/linux-updater-webkit/index.html')
 GLib.timeout_add_seconds(150,lambda:Gtk.main_quit() or False)
 Gtk.main()
 result['snapshots']=snapshots;result['webkit_version']=f'{WebKit2.get_major_version()}.{WebKit2.get_minor_version()}.{WebKit2.get_micro_version()}';(ROOT/'result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
 if result.get('status')!='passed':raise RuntimeError(json.dumps(result))
finally:
 sway.terminate()
 try:sway.wait(5)
 except subprocess.TimeoutExpired:sway.kill();sway.wait()
