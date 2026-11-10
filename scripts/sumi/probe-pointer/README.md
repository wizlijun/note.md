# Isolated Wayland probe pointer

This test-only helper sends one left click at global logical coordinates through
`zwlr_virtual_pointer_v1`. It does not edit desktop settings.

Build with `bash scripts/sumi/probe-pointer/build.sh tasks/omarchy-build/probe-pointer`.
Requires a C compiler, `wayland-scanner`, `pkg-config`, and Wayland client headers.
Call `click X Y LOGICAL_MONITOR_WIDTH LOGICAL_MONITOR_HEIGHT` only after verifying
the isolated probe owns focus. The verifier moves the pointer away and back first:
Hyprland can retain stale surface coordinates after window placement when an
absolute motion repeats the current cursor position.

The vendored protocol is from the wlroots project's wlr-protocols repository:
https://raw.githubusercontent.com/swaywm/wlr-protocols/master/unstable/wlr-virtual-pointer-unstable-v1.xml
The XML retains its upstream MIT-style copyright and permission notice.

For a headless compositor with no other pointer device, set
`SUMI_POINTER_HOLD_SECONDS=600` for one helper invocation. It keeps that virtual
pointer alive after the click so GTK/WebKit retain pointer seat capability and
hover state while subsequent test actions run. Keep a virtual keyboard alive
with `wtype -s 600000` as well; device removal can clear keyboard focus. These
helpers must use the explicit private `XDG_RUNTIME_DIR` and `WAYLAND_DISPLAY`.

## Stable keyboard bindings

The same build creates `keyboard`, requiring `xkbcommon` headers as well.
It uses the complete standard evdev/pc105/us keymap on every invocation, so GTK's
cached hardware-keycode bindings remain stable. Example:

```sh
keyboard End
wtype -s 300 '中文 😀' -s 300
keyboard Left BackSpace Ctrl+Home Ctrl+End Ctrl+S
```

Start with a fresh isolated application and send `keyboard End` while its editor
owns focus, before using wtype. Repeated wtype processes build different compact
keymaps: GTK can receive the correct Left/BackSpace keyval yet retain the first
hardware-keycode binding map. This was reproduced in an ordinary GtkTextView
without the editor plugin. Unicode text can still use wtype with short delays
before and after input; named keys and shortcuts must then use `keyboard`.
Starting the stable helper after the application's bindings already cached a
compact wtype map does not establish a valid control; restart the test app.

Supported names are Left/Right/Up/Down, Home/End, PageUp/PageDown, BackSpace,
Delete, Return, Tab, Escape, Space, F10 and letters. Chords use `+`, for example
`Ctrl+Shift+Left`. `SUMI_KEYBOARD_HOLD_SECONDS=600 keyboard` holds a keyboard device
without sending a key, retaining headless seat capability. Every chord is
validated before any input is sent. These are test helpers; do not use them on
lock screens or unverified active windows.

The keyboard protocol comes from wtype's upstream repository and retains its
license notice:
https://raw.githubusercontent.com/atx/wtype/master/protocol/virtual-keyboard-unstable-v1.xml
