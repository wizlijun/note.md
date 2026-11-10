import argparse, os, pathlib, subprocess, time, shlex, sys, tempfile
parser=argparse.ArgumentParser(description="Run native candidate regression on a private Wayland display and D-Bus")
parser.add_argument("test_binary",type=pathlib.Path)
parser.add_argument("--artifacts",type=pathlib.Path,required=True)
parser.add_argument("--fcitx-source",type=pathlib.Path,default=pathlib.Path.home()/"git/fcitx5")
parser.add_argument("--sway-prefix",type=pathlib.Path,default=pathlib.Path("/usr"))
parser.add_argument("--test-filter",default="native_candidate_roundtrip")
args=parser.parse_args()
root=args.artifacts.resolve(); root.mkdir(parents=True,exist_ok=True)
scale=float(os.environ.get('SUMI_CANDIDATE_SCALE','1'))
mode=os.environ.get('SUMI_CANDIDATE_IM_MODULE','fcitx')
art=root/(('native-verification' if scale==1 else f'native-verification-scale{scale:g}')+('' if mode=='fcitx' else '-'+mode));art.mkdir(exist_ok=True)
# Unix socket paths are limited to 108 bytes, regardless of artifact depth.
runtime_dir=tempfile.TemporaryDirectory(prefix='sumi-ime-')
runtime=pathlib.Path(runtime_dir.name)
sysroot=args.sway_prefix.resolve()
source=args.fcitx_source.resolve()/'src/modules/sumicandidates'
for d in ['config/fcitx5','data/fcitx5/addon','lib','cache']:(art/d).mkdir(parents=True,exist_ok=True)
(art/'config/fcitx5/profile').write_text('[Groups/0]\nName=Default\nDefault Layout=us\nDefaultIM=pinyin\n[Groups/0/Items/0]\nName=keyboard-us\n[Groups/0/Items/1]\nName=pinyin\n[GroupOrder]\n0=Default\n')
(art/'data/fcitx5/addon/sumicandidates.conf').write_text((source/'sumicandidates.conf.in').read_text().replace('@FCITX_ADDON_TYPE@','SharedLibrary').replace('@PROJECT_VERSION@','5.1.23'))
flags=shlex.split(subprocess.check_output(['pkg-config','--cflags','--libs','Fcitx5Core'],text=True))
subprocess.run(['g++','-std=c++20','-shared','-fPIC',str(source/'sumicandidates.cpp'),'-o',str(art/'lib/libsumicandidates.so'),*flags,'-I/usr/include/Fcitx5/Module/fcitx-module/dbus'],check=True)
env=os.environ.copy()
assert env.get('SUMI_CANDIDATE_PRIVATE_BUS')=='1', 'launch with run-native.sh (private bus without service activation)'
for key in ['DISPLAY','WAYLAND_DISPLAY','HYPRLAND_INSTANCE_SIGNATURE','SWAYSOCK']:env.pop(key,None)
env.update(XDG_RUNTIME_DIR=str(runtime),XDG_CONFIG_HOME=str(art/'config'),XDG_DATA_HOME=str(art/'data'),XDG_CACHE_HOME=str(art/'cache'),LD_LIBRARY_PATH=str(sysroot/'lib'),WLR_BACKENDS='headless',WLR_RENDERER='pixman',WLR_LIBINPUT_NO_DEVICES='1',WLR_HEADLESS_OUTPUTS='1',NO_AT_BRIDGE='1',GIO_USE_VFS='local',GTK_USE_PORTAL='0',XDG_CURRENT_DESKTOP='sway',GTK_IM_MODULE=os.environ.get('SUMI_CANDIDATE_IM_MODULE','fcitx'),SUMI_FCITX_ISOLATED_TEST='1',SUMI_CANDIDATE_TEST_ARTIFACTS=str(art),FCITX_ADDON_DIRS=f'{art}/lib:/usr/lib/fcitx5')
conf=art/'sway.conf';conf.write_text(f'xwayland disable\noutput HEADLESS-1 mode {int(1600*scale)}x{int(1000*scale)} scale {scale:g}\nseat seat0 fallback true\nfocus_follows_mouse no\nfor_window [app_id=".*"] floating enable\nfor_window [app_id=".*"] border none\n')
processes=[]
try:
 log=(art/'sway.log').open('w');p=subprocess.Popen([str(sysroot/'bin/sway'),'-c',str(conf)],env=env,stdout=log,stderr=subprocess.STDOUT);processes.append(p)
 for _ in range(100):
  sockets=[p for p in runtime.glob('wayland-*') if p.is_socket()]
  if p.poll() is not None:raise RuntimeError('sway exited; see log')
  if sockets and list(runtime.glob('sway-ipc.*.sock')):break
  time.sleep(.05)
 else:raise RuntimeError('no private wayland socket')
 env['WAYLAND_DISPLAY']=sockets[0].name
 log=(art/'fcitx.log').open('w');p=subprocess.Popen(['fcitx5','--keep','--disable','all','--enable','dbus,dbusfrontend,keyboard,pinyin,pinyinhelper,punctuation,chttrans,spell,sumicandidates,wayland,waylandim,classicui'],env=env,stdout=log,stderr=subprocess.STDOUT);processes.append(p)
 time.sleep(.8)
 # Keep a virtual keyboard attached so clipboard serials and native focus work.
 processes.append(subprocess.Popen(['wtype','-s','60000'],env=env))
 time.sleep(.2)
 result=subprocess.run([str(args.test_binary.resolve()),args.test_filter,'--ignored','--nocapture','--test-threads=1'],env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=90)
 (art/'test.log').write_text(result.stdout);print(result.stdout);sys.exit(result.returncode)
finally:
 for p in reversed(processes):
  p.terminate()
  try:p.wait(4)
  except subprocess.TimeoutExpired:p.kill();p.wait()

 runtime_dir.cleanup()
