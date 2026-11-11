#!/usr/bin/env bash
set -euo pipefail
export SUMI_FCITX_ISOLATED_TEST=1
export XDG_CONFIG_HOME="$SUMI_PACKAGE_TEST_DIR/config"
export XDG_DATA_HOME="$SUMI_PACKAGE_TEST_DIR/data"
export XDG_CACHE_HOME="$SUMI_PACKAGE_TEST_DIR/cache"
export XDG_RUNTIME_DIR="$SUMI_PACKAGE_TEST_DIR/run"
export FCITX_ADDON_DIRS="$SUMI_PACKAGE_EXTRACT/usr/lib/fcitx5:/usr/lib/fcitx5"
unset DISPLAY WAYLAND_DISPLAY HYPRLAND_INSTANCE_SIGNATURE SWAYSOCK
fcitx5 --keep --disable all --enable dbus,dbusfrontend,keyboard,pinyin,pinyinhelper,punctuation,chttrans,spell,sumicandidates > "$SUMI_PACKAGE_TEST_DIR/fcitx.log" 2>&1 &
test_fcitx_pid=$!
trap 'kill "$test_fcitx_pid" 2>/dev/null || true; wait "$test_fcitx_pid" 2>/dev/null || true' EXIT
export SUMI_PACKAGE_TEST_PID="$test_fcitx_pid"
python3 - <<'CHECK'
import os,pathlib,time
module=str(pathlib.Path(os.environ['SUMI_PACKAGE_EXTRACT'])/'usr/lib/fcitx5/libsumicandidates.so')
for _ in range(100):
    maps=pathlib.Path('/proc')/os.environ['SUMI_PACKAGE_TEST_PID']/'maps'
    if maps.exists() and module in maps.read_text():
        pathlib.Path(os.environ['SUMI_PACKAGE_TEST_DIR'],'loaded-module.txt').write_text(module+'\n')
        break
    time.sleep(.03)
else:
    raise SystemExit('Packaged module was not loaded by the private Fcitx instance')
CHECK
/usr/bin/python "$SUMI_PACKAGE_SOURCE/src/modules/sumicandidates/tests/integration.py"
