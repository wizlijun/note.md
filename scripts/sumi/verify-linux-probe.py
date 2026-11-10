#!/usr/bin/env python3
"""Verify an already running, isolated Sumi Tauri probe on native Wayland.

Launch with GDK_BACKEND=wayland SUMI_PROBE_AUTOMATED=1 and a fresh
SUMI_PROBE_DIR, then pass that directory here. Only the exact probe window is
focused/captured; synthetic keyboard input is sent after checking its identity.
Pass --breathing-phases to require compositor pixel changes after the CPU sample
(ImageMagick is needed for frame differences). All failures retain evidence.
Pass --navigation-capture to retain before/after Left-key rendering evidence;
those images require separate visual review for stale pixels.
This does not exercise a physical IME or the production host's durable journal.
"""
import argparse
import json
from pathlib import Path
import subprocess
import time
import re
import os
import shutil

SWAYMSG = None


def command(*args):
    return subprocess.check_output(args, text=True)


def read_json(path):
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def clients():
    if not SWAYMSG:
        return json.loads(command('hyprctl', '-j', 'clients'))
    found = []
    def walk(node, output=None):
        if node.get('type') == 'output':
            output = node['name']
        if node.get('app_id'):
            rect = node['rect']
            found.append({'address': str(node['id']), 'title': node.get('name'),
                          'class': node['app_id'], 'pid': node['pid'],
                          'at': [rect['x'], rect['y']], 'size': [rect['width'], rect['height']],
                          'monitor': output, 'xwayland': node.get('shell') != 'xdg_shell',
                          'focused': node.get('focused', False)})
        for child in node.get('nodes', []) + node.get('floating_nodes', []):
            walk(child, output)
    walk(json.loads(command(SWAYMSG, '-t', 'get_tree', '-r')))
    return found


def active_window():
    if SWAYMSG:
        return next((c for c in clients() if c['focused']), {})
    return json.loads(command('hyprctl', '-j', 'activewindow'))


def probe_window():
    matches = [c for c in clients() if c.get('title') == 'Sumi Native Probe — isolated'
               and c.get('class') == 'native-probe']
    if len(matches) != 1:
        raise RuntimeError(f'expected one isolated probe window, found {len(matches)}')
    window = matches[0]
    if window.get('xwayland') is not False:
        raise RuntimeError('probe is not a native Wayland window')
    return window


def ensure_desktop_available():
    if not SWAYMSG and shutil.which("omarchy"):
        if command("omarchy", "shell", "lock", "isLocked").strip() != "false":
            raise RuntimeError("refusing physical desktop input/capture: session is locked")


def focus_window(window, center=False):
    ensure_desktop_available()
    address = window['address']
    if SWAYMSG:
        if not address.isdecimal():
            raise RuntimeError('invalid Sway container identity')
        command(SWAYMSG, f'[con_id={address}] focus')
        if center:
            command(SWAYMSG, f'[con_id={address}] move position center')
        return
    if not re.fullmatch(r'0x[0-9a-fA-F]+', address):
        raise RuntimeError('invalid compositor window identity')
    selector = json.dumps('address:' + address)
    command('hyprctl', 'dispatch', f'hl.dsp.focus({{ window = {selector} }})')
    if center:
        command('hyprctl', 'dispatch', f'hl.dsp.window.center({{ window = {selector} }})')


def capture(window, output):
    ensure_desktop_available()
    x, y = window['at']
    width, height = window['size']
    subprocess.run(['grim', '-g', f'{x},{y} {width}x{height}', str(output)], check=True)


def click(window, pointer, x, y):
    ensure_desktop_available()
    if active_window().get('address') != window['address']:
        focus_window(window)
    if active_window().get('address') != window['address']:
        raise RuntimeError('refusing to click: isolated probe does not own focus')
    if SWAYMSG:
        output = next(m for m in json.loads(command(SWAYMSG, '-t', 'get_outputs', '-r'))
                      if m['name'] == window['monitor'])
        monitor = dict(output['rect'], scale=1)
    else:
        monitor = next(m for m in json.loads(command('hyprctl', '-j', 'monitors'))
                       if m['id'] == window['monitor'])
    if monitor['x'] != 0 or monitor['y'] != 0:
        raise RuntimeError('pointer helper currently requires the probe monitor at origin')
    # Window placement can leave GTK's pointer coordinates stale. A changed
    # motion forces a new wl_pointer.motion before pressing the button.
    if SWAYMSG:
        command(SWAYMSG, f'seat seat0 cursor set {round(x+1)} {round(y+1)}')
    else:
        command('hyprctl', 'dispatch', f'hl.dsp.cursor.move({{x={x+1},y={y+1}}})')
    subprocess.run([str(pointer), str(round(x)), str(round(y)),
                    str(round(monitor['width'] / monitor['scale'])),
                    str(round(monitor['height'] / monitor['scale']))], check=True)
    time.sleep(0.4)


