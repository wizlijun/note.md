"""Private GTK backend reproduction, no connection to the user's desktop.

Start `broadwayd :55`, then run:
GDK_BACKEND=broadway BROADWAY_DISPLAY=:55 python3 repro.py
"""
import json
import math
import gi

gi.require_version("Gtk", "3.0")
from gi.repository import Gtk

Gtk.init([])
window = Gtk.OffscreenWindow()
window.set_default_size(700, 500)
scroll = Gtk.ScrolledWindow()
scroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.EXTERNAL)
view = Gtk.TextView()
view.set_wrap_mode(Gtk.WrapMode.WORD_CHAR)
view.set_top_margin(250)
view.set_bottom_margin(250)
scroll.add(view)
window.add(scroll)
buffer = view.get_buffer()
buffer.set_text("stable line\n" * 100)
buffer.place_cursor(buffer.get_iter_at_line(50))
window.show_all()


def drain():
    for _ in range(10):
        while Gtk.events_pending():
            Gtk.main_iteration_do(False)


drain()
adjustment = scroll.get_vadjustment()
cursor = view.get_cursor_locations(None)[0]
height = 500 if cursor.height % 2 else 501
result = {
    "gtk_version": [Gtk.get_major_version(), Gtk.get_minor_version(), Gtk.get_micro_version()],
    "cursor_height": cursor.height,
    "viewport_height_for_center": height,
}
for fixed in [False, True]:
    adjustment.set_value(1000)
    drain()
    samples = []
    for _ in range(12):
        cursor = view.get_cursor_locations(None)[0]
        _, y = view.buffer_to_window_coords(Gtk.TextWindowType.WIDGET, cursor.x, cursor.y)
        current = math.trunc(adjustment.get_value()) if fixed else adjustment.get_value()
        adjustment.set_value(current + y + cursor.height / 2 - height / 2)
        cursor = view.get_cursor_locations(None)[0]
        _, y = view.buffer_to_window_coords(Gtk.TextWindowType.WIDGET, cursor.x, cursor.y)
        samples.append((adjustment.get_value(), y))
        drain()
    result["fixed" if fixed else "old"] = samples
    assert (len(set(samples)) == 1) == fixed

bar = scroll.get_vscrollbar()
_, before = view.buffer_to_window_coords(Gtk.TextWindowType.WIDGET, 0, cursor.y)
adjustment.set_value(adjustment.get_value() + 50)
_, after = view.buffer_to_window_coords(Gtk.TextWindowType.WIDGET, 0, cursor.y)
result["external"] = {
    "scrollbar_visible": bar.get_visible(),
    "scrollbar_child_visible": bar.get_child_visible(),
    "allocated_height": scroll.get_allocation().height,
    "preferred_height": list(scroll.get_preferred_height()),
    "body_delta_after_scroll_50": after - before,
    "shadow_type": int(scroll.get_shadow_type()),
}
assert not bar.get_child_visible()
assert after - before == -50
print(json.dumps(result, indent=2))
window.destroy()
