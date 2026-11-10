//! Sumi owns presentation only; GTK/Fcitx still own composition and commits.
use super::*;
use gtk::{gio, glib::variant::ToVariant};
use std::rc::Weak;
#[path = "linux_candidates_layout.rs"]
mod layout;
use layout::{Candidate, Layout};
const SERVICE: &str = "org.fcitx.Fcitx5";
const PATH: &str = "/org/fcitx/Fcitx5/SumiCandidates";
const INTERFACE: &str = "org.fcitx.Fcitx.SumiCandidates1";

pub(super) struct Panel {
    surface: Weak<Surface>,
    pub widget: gtk::DrawingArea,
    bus: Option<gio::DBusConnection>,
    subscriptions: RefCell<Vec<gio::SignalSubscriptionId>>,
    token: String,
    desired: Cell<bool>,
    accepted: Cell<bool>,
    retry_after: Cell<i64>,
    epoch: Cell<u64>,
    serial: Cell<u64>,
    candidates: RefCell<Vec<Candidate>>,
    cursor: Cell<i32>,
    previous: Cell<bool>,
    next: Cell<bool>,
    page: Cell<usize>,
    manual_page: Cell<bool>,
    layout: RefCell<Option<Layout>>,
    pub height: Cell<f64>,
    metrics: Cell<(f64, f64, f64, bool)>,
    minimum_width: Cell<f64>,
    pub bottom_anchor: Cell<bool>,
}
impl Panel {
    pub fn attach(surface: &Rc<Surface>) -> Rc<Self> {
        let widget = gtk::DrawingArea::new();
        widget.set_halign(gtk::Align::Start);
        widget.set_valign(gtk::Align::Start);
        widget.set_no_show_all(true);
        widget.set_can_focus(false);
        widget.add_events(gdk::EventMask::BUTTON_PRESS_MASK | gdk::EventMask::SCROLL_MASK);
        surface.overlay.add_overlay(&widget);
        let panel = Rc::new(Self {
            surface: Rc::downgrade(surface),
            widget,
            bus: gio::bus_get_sync(gio::BusType::Session, None::<&gio::Cancellable>).ok(),
            subscriptions: RefCell::new(Vec::new()),
            token: format!(
                "{}:{}:{}",
                std::process::id(),
                surface.config.borrow().surface_id,
                glib::monotonic_time()
            ),
            desired: Cell::new(false),
            accepted: Cell::new(false),
            retry_after: Cell::new(0),
            epoch: Cell::new(0),
            serial: Cell::new(0),
            candidates: RefCell::new(Vec::new()),
            cursor: Cell::new(-1),
            previous: Cell::new(false),
            next: Cell::new(false),
            page: Cell::new(0),
            manual_page: Cell::new(false),
            layout: RefCell::new(None),
            height: Cell::new(0.0),
            bottom_anchor: Cell::new(false),
            metrics: Cell::new((0.0, 0.0, 0.0, false)),
            minimum_width: Cell::new(0.0),
        });
        if let Some(bus) = &panel.bus {
            let weak = Rc::downgrade(&panel);
            let id = bus.signal_subscribe(
                Some(SERVICE),
                Some(INTERFACE),
                Some("Candidates"),
                Some(PATH),
                Some(&panel.token),
                gio::DBusSignalFlags::NONE,
                move |_, _, _, _, _, value| {
                    let Some(p) = weak.upgrade() else {
                        return;
                    };
                    type Frame = (String, u64, Vec<(i32, String, String)>, i32, bool, bool);
                    let Some((token, serial, entries, cursor, prev, next)) = value.get::<Frame>()
                    else {
                        return;
                    };
                    if token != p.token || !p.desired.get() || serial <= p.serial.get() {
                        return;
                    }
                    let Some(s) = p.surface.upgrade() else {
                        return;
                    };
                    if !s.view.has_focus() || !s.visible.get() {
                        return;
                    }
                    p.serial.set(serial);
                    *p.candidates.borrow_mut() = entries
                        .into_iter()
                        .map(|(index, label, text)| Candidate { index, label, text })
                        .collect();
                    p.cursor.set(cursor);
                    p.previous.set(prev);
                    p.next.set(next);
                    p.page.set(0);
                    p.manual_page.set(false);
                    p.refresh();
                },
            );
            panel.subscriptions.borrow_mut().push(id);
            let weak = Rc::downgrade(&panel);
            let id = bus.signal_subscribe(
                Some(SERVICE),
                Some(INTERFACE),
                Some("Revoked"),
                Some(PATH),
                Some(&panel.token),
                gio::DBusSignalFlags::NONE,
                move |_, _, _, _, _, _| {
                    if let Some(p) = weak.upgrade() {
                        p.accepted.set(false);
                        p.clear();
                        p.retry_after.set(glib::monotonic_time() + 1_500_000);
                    }
                },
            );
            panel.subscriptions.borrow_mut().push(id);
            let weak = Rc::downgrade(&panel);
            let id = bus.signal_subscribe(
                Some("org.freedesktop.DBus"),
                Some("org.freedesktop.DBus"),
                Some("NameOwnerChanged"),
                Some("/org/freedesktop/DBus"),
                Some(SERVICE),
                gio::DBusSignalFlags::NONE,
                move |_, _, _, _, _, value| {
                    let Some(p) = weak.upgrade() else {
                        return;
                    };
                    let Some((_, _, owner)) = value.get::<(String, String, String)>() else {
                        return;
                    };
                    p.desired.set(false);
                    p.accepted.set(false);
                    p.serial.set(0);
                    p.clear();
                    if !owner.is_empty() {
                        p.sync_active();
                    }
                },
            );
            panel.subscriptions.borrow_mut().push(id);
        }
        let weak = Rc::downgrade(&panel);
        panel.widget.connect_draw(move |_, cr| {
            if let Some(p) = weak.upgrade() {
                p.draw(cr);
            }
            glib::Propagation::Stop
        });
        let weak = Rc::downgrade(&panel);
        panel.widget.connect_button_press_event(move |_, event| {
            if let Some(p) = weak.upgrade() {
                if event.button() == 1 {
                    p.click(event.position());
                }
            }
            glib::Propagation::Stop
        });
        let weak = Rc::downgrade(&panel);
        panel.widget.connect_scroll_event(move |_, event| {
            if let Some(p) = weak.upgrade() {
                let next = match event.direction() {
                    gdk::ScrollDirection::Up | gdk::ScrollDirection::Left => false,
                    gdk::ScrollDirection::Smooth => event.delta().1 >= 0.0,
                    _ => true,
                };
                p.turn_page(next);
            }
            glib::Propagation::Stop
        });
        panel
    }
    fn programs(&self) -> Vec<String> {
        let mut values = Vec::new();
        if let Some(name) = glib::prgname() {
            values.push(name.to_string());
        }
        if let Ok(exe) = std::env::current_exe() {
            if let Some(name) = exe.file_name().and_then(|s| s.to_str()) {
                values.push(name.into());
            }
        }
        if let Some(s) = self.surface.upgrade() {
            if let Some(window) = s
                .view
                .toplevel()
                .and_then(|w| w.downcast::<gtk::Window>().ok())
            {
                if let Some(app) = window.application() {
                    if let Some(id) = app.application_id() {
                        values.push(id.to_string());
                    }
                }
            }
        }
        values.sort();
        values.dedup();
        values
    }
    fn call(&self, method: &str, args: glib::Variant) {
        if let Some(bus) = &self.bus {
            bus.call(
                Some(SERVICE),
                PATH,
                INTERFACE,
                method,
                Some(&args),
                None,
                gio::DBusCallFlags::NO_AUTO_START,
                1000,
                None::<&gio::Cancellable>,
                |_| {},
            );
        }
    }
    pub fn sync_active(self: &Rc<Self>) {
        let active = self.surface.upgrade().is_some_and(|s| {
            s.visible.get() && s.view.has_focus() && !s.failed.get() && self.capacity(&s) >= 1
        });
        if self.desired.replace(active) == active {
            if !active
                || self.accepted.get()
                || glib::monotonic_time() < self.retry_after.get()
                || self.surface.upgrade().is_some_and(|s| s.composing.get())
            {
                return;
            }
        }
        self.accepted.set(false);
        self.retry_after.set(glib::monotonic_time() + 1_500_000);
        let epoch = self.epoch.get() + 1;
        self.epoch.set(epoch);
        if !active {
            self.clear();
        }
        let Some(bus) = &self.bus else {
            return;
        };
        let weak = Rc::downgrade(self);
        bus.call(
            Some(SERVICE),
            PATH,
            INTERFACE,
            "SetActive",
            Some(&(self.token.clone(), self.programs(), active).to_variant()),
            None,
            gio::DBusCallFlags::NO_AUTO_START,
            1000,
            None::<&gio::Cancellable>,
            move |result| {
                if let Some(p) = weak.upgrade() {
                    if p.epoch.get() != epoch {
                        return;
                    }
                    let accepted = result
                        .ok()
                        .and_then(|v| v.get::<(bool,)>())
                        .is_some_and(|v| v.0);
                    p.accepted.set(accepted);
                    if !accepted {
                        p.call(
                            "SetActive",
                            (p.token.clone(), p.programs(), false).to_variant(),
                        );
                        p.clear();
                    }
                }
            },
        );
    }
    pub fn release(&self) {
        self.accepted.set(false);
        if self.desired.replace(false) {
            self.epoch.set(self.epoch.get() + 1);
            self.call(
                "SetActive",
                (self.token.clone(), self.programs(), false).to_variant(),
            );
        }
        self.clear();
    }
    fn clear(&self) {
        self.candidates.borrow_mut().clear();
        self.page.set(0);
        self.manual_page.set(false);
        self.refresh();
    }
    pub fn pitch(s: &Surface) -> f64 {
        s.line_pitch.get().max(1.0)
    }
    fn capacity(&self, s: &Surface) -> usize {
        let c = s.config.borrow();
        let pitch = Self::pitch(s);
        let width = c.bounds.width - (s.view.left_margin() + s.view.right_margin()) as f64;
        let minimum = self.minimum_width.get();
        if width < minimum + pitch * 1.7 {
            return 0;
        }
        let viewport = (c.bounds.height - c.appearance.bottom_inset).max(0.0);
        let room = if s.focused.get() {
            viewport / 2.0 - pitch / 2.0
        } else {
            viewport - pitch
        };
        (room / pitch).floor().max(0.0).min(4.0) as usize
    }
    pub fn refresh(&self) {
        let Some(s) = self.surface.upgrade() else {
            return;
        };
        let c = s.config.borrow();
        let metrics = (
            c.bounds.width,
            c.bounds.height,
            Self::pitch(&s),
            s.focused.get(),
        );
        let metrics_changed = self.metrics.replace(metrics) != metrics;
        self.minimum_width
            .set(s.view.create_pango_layout(Some("1. 中…")).pixel_size().0 as f64);
        let width =
            (c.bounds.width - (s.view.left_margin() + s.view.right_margin()) as f64).max(1.0);
        let pitch = Self::pitch(&s);
        let gap = s.view.create_pango_layout(Some("  ")).pixel_size().0.max(1) as f64;
        let controls = pitch * 1.7;
        let result = layout::layout(
            &self.candidates.borrow(),
            if self.manual_page.get() {
                -1
            } else {
                self.cursor.get()
            },
            self.page.get(),
            (width - controls).max(1.0),
            pitch,
            gap,
            self.capacity(&s).max(1),
            |text| s.view.create_pango_layout(Some(text)).pixel_size().0 as f64,
        );
        self.page.set(result.page_start);
        let rows = result.rows;
        *self.layout.borrow_mut() = Some(result);
        drop(c);
        let changed = self.height.replace(rows as f64 * pitch) != rows as f64 * pitch;
        if changed || metrics_changed {
            s.appearance();
            s.position();
            s.defer_center();
        }
        self.arrange();
        self.widget.queue_draw();
    }
    pub fn arrange(&self) {
        let Some(s) = self.surface.upgrade() else {
            return;
        };
        let c = s.config.borrow();
        if self.metrics.get()
            != (
                c.bounds.width,
                c.bounds.height,
                Self::pitch(&s),
                s.focused.get(),
            )
        {
            drop(c);
            self.refresh();
            return;
        }
        let height = self.height.get();
        let viewport = (c.bounds.height - c.appearance.bottom_inset).max(1.0);
        let scroll_height = s.editor_height();
        if s.scroll.size_request() != (c.bounds.width as i32, scroll_height as i32) {
            s.scroll
                .set_size_request(c.bounds.width as i32, scroll_height as i32);
        }
        if height == 0.0 || !s.visible.get() || !s.view.has_focus() {
            self.widget.hide();
            return;
        }
        let (cursor, _) = s.view.cursor_locations(None);
        let (_, cy) =
            s.view
                .buffer_to_window_coords(gtk::TextWindowType::Widget, cursor.x(), cursor.y());
        let pitch = Self::pitch(&s);
        // Baseline-to-baseline pitch, including the TextView's leading.
        let mode = if s.focused.get() {
            layout::Mode::Focus
        } else {
            layout::Mode::Bottom
        };
        let geometry = layout::geometry(
            mode,
            viewport,
            cy as f64 + cursor.height() as f64 / 2.0 - pitch / 2.0,
            pitch,
            (height / pitch).round() as usize,
        );
        let y = geometry.candidates_top;
        let visible_height = height.min((viewport - y).max(0.0));
        self.widget.set_margin_start(s.scroll.margin_start());
        self.widget
            .set_margin_top(s.scroll.margin_top() + y.max(0.0).round() as i32);
        self.widget
            .set_size_request(c.bounds.width as i32, visible_height.ceil().max(1.0) as i32);
        self.widget.show();
    }
    fn draw(&self, cr: &gtk::cairo::Context) {
        let Some(s) = self.surface.upgrade() else {
            return;
        };
        let c = s.config.borrow();
        // This is the continuous paper surface, not a popup background. It keeps
        // underlying document glyphs from bleeding into the temporary candidate rows.
        let background = gdk::RGBA::parse(&c.appearance.background).unwrap_or(gdk::RGBA::WHITE);
        cr.set_source_rgba(background.red(), background.green(), background.blue(), 1.0);
        let _ = cr.paint();
        let color = gdk::RGBA::parse(&c.appearance.foreground).unwrap_or(gdk::RGBA::BLACK);
        cr.set_source_rgba(color.red(), color.green(), color.blue(), color.alpha());
        let Some(l) = self.layout.borrow().as_ref().cloned() else {
            return;
        };
        let pitch = Self::pitch(&s);
        for item in &l.placements {
            let text = s.view.create_pango_layout(Some(&item.text));
            if item.index == self.cursor.get() {
                let attrs = pango::AttrList::new();
                attrs.insert(pango::AttrInt::new_underline(pango::Underline::Single));
                text.set_attributes(Some(&attrs));
            }
            cr.move_to(
                s.view.left_margin() as f64 + item.x,
                item.y + (pitch - text.pixel_size().1 as f64) / 2.0,
            );
            show_layout(cr, &text);
        }
        if l.page_start > 0
            || l.page_end < self.candidates.borrow().len()
            || self.previous.get()
            || self.next.get()
        {
            let text = s.view.create_pango_layout(Some("‹  ›"));
            cr.move_to(
                c.bounds.width - s.view.right_margin() as f64 - text.pixel_size().0 as f64,
                (l.rows.saturating_sub(1)) as f64 * pitch
                    + (pitch - text.pixel_size().1 as f64) / 2.0,
            );
            show_layout(cr, &text);
        }
    }
    fn click(&self, (x, y): (f64, f64)) {
        let Some(s) = self.surface.upgrade() else {
            return;
        };
        let pitch = Self::pitch(&s);
        let layout = self.layout.borrow();
        let Some(l) = layout.as_ref() else {
            return;
        };
        let relative = x - s.view.left_margin() as f64;
        if let Some(item) = l
            .placements
            .iter()
            .find(|p| relative >= p.x && relative < p.x + p.width && y >= p.y && y < p.y + pitch)
        {
            self.call(
                "Select",
                (self.token.clone(), self.serial.get(), item.index).to_variant(),
            );
        } else {
            let width = s.config.borrow().bounds.width - s.view.right_margin() as f64;
            if x > width - pitch * 1.7 {
                drop(layout);
                self.turn_page(x > width - pitch * 0.85);
            }
        }
    }
    fn turn_page(&self, next: bool) {
        let layout = self.layout.borrow();
        let Some(l) = layout.as_ref() else {
            return;
        };
        if next && l.page_end < self.candidates.borrow().len() {
            self.page.set(l.page_end);
            self.manual_page.set(true);
            drop(layout);
            self.refresh();
        } else if !next && l.page_start > 0 {
            // Layout selects the page containing this index, rather than guessing
            // how many variable-width candidates fit in four rows.
            self.page.set(l.page_start - 1);
            self.manual_page.set(true);
            drop(layout);
            self.refresh();
        } else {
            drop(layout);
            self.call(
                "Page",
                (self.token.clone(), self.serial.get(), next).to_variant(),
            );
        }
    }
}
impl Drop for Panel {
    fn drop(&mut self) {
        self.release();
        if let Some(bus) = &self.bus {
            for id in self.subscriptions.borrow_mut().drain(..) {
                bus.signal_unsubscribe(id);
            }
        }
        if let Some(s) = self.surface.upgrade() {
            if self.widget.parent().as_ref() == Some(s.overlay.upcast_ref()) {
                s.overlay.remove(&self.widget);
            }
        }
    }
}
fn show_layout(cr: &gtk::cairo::Context, layout: &pango::Layout) {
    use glib::translate::ToGlibPtr;
    unsafe {
        pango_cairo_show_layout(cr.to_raw_none(), layout.to_glib_none().0);
    }
}
#[link(name = "pangocairo-1.0")]
extern "C" {
    fn pango_cairo_show_layout(
        cr: *mut gtk::cairo::ffi::cairo_t,
        layout: *mut pango::ffi::PangoLayout,
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        sync::Arc,
        time::{Duration, Instant},
    };
    fn settle() {
        let end = Instant::now() + Duration::from_millis(150);
        while Instant::now() < end {
            while gtk::events_pending() {
                gtk::main_iteration_do(false);
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    fn wait(check: impl Fn() -> bool) {
        for _ in 0..30 {
            settle();
            if check() {
                return;
            }
        }
        panic!("native candidate condition timed out");
    }
    fn focused_context(bus: &gio::DBusConnection, programs: &[String]) -> Option<String> {
        let (info,) = bus
            .call_sync(
                Some(SERVICE),
                "/controller",
                "org.fcitx.Fcitx.Controller1",
                "DebugInfo",
                Some(&().to_variant()),
                None,
                gio::DBusCallFlags::NONE,
                1000,
                None::<&gio::Cancellable>,
            )
            .unwrap()
            .get::<(String,)>()
            .unwrap();
        info.lines()
            .find(|line| {
                line.contains(" frontend:dbus ")
                    && line.ends_with(" focus:1")
                    && programs
                        .iter()
                        .any(|program| line.contains(&format!(" program:{program} ")))
            })
            .and_then(|line| line.split("IC [").nth(1)?.split(']').next())
            .map(str::to_owned)
    }
    fn keys(args: &[&str]) {
        let mut child = std::process::Command::new("wtype")
            .args(["-s", "150", "-d", "80"])
            .args(args)
            .args(["-s", "200"])
            .spawn()
            .unwrap();
        loop {
            settle();
            if let Some(status) = child.try_wait().unwrap() {
                assert!(status.success());
                break;
            }
        }
        settle();
    }
    fn screenshot(name: &str) {
        if let Ok(dir) = std::env::var("SUMI_CANDIDATE_TEST_ARTIFACTS") {
            assert!(std::process::Command::new("grim")
                .arg(format!("{dir}/{name}.png"))
                .status()
                .unwrap()
                .success());
        }
    }
    #[test]
    #[ignore = "private Wayland display + private D-Bus + Fcitx addon only"]
    fn native_candidate_roundtrip() {
        assert_eq!(
            std::env::var("SUMI_FCITX_ISOLATED_TEST").as_deref(),
            Ok("1")
        );
        gtk::init().unwrap();
        struct Keyboard(std::process::Child);
        impl Drop for Keyboard {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let _keyboard = Keyboard(
            std::process::Command::new("wtype")
                .args(["-s", "60000"])
                .spawn()
                .unwrap(),
        );
        settle();
        let app = gtk::Application::new(
            Some("net.notemd.sumi.candidate-test"),
            gio::ApplicationFlags::NON_UNIQUE,
        );
        app.register(None::<&gio::Cancellable>).unwrap();
        let window = gtk::ApplicationWindow::new(&app);
        window.set_default_size(900, 650);
        let child = gtk::DrawingArea::new();
        window.add(&child);
        let mut appearance = Appearance::default();
        appearance.focus_typing = false;
        let config = SurfaceConfig {
            surface_id: "candidate-test".into(),
            generation: 1,
            revision: 0,
            bounds: Bounds {
                x: 0.0,
                y: 0.0,
                width: 900.0,
                height: 650.0,
            },
            appearance,
            document: RenderDocument {
                text: String::new(),
                runs: vec![],
            },
            selection: TextRange::default(),
            viewport: Viewport::default(),
        };
        let rich = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let fail = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let fail_handler = fail.clone();
        let replacements = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let rich_handler = rich.clone();
        let recorded = replacements.clone();
        let handler: EventHandler = Arc::new(move |event| {
            Ok(match event {
                NativeEvent::Edit {
                    base_revision,
                    replacement,
                    ..
                } => {
                    recorded.lock().unwrap().push(replacement.clone());
                    if fail_handler.load(std::sync::atomic::Ordering::SeqCst) {
                        EventReply {
                            revision: base_revision,
                            projection: Some(Projection {
                                document: RenderDocument {
                                    text: "你好".into(),
                                    runs: vec![],
                                },
                                selection: TextRange {
                                    start: 2,
                                    length: 0,
                                },
                            }),
                            clipboard_text: None,
                            draft_error: Some("isolated journal failure".into()),
                        }
                    } else if rich_handler.load(std::sync::atomic::Ordering::SeqCst)
                        && replacement == "你好"
                    {
                        EventReply {
                            revision: base_revision + 1,
                            projection: Some(Projection {
                                document: RenderDocument {
                                    text: "你好".into(),
                                    runs: vec![StyleRun {
                                        range: TextRange {
                                            start: 0,
                                            length: 2,
                                        },
                                        bold: true,
                                        italic: false,
                                        strike: false,
                                        heading: 0,
                                        quote: false,
                                        link: None,
                                    }],
                                },
                                selection: TextRange {
                                    start: 0,
                                    length: 0,
                                },
                            }),
                            clipboard_text: None,
                            draft_error: None,
                        }
                    } else {
                        (base_revision + 1).into()
                    }
                }
                _ => 0.into(),
            })
        });
        mount(
            &window,
            "candidate-test",
            config,
            handler,
            Some(child.upcast()),
        )
        .unwrap();
        window.show_all();
        window.present();
        settle();
        let s = surface("candidate-test", "candidate-test", 1).unwrap();
        s.view.grab_focus();
        settle();
        let p = s.candidates.borrow().as_ref().unwrap().clone();
        p.sync_active();
        settle();
        let bus = p.bus.as_ref().unwrap();
        for (method, args) in [
            ("SetCurrentIM", ("pinyin",).to_variant()),
            ("Activate", ().to_variant()),
        ] {
            bus.call_sync(
                Some(SERVICE),
                "/controller",
                "org.fcitx.Fcitx.Controller1",
                method,
                Some(&args),
                None,
                gio::DBusCallFlags::NONE,
                1000,
                None::<&gio::Cancellable>,
            )
            .unwrap();
        }
        keys(&["nihao"]);
        screenshot("diagnostic");
        eprintln!("candidate diagnostics focus={} accepted={} desired={} serial={} programs={:?} preedit={:?} text={:?} candidates={:?}",s.view.has_focus(),p.accepted.get(),p.desired.get(),p.serial.get(),p.programs(),s.preedit.borrow(),text(&s.buffer()),p.candidates.borrow());
        wait(|| {
            p.candidates
                .borrow()
                .iter()
                .any(|c| c.text.contains("你好"))
        });
        assert!(s.composing.get());
        assert!(text(&s.buffer()).is_empty());
        assert!(p.widget.is_visible());
        assert!(p.height.get() > 0.0);
        let (cursor, _) = s.view.cursor_locations(None);
        let (_, y) =
            s.view
                .buffer_to_window_coords(gtk::TextWindowType::Widget, cursor.x(), cursor.y());
        let expected = 650.0
            - s.config.borrow().appearance.bottom_inset
            - p.height.get()
            - Panel::pitch(&s) / 2.0;
        assert!(
            (y as f64 + cursor.height() as f64 / 2.0 - expected).abs() < 3.0,
            "bottom line y={y}, cursor={}, expected={expected}",
            cursor.height()
        );
        screenshot("bottom-real-nihao");
        let wanted = p
            .candidates
            .borrow()
            .iter()
            .find(|c| c.text.contains("你好"))
            .unwrap()
            .index;
        p.call(
            "Select",
            (p.token.clone(), p.serial.get(), wanted).to_variant(),
        );
        settle();
        eprintln!(
            "after select text={:?} composing={} preedit={:?} rows={} serial={}",
            text(&s.buffer()),
            s.composing.get(),
            s.preedit.borrow(),
            p.height.get(),
            p.serial.get()
        );
        wait(|| text(&s.buffer()) == "你好");
        wait(|| p.height.get() == 0.0);
        assert!(!s.composing.get());
        // A Markdown projection removes delimiters and restyles the committed
        // text while GTK still owns the native IM commit transaction.
        rich.store(true, std::sync::atomic::Ordering::SeqCst);
        replacements.lock().unwrap().clear();
        let revision = s.config.borrow().revision;
        s.project(
            RenderDocument {
                text: "**".into(),
                runs: vec![],
            },
            TextRange {
                start: 2,
                length: 0,
            },
            revision,
        );
        keys(&["nihao"]);
        wait(|| {
            p.candidates
                .borrow()
                .iter()
                .any(|c| c.text.contains("你好"))
        });
        let wanted = p
            .candidates
            .borrow()
            .iter()
            .find(|c| c.text.contains("你好"))
            .unwrap()
            .index;
        p.call(
            "Select",
            (p.token.clone(), p.serial.get(), wanted).to_variant(),
        );
        settle();
        eprintln!(
            "rich projection text={:?}, replacements={:?}",
            text(&s.buffer()),
            replacements.lock().unwrap()
        );
        wait(|| !s.composing.get());
        assert_eq!(text(&s.buffer()), "你好");
        assert_eq!(*replacements.lock().unwrap(), vec!["你好".to_string()]);
        assert_eq!(
            s.selection().start,
            0,
            "rich projection's deferred selection must apply"
        );
        rich.store(false, std::sync::atomic::Ordering::SeqCst);
        // Narrow presentation must paginate without changing the document.
        let original = (text(&s.buffer()), s.selection(), s.config.borrow().revision);
        *p.candidates.borrow_mut() = (0..30)
            .map(|i| Candidate {
                index: i,
                label: format!("{}.", i + 1),
                text: format!("候选文字{i}"),
            })
            .collect();
        p.cursor.set(0);
        s.config.borrow_mut().bounds.width = 360.0;
        s.appearance();
        p.refresh();
        settle();
        assert_eq!(p.layout.borrow().as_ref().unwrap().rows, 4);
        let allocation = s.scroll.allocation();
        assert_eq!(
            allocation.width(),
            360,
            "native allocation must follow host width"
        );
        assert_eq!(
            allocation.height(),
            s.editor_height() as i32,
            "candidate rows must be excluded from the text viewport"
        );
        settle();
        assert_eq!(
            s.scroll.allocation(),
            allocation,
            "candidate resize must settle"
        );
        // Capture the full writing width after the narrow-width pagination check.
        s.config.borrow_mut().bounds.width = 900.0;
        s.appearance();
        p.refresh();
        settle();
        assert_eq!(p.layout.borrow().as_ref().unwrap().rows, 4);
        screenshot("bottom-four-rows");
        // The independent caret window must not escape the shortened text
        // viewport when reading scroll moves the insertion point below it.
        let saved = s.config.borrow().clone();
        let sample = "line\n".repeat(20) + "cursor";
        let end = sample.len() as u32;
        s.project(
            RenderDocument {
                text: sample,
                runs: vec![],
            },
            TextRange {
                start: end,
                length: 0,
            },
            saved.revision,
        );
        s.appearance();
        s.center();
        settle();
        s.pointer_tracking.set(true);
        let adjustment = s.scroll.vadjustment();
        adjustment.set_value(adjustment.value() - Panel::pitch(&s) * 2.0);
        settle();
        let cursor = s.caret_geometry();
        let (_, y) =
            s.view
                .buffer_to_window_coords(gtk::TextWindowType::Widget, cursor.x(), cursor.y());
        assert!(
            y >= s.editor_height() as i32 && y < 650,
            "test caret must be in the reserved candidate area: y={y}"
        );
        s.tick_focus();
        assert!(
            !s.caret.is_visible(),
            "caret must not paint over candidates"
        );
        s.pointer_tracking.set(false);
        s.project(saved.document, saved.selection, saved.revision);
        s.appearance();
        s.center();
        settle();
        s.focused.set(true);
        s.appearance();
        s.center();
        p.refresh();
        settle();
        let (cursor, _) = s.view.cursor_locations(None);
        let (_, y) =
            s.view
                .buffer_to_window_coords(gtk::TextWindowType::Widget, cursor.x(), cursor.y());
        let candidate_center = p.widget.margin_top() - s.scroll.margin_top();
        assert!(
            (candidate_center as f64 + Panel::pitch(&s) / 2.0
                - (y as f64 + cursor.height() as f64 / 2.0)
                - Panel::pitch(&s))
            .abs()
                < 3.0
        );
        screenshot("focus-four-rows");
        assert_eq!(text(&s.buffer()), original.0);
        assert_eq!(s.selection().start, original.1.start);
        assert_eq!(s.config.borrow().revision, original.2);
        p.candidates.borrow_mut().clear();
        p.refresh();
        // A sibling input uses normal Fcitx UI, never Sumi's candidate lease.
        let sumi_context = focused_context(bus, &p.programs()).expect("focused Sumi context");
        let entry = gtk::Entry::new();
        entry.set_halign(gtk::Align::Start);
        entry.set_valign(gtk::Align::Start);
        entry.set_size_request(300, 40);
        s.overlay.add_overlay(&entry);
        entry.show();
        entry.grab_focus();
        // GTK focus signals precede asynchronous Fcitx FocusIn. Activate only
        // after the daemon sees the new context, not its most-recent old one.
        wait(|| focused_context(bus, &p.programs()).is_some_and(|id| id != sumi_context));
        assert!(!p.desired.get());
        assert!(!p.widget.is_visible());
        for (method, args) in [
            ("SetCurrentIM", ("pinyin",).to_variant()),
            ("Activate", ().to_variant()),
        ] {
            bus.call_sync(
                Some(SERVICE),
                "/controller",
                "org.fcitx.Fcitx.Controller1",
                method,
                Some(&args),
                None,
                gio::DBusCallFlags::NONE,
                1000,
                None::<&gio::Cancellable>,
            )
            .unwrap();
        }
        keys(&["nihao"]);
        keys(&["-k", "space"]);
        assert_eq!(entry.text().as_str(), "你好");
        s.overlay.remove(&entry);
        s.view.grab_focus();
        wait(|| p.accepted.get());
        // A width that cannot show a complete candidate falls back to Fcitx.
        s.config.borrow_mut().bounds.width = 60.0;
        s.appearance();
        p.refresh();
        wait(|| !p.desired.get());
        assert!(!p.widget.is_visible());
        s.config.borrow_mut().bounds.width = 700.0;
        s.appearance();
        p.refresh();
        wait(|| p.accepted.get());
        // Restart only the fixture daemon on this private bus. Both the GTK
        // module and the display bridge must reconnect without another focus.
        let _replacement = Keyboard(std::process::Command::new("fcitx5")
            .args(["--replace","--disable","all","--enable","dbus,dbusfrontend,keyboard,pinyin,pinyinhelper,punctuation,chttrans,spell,sumicandidates,wayland,waylandim,classicui"])
            .stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn().unwrap());
        settle();
        wait(|| p.accepted.get());
        settle();
        for (method, args) in [
            ("SetCurrentIM", ("pinyin",).to_variant()),
            ("Activate", ().to_variant()),
        ] {
            bus.call_sync(
                Some(SERVICE),
                "/controller",
                "org.fcitx.Fcitx.Controller1",
                method,
                Some(&args),
                None,
                gio::DBusCallFlags::NONE,
                1000,
                None::<&gio::Cancellable>,
            )
            .unwrap();
        }
        keys(&["nihao"]);
        wait(|| {
            p.candidates
                .borrow()
                .iter()
                .any(|c| c.text.contains("你好"))
        });
        keys(&["-k", "space"]);
        wait(|| !s.composing.get());
        assert_eq!(text(&s.buffer()), "你好你好");
        // A failed journal must retain only the committed draft, never raw IME text.
        fail.store(true, std::sync::atomic::Ordering::SeqCst);
        replacements.lock().unwrap().clear();
        let revision = s.config.borrow().revision;
        s.project(RenderDocument::default(), TextRange::default(), revision);
        keys(&["nihao"]);
        wait(|| {
            p.candidates
                .borrow()
                .iter()
                .any(|c| c.text.contains("你好"))
        });
        let wanted = p
            .candidates
            .borrow()
            .iter()
            .find(|c| c.text.contains("你好"))
            .unwrap()
            .index;
        p.call(
            "Select",
            (p.token.clone(), p.serial.get(), wanted).to_variant(),
        );
        settle();
        eprintln!(
            "draft failure text={:?} replacements={:?}",
            text(&s.buffer()),
            replacements.lock().unwrap()
        );
        assert!(s.failed.get());
        assert_eq!(s.config.borrow().revision, revision);
        assert_eq!(text(&s.buffer()), "你好");
        assert_eq!(*replacements.lock().unwrap(), vec!["你好".to_string()]);
        assert!(detach("candidate-test", "candidate-test", 1).is_err());
        detach_window("candidate-test");
        window.close();
        settle();
    }
}