def cpu_sample(pid, seconds=5):
    def ticks():
        fields = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()
        return int(fields[11]) + int(fields[12])
    start, before = time.monotonic(), ticks()
    time.sleep(seconds)
    return 100 * (ticks() - before) / os.sysconf('SC_CLK_TCK') / (time.monotonic() - start)


def main():
    global SWAYMSG
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    parser.add_argument('--pointer', type=Path, required=True,
                        help='click helper built by scripts/sumi/probe-pointer/build.sh')
    parser.add_argument('--keyboard', type=Path,
                        help='fixed-keymap keyboard helper (defaults to keyboard beside --pointer)')
    parser.add_argument('--swaymsg', type=Path,
                        help='use this Sway IPC binary for an isolated virtual display instead of Hyprland')
    parser.add_argument('--breathing-phases', action='store_true',
                        help='capture six settled frames and require actual caret opacity changes')
    parser.add_argument('--navigation-capture', action='store_true',
                        help='capture Left-key navigation and assert text/revision are unchanged')
    args = parser.parse_args()
    directory = args.directory.resolve(strict=True)
    pointer = args.pointer.resolve(strict=True)
    keyboard = (args.keyboard or pointer.with_name('keyboard')).resolve(strict=True)
    if args.swaymsg:
        SWAYMSG = str(args.swaymsg.resolve(strict=True))
        if not os.environ.get('SWAYSOCK'):
            raise RuntimeError('Sway verification requires an explicit isolated SWAYSOCK')
    seen = set()
    deadline = time.monotonic() + 55
    report = None
    while time.monotonic() < deadline:
        report = read_json(directory / 'tauri-acceptance.json')
        if report:
            if report.get('passed') is False:
                raise RuntimeError(report.get('error', 'probe failed'))
            stage = report.get('stage')
            if stage in ('native-visible', 'web-overlay', 'passed') and stage not in seen:
                window = probe_window()
                focus_window(window, center=not seen)
                time.sleep(0.2)
                window = probe_window()
                capture(window, directory / f'{stage}.png')
                seen.add(stage)
            if stage == 'passed':
                break
        time.sleep(0.1)
    if not report or not report.get('passed'):
        raise RuntimeError('automated probe did not complete')
    if seen != {'native-visible', 'web-overlay', 'passed'}:
        raise RuntimeError(f'missed capture stages: {seen}; restart with a fresh probe directory')

    window = probe_window()
    focus_window(window)
    time.sleep(0.3)
    active = active_window()
    if active.get('address') != window['address']:
        raise RuntimeError('refusing to type: isolated probe does not own keyboard focus')
    before = read_json(directory / 'tauri-snapshot.json')
    if not before:
        raise RuntimeError('missing native snapshot')
    addition = '\nOmarchy Wayland 验证 😀'
    # Initialize GTK's binding cache with the stable standard keymap before
    # wtype installs its text-specific mapping. Named wtype keys change hardware
    # codes across calls and cannot reliably drive GTK bindings afterwards.
    subprocess.run([str(keyboard), 'Ctrl+End', 'Return'], check=True)
    subprocess.run(['wtype', '-s', '100', addition[1:], '-s', '100'], check=True)
    expected = before['surface']['text'] + addition
    deadline = time.monotonic() + 8
    after = None
    while time.monotonic() < deadline:
        after = read_json(directory / 'tauri-snapshot.json')
        if after and after['surface']['text'] == expected:
            break
        time.sleep(0.2)
    if not after or after['surface']['text'] != expected:
        raise RuntimeError('synthetic Wayland input did not produce the exact expected native text')
    if after['surface']['revision'] <= before['surface']['revision']:
        raise RuntimeError('input did not advance native revision')
    capture(window, directory / 'wayland-input.png')
    geometry = report['geometry']
    origin = geometry['native']['windowOrigin']
    if SWAYMSG:
        # Sway IPC rect excludes GTK's client-side shadow; GTK coordinates
        # include it. The titlebar begins exactly at the visible window edge.
        titlebar = geometry['native'].get('titlebarAllocation')
        if not titlebar:
            raise RuntimeError('missing GTK titlebar geometry for virtual-display pointer calibration')
        origin = [origin[0] - titlebar[0], origin[1] - titlebar[1]]
    click(window, pointer, window['at'][0] + 22, window['at'][1] + origin[1] - 13)
    capture(window, directory / 'native-menu.png')
    click(window, pointer, window['at'][0] + 75, window['at'][1] + origin[1] + 14)
    deadline = time.monotonic() + 5
    menu = None
    while time.monotonic() < deadline:
        menu = read_json(directory / 'menu-event.json')
        if menu:
            break
        time.sleep(0.1)
    if not menu or menu.get('consumed') is not True:
        raise RuntimeError(f'native menu did not route to the focused writing surface: {menu}')
    scale = geometry['native']['gtkAllocation'][2] / geometry['innerWidth']
    clicks = []
    for name in ('Remote edit', 'Snapshot', 'Overlay', 'Overlay', 'Focus'):
        button = next(b for b in geometry['buttons'] if b['name'] == name)['rect']
        path = directory / 'web-pointer.json'
        path.unlink(missing_ok=True)
        click(window, pointer,
              window['at'][0] + origin[0] + (button['x'] + button['width']/2) * scale,
              window['at'][1] + origin[1] + (button['y'] + button['height']/2) * scale)
        event = read_json(path)
        if not event or event.get('text') != name:
            raise RuntimeError(f'actual pointer did not reach WebKit button {name}: {event}')
        clicks.append(event)
        time.sleep(1.1)
        current = read_json(directory / 'tauri-snapshot.json')
        if name == 'Remote edit' and current['surface']['text'] != expected + '\nRemote 同步增量':
            raise RuntimeError('actual Remote button did not update the native document')
        if name == 'Overlay':
            want_visible = sum(e['text'] == 'Overlay' for e in clicks) == 2
            if current['surface']['visible'] != want_visible:
                raise RuntimeError('actual Overlay button did not change native visibility')
    capture(window, directory / 'actual-buttons.png')
    # Focus typing fades back to reading after 10 s, with a 1.2 s transition.
    # Sample only after that transition has settled.
    time.sleep(12)
    cpu = cpu_sample(window['pid'])
    (directory / 'cpu-sample.json').write_text(json.dumps({'percentOneCore':cpu,'seconds':5},indent=2))
    phases = []
    if args.breathing_phases:
        for index in range(6):
            target = directory / f'caret-phase-{index}.png'
            capture(window, target)
            phases.append(target)
            time.sleep(0.23)
        differences = []
        for previous, current in zip(phases, phases[1:]):
            diff = command('magick', str(previous), str(current), '-compose', 'difference',
                           '-composite', '-threshold', '0', '-format', '%@', 'info:').strip()
            differences.append(diff)
        (directory / 'caret-phase-differences.json').write_text(json.dumps(differences, indent=2))
        if not any(not diff.startswith('0x0') for diff in differences):
            raise RuntimeError('breathing caret did not change in six settled compositor frames')
    navigation = None
    if args.navigation_capture:
        focus_window(window)
        if active_window().get('address') != window['address']:
            raise RuntimeError('refusing navigation: isolated probe does not own focus')
        nav_before = read_json(directory / 'tauri-snapshot.json')['surface']
        capture(window, directory / 'navigation-before.png')
        subprocess.run([str(keyboard)] + ['Left'] * 5, check=True)
        time.sleep(0.15)
        capture(window, directory / 'navigation-after.png')
        time.sleep(2)
        capture(window, directory / 'navigation-settled.png')
        nav_after = read_json(directory / 'tauri-snapshot.json')['surface']
        navigation = {'before': nav_before, 'after': nav_after,
                      'visualReview': 'required: inspect three navigation images for stale text/caret'}
        (directory / 'navigation.json').write_text(json.dumps(navigation, indent=2, ensure_ascii=False))
        if nav_after['text'] != nav_before['text'] or nav_after['revision'] != nav_before['revision']:
            raise RuntimeError('navigation unexpectedly changed document text/revision')
        if nav_after['selection'] == nav_before['selection']:
            raise RuntimeError('Left-key navigation did not move selection')
    button = next(b for b in geometry['buttons'] if b['name'] == 'Quit')['rect']
    click(window, pointer,
          window['at'][0] + origin[0] + (button['x'] + button['width']/2) * scale,
          window['at'][1] + origin[1] + (button['y'] + button['height']/2) * scale)
    remaining = clients()
    if any(c['address'] == window['address'] for c in remaining):
        raise RuntimeError('actual Quit button did not close the probe')
    result = {'passed': True, 'wayland': True, 'window': window,
              'compositor': 'Sway virtual display' if SWAYMSG else 'Hyprland physical display',
              'stages': sorted(seen), 'checks': report['checks'],
              'menu': menu,
              'cloneStress': report.get('cloneStress'),
              'actualWebButtons': clicks,
              'actualQuitClosedWindow': True,
              'idleCpuPercentOneCore': cpu,
              'breathingPhaseFrames': len(phases),
              'navigation': navigation,
              'cpuMeasurement': '5 second /proc stat delta after 12 seconds without input; probe snapshot interval remains 1 second',
              'input': {'method': 'wtype text and fixed-keymap virtual keyboard; not physical IME',
                        'exactText': True, 'beforeRevision': before['surface']['revision'],
                        'afterRevision': after['surface']['revision']}}
    (directory / 'linux-probe-result.json').write_text(json.dumps(result, indent=2, ensure_ascii=False))
    print(json.dumps({'passed': True, 'output': str(directory)}, ensure_ascii=False))


if __name__ == '__main__':
    main()
