//! Presentation only: GTK owns layout, caret/IME geometry and hit testing.
//! Alpha is composited over each actual display line; no alternate text buffer.
use super::*;
use std::{
    collections::VecDeque,
    time::{Duration, Instant},
};

type CaretKey = (u32, u32, String, String, String, bool, bool);
pub(super) struct CaretMetrics {
    key: CaretKey,
    ascent: f64,
    height: f64,
    runs: Vec<(f64, f64)>,
}

pub(super) struct Frame {
    inputs: VecDeque<Instant>,
    from: f64,
    target: f64,
    started: Instant,
    duration: f64,
    animate_next: bool,
    spatial: Option<(Instant, f64, f64)>,
    drawn_alpha: f64,
}
impl Frame {
    pub(super) fn new(active: bool) -> Self {
        Self {
            inputs: VecDeque::new(),
            from: if active { 1.0 } else { 0.0 },
            target: if active { 1.0 } else { 0.0 },
            started: Instant::now(),
            duration: 0.2,
            animate_next: false,
            spatial: None,
            drawn_alpha: if active { 1.0 } else { 0.0 },
        }
    }
    fn value(&self, now: Instant) -> f64 {
        let t = (now.saturating_duration_since(self.started).as_secs_f64() / self.duration)
            .clamp(0.0, 1.0);
        self.from + (self.target - self.from) * t * t * (3.0 - 2.0 * t)
    }
    fn sample(&mut self, now: Instant, last: Option<Instant>) -> f64 {
        if let Some(last) = last {
            let idle = last + Duration::from_secs(10);
            if now >= idle && self.target != 0.0 {
                self.from = self.value(idle);
                self.target = 0.0;
                self.started = idle;
                self.duration = 1.2;
            }
        }
        self.value(now)
    }
    fn input(&mut self, now: Instant, previous: Option<Instant>) -> usize {
        let current = self.sample(now, previous);
        while self
            .inputs
            .front()
            .is_some_and(|t| now.saturating_duration_since(*t) > Duration::from_secs(2))
        {
            self.inputs.pop_front();
        }
        self.inputs.push_back(now);
        if self.target != 1.0 {
            self.from = current;
            self.target = 1.0;
            self.started = now;
            self.duration = 0.2;
        }
        self.inputs.len()
    }
}
fn row_alpha(distance: f64, pitch: f64, half: f64) -> f64 {
    0.55_f64.powf(distance / pitch.max(1.0)) * (1.0 - (distance / half.max(1.0)).powi(2)).max(0.0)
}
fn rgb(hex: &str) -> (f64, f64, f64) {
    let n = u32::from_str_radix(hex.strip_prefix('#').unwrap_or(hex), 16).unwrap_or(0);
    (
        ((n >> 16) & 255) as f64 / 255.0,
        ((n >> 8) & 255) as f64 / 255.0,
        (n & 255) as f64 / 255.0,
    )
}
impl Surface {
    pub(super) fn caret_geometry(&self) -> gdk::Rectangle {
        let (native, _) = self.view.cursor_locations(None);
        let context = self.view.pango_context();
        let description = context.font_description();
        let language = context.language();
        let buffer = self.buffer();
        let mut start = buffer.iter_at_mark(&buffer.get_insert().expect("insert mark"));
        if !start.is_cursor_position() {
            start.backward_cursor_position();
        }
        if start.ends_line() && !start.starts_line() {
            start.backward_cursor_position();
        }
        let mut end = start;
        end.forward_cursor_position();
        let preedit = self.preedit.borrow();
        let text = if !preedit.is_empty() {
            preedit.to_string()
        } else {
            buffer
                .text(&start, &end, true)
                .map(|s| s.to_string())
                .filter(|s| !s.is_empty() && s != "\n")
                .unwrap_or_else(|| " ".into())
        };
        let tags = start.tags();
        let bold = tags
            .iter()
            .any(|tag| tag.is_weight_set() && tag.weight() >= 700);
        let italic = tags
            .iter()
            .any(|tag| tag.is_style_set() && tag.style() == pango::Style::Italic);
        let key = (
            context.serial(),
            context.font_map().map(|map| map.serial()).unwrap_or(0),
            description
                .as_ref()
                .map(ToString::to_string)
                .unwrap_or_default(),
            language
                .as_ref()
                .map(ToString::to_string)
                .unwrap_or_default(),
            text.clone(),
            bold,
            italic,
        );
        let mut cached = self.caret_metrics.borrow_mut();
        if cached.as_ref().is_none_or(|cache| cache.key != key) {
            let metrics = context.metrics(description.as_ref(), language.as_ref());
            let attrs = pango::AttrList::new();
            if bold {
                attrs.insert(pango::AttrInt::new_weight(pango::Weight::Bold));
            }
            if italic {
                attrs.insert(pango::AttrInt::new_style(pango::Style::Italic));
            }
            let mut runs = Vec::new();
            for item in pango::itemize(&context, &text, 0, text.len() as i32, &attrs, None) {
                let mut glyphs = pango::GlyphString::new();
                let offset = item.offset() as usize;
                pango::shape(
                    &text[offset..offset + item.length() as usize],
                    item.analysis(),
                    &mut glyphs,
                );
                // Font metrics alone do not include bitmap emoji strike scaling.
                let (_, logical) = glyphs.extents(&item.analysis().font());
                runs.push((
                    -logical.y() as f64 / pango::SCALE as f64,
                    logical.height() as f64 / pango::SCALE as f64,
                ));
            }
            *cached = Some(CaretMetrics {
                key,
                ascent: metrics.ascent() as f64 / pango::SCALE as f64,
                height: (metrics.ascent() + metrics.descent()) as f64 / pango::SCALE as f64,
                runs,
            });
        }
        let cache = cached.as_ref().unwrap();
        let mut matches = cache
            .runs
            .iter()
            .filter(|(_, height)| (*height - native.height() as f64).abs() < 1.1);
        let Some((ascent, _)) = matches.next() else {
            return native;
        };
        // GTK exposes preedit text but not its cursor offset. Its native run
        // height identifies ordinary CJK/Latin/emoji runs. If equally tall runs
        // have different baselines, retain GTK's exact rectangle instead of
        // inventing a baseline for an ambiguous composition.
        if matches.any(|(other, _)| (other - ascent).abs() > 0.5) {
            return native;
        }
        gdk::Rectangle::new(
            native.x(),
            (native.y() as f64 + ascent - cache.ascent).round() as i32,
            native.width(),
            cache.height.round().max(1.0) as i32,
        )
    }
    pub(super) fn typing(&self) {
        if self.failed.get() || !self.visible.get() || !self.config.borrow().appearance.focus_typing
        {
            return;
        }
        let now = Instant::now();
        let count = self
            .focus_frame
            .borrow_mut()
            .input(now, self.last_input.get());
        self.last_input.set(Some(now));
        if self.focused.get() || self.resume_focus.get() || count >= 4 {
            let entered = !self.focused.replace(true);
            if entered {
                let mut frame = self.focus_frame.borrow_mut();
                frame.from = 0.0;
                frame.target = 1.0;
                frame.started = now;
                frame.duration = 0.2;
                frame.animate_next = true;
                drop(frame);
                self.appearance();
            }
            self.center();
        }
        self.decoration.queue_draw();
    }
    pub(super) fn reading(&self) {
        if self.pointer_tracking.get() {
            return;
        }
        if self.focused.replace(false) {
            self.resume_focus.set(true);
            self.focus_frame.borrow_mut().spatial = None;
            self.appearance();
            self.decoration.queue_draw();
        }
    }
    pub(super) fn reset_focus(&self) {
        self.focused.set(false);
        self.resume_focus.set(false);
        self.pointer_tracking.set(false);
        self.last_input.set(None);
        *self.focus_frame.borrow_mut() = Frame::new(false);
        self.appearance();
        self.decoration.queue_draw();
    }
    pub(super) fn center(&self) {
        if !self.focused.get() || self.pointer_tracking.get() {
            return;
        }
        // GTK's own scrolling changes rendering, hit testing and IME rectangles together.
        let (cursor, _) = self.view.cursor_locations(None);
        let c = self.config.borrow();
        let height = (c.bounds.height - c.appearance.bottom_inset).max(1.0);
        drop(c);
        let adjustment = self.scroll.vadjustment();
        // GTK's scroll adjustment includes the text view's top margin, while
        // buffer coordinates do not. Move by the actual window-space delta.
        let (_, y) =
            self.view
                .buffer_to_window_coords(gtk::TextWindowType::Widget, cursor.x(), cursor.y());
        let target = adjustment.value() + y as f64 + cursor.height() as f64 / 2.0 - height / 2.0;
        let target = target.clamp(
            adjustment.lower(),
            (adjustment.upper() - adjustment.page_size()).max(adjustment.lower()),
        );
        let mut frame = self.focus_frame.borrow_mut();
        let animations = self
            .view
            .settings()
            .is_some_and(|settings| settings.is_gtk_enable_animations());
        if frame.animate_next && animations && self.view.has_focus() {
            frame.spatial = Some((Instant::now(), adjustment.value(), target));
            frame.animate_next = false;
            return;
        }
        frame.animate_next = false;
        if let Some((start, from, _)) = frame.spatial {
            frame.spatial = Some((start, from, target));
            return;
        }
        drop(frame);
        let was = self.updating.replace(true);
        adjustment.set_value(target);
        self.updating.set(was);
    }
    pub(super) fn tick_focus(&self) {
        let mut frame = self.focus_frame.borrow_mut();
        if self.pointer_tracking.get() || !self.focused.get() || self.failed.get() {
            frame.spatial = None;
        }
        let offset = frame.spatial.map(|(start, from, target)| {
            let t = (start.elapsed().as_secs_f64() / 0.2).clamp(0.0, 1.0);
            if t >= 1.0 {
                frame.spatial = None;
            }
            from + (target - from) * t * t * (3.0 - 2.0 * t)
        });
        let alpha = if self.focused.get() {
            frame.sample(Instant::now(), self.last_input.get())
        } else {
            0.0
        };
        let changed = (alpha - frame.drawn_alpha).abs() > 0.0001;
        frame.drawn_alpha = alpha;
        drop(frame);
        if let Some(offset) = offset {
            let was = self.updating.replace(true);
            self.scroll.vadjustment().set_value(offset);
            self.updating.set(was);
        }
        if changed || offset.is_some() {
            self.decoration.queue_draw();
        }
        if self.buffer().has_selection()
            || !self.visible.get()
            || !self.view.has_focus()
            || self.failed.get()
        {
            self.caret.hide();
            return;
        }
        let cursor = self.caret_geometry();
        let (x, y) =
            self.view
                .buffer_to_window_coords(gtk::TextWindowType::Widget, cursor.x(), cursor.y());
        let config = self.config.borrow();
        let width = (config.appearance.font_size / 11.0).clamp(2.0, 3.0).ceil() as i32;
        let height = cursor.height().max(1);
        if y < 0
            || y + height > config.bounds.height as i32
            || x < 0
            || x >= config.bounds.width as i32
        {
            self.caret.hide();
            return;
        }
        let x = self.scroll.margin_start() + x;
        let y = self.scroll.margin_top() + y;
        if self.caret.margin_start() != x {
            self.caret.set_margin_start(x);
        }
        if self.caret.margin_top() != y {
            self.caret.set_margin_top(y);
        }
        if self.caret.size_request() != (width, height) {
            self.caret.set_size_request(width, height);
        }
        self.caret.show();
        // This widget owns only the few pixels of the caret. Invalidating the
        // full-size translucent focus overlay repaints the WebView behind it.
        if config.appearance.caret_motion == CaretMotion::Breathing {
            self.caret.queue_draw();
        }
    }
    pub(super) fn draw_caret(&self, cr: &gtk::cairo::Context) {
        let config = self.config.borrow();
        let (r, g, b) = rgb(&config.appearance.foreground);
        let alpha = if config.appearance.caret_motion == CaretMotion::Steady {
            1.0
        } else {
            0.625 + 0.375 * (self.phase.elapsed().as_secs_f64() * std::f64::consts::TAU / 4.0).cos()
        };
        cr.set_source_rgba(r, g, b, alpha);
        let _ = cr.paint();
    }
    pub(super) fn draw(&self, cr: &gtk::cairo::Context) {
        let c = self.config.borrow();
        let height = (c.bounds.height - c.appearance.bottom_inset).max(1.0);
        let width = c.bounds.width;
        // NULL iter asks GTK for the actual insertion cursor, including the IME
        // preedit cursor. iter_location(insert) would instead point before preedit.
        let (cursor, _) = self.view.cursor_locations(None);
        let (_, cy) =
            self.view
                .buffer_to_window_coords(gtk::TextWindowType::Widget, cursor.x(), cursor.y());
        let (_, clip_top, _, clip_bottom) = cr.clip_extents().unwrap_or((0.0, 0.0, width, height));
        if self.focused.get() && !self.failed.get() {
            let strength = self
                .focus_frame
                .borrow_mut()
                .sample(Instant::now(), self.last_input.get());
            let visible = self.view.visible_rect();
            let (mut iter, _) = self.view.line_at_y(visible.y());
            let active = cy as f64 + cursor.height() as f64 / 2.0;
            let mut rows = Vec::new();
            // Enumerate only the visible native visual lines, including soft wraps.
            loop {
                let rect = self.view.iter_location(&iter);
                let (_, y) = self.view.buffer_to_window_coords(
                    gtk::TextWindowType::Widget,
                    rect.x(),
                    rect.y(),
                );
                if y as f64 > height {
                    break;
                }
                if y + rect.height() >= 0 {
                    rows.push((y as f64, rect.height().max(1) as f64));
                }
                if !self.view.forward_display_line(&mut iter) {
                    break;
                }
            }
            let pitch = rows
                .windows(2)
                .map(|w| w[1].0 - w[0].0)
                .filter(|p| *p > 0.1)
                .fold(f64::INFINITY, f64::min);
            let pitch = if pitch.is_finite() {
                pitch
            } else {
                cursor.height().max(1) as f64
            };
            let (r, g, b) = rgb(&c.appearance.background);
            for (y, h) in rows {
                if y + h < clip_top || y > clip_bottom {
                    continue;
                }
                let distance = (y + h / 2.0 - active).abs();
                let alpha = if distance < 0.5 {
                    1.0
                } else if y <= 0.0 || y + h >= height {
                    0.0
                } else {
                    row_alpha(distance, pitch, height / 2.0)
                };
                cr.set_source_rgba(r, g, b, (1.0 - alpha) * strength);
                cr.rectangle(0.0, y, width, h);
                let _ = cr.fill();
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pause_and_resume_are_continuous() {
        let start = Instant::now();
        let mut frame = Frame::new(true);
        frame.started = start;
        assert_eq!(
            frame.sample(start + Duration::from_secs(9), Some(start)),
            1.0
        );
        let middle = frame.sample(start + Duration::from_millis(10600), Some(start));
        assert!((middle - 0.5).abs() < 0.001);
        let resumed = start + Duration::from_millis(10600);
        frame.input(resumed, Some(start));
        assert!((frame.value(resumed) - middle).abs() < 0.001);
        assert_eq!(frame.value(resumed + Duration::from_millis(200)), 1.0);
    }
    #[test]
    fn line_fade_matches_native_pitch_and_edges() {
        assert_eq!(row_alpha(0.0, 32.0, 320.0), 1.0);
        assert!((row_alpha(32.0, 32.0, 320.0) - 0.55).abs() < 0.01);
        assert!(row_alpha(64.0, 32.0, 320.0) < row_alpha(32.0, 32.0, 320.0));
        assert_eq!(row_alpha(320.0, 32.0, 320.0), 0.0);
    }
}

#[cfg(test)]
pub(super) fn verify_native_focus(s: &Surface) {
    fn settle() {
        for _ in 0..8 {
            while gtk::events_pending() {
                gtk::main_iteration_do(false);
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    let original = s.config.borrow().clone();
    let body = (0..60)
        .map(|i| format!("第{i}行 native wrapped layout verification 文字与 😀\n"))
        .collect::<String>();
    let at = body
        .lines()
        .take(30)
        .map(|l| l.encode_utf16().count() + 1)
        .sum::<usize>() as u32;
    s.project(
        RenderDocument {
            text: body.clone(),
            runs: vec![],
        },
        TextRange {
            start: at,
            length: 0,
        },
        original.revision,
    );
    s.failed.set(false);
    s.view.set_editable(true);
    s.reset_focus();
    for _ in 0..4 {
        s.typing();
    }
    settle();
    s.center();
    settle();
    let (cursor, _) = s.view.cursor_locations(None);
    let (_, y) =
        s.view
            .buffer_to_window_coords(gtk::TextWindowType::Widget, cursor.x(), cursor.y());
    let expected = (original.bounds.height - original.appearance.bottom_inset) / 2.0;
    assert!(
        (y as f64 + cursor.height() as f64 / 2.0 - expected).abs() < 3.0,
        "cursor midpoint {} != {expected}",
        y as f64 + cursor.height() as f64 / 2.0
    );
    let selection = s.selection();
    let revision = s.config.borrow().revision;
    s.pointer_tracking.set(true);
    s.reading();
    assert!(
        s.focused.get(),
        "pointer press must not move the displayed text"
    );
    s.pointer_tracking.set(false);
    s.reading();
    assert!(!s.focused.get());
    assert!(s.resume_focus.get());
    assert_eq!(s.selection().start, selection.start);
    s.typing();
    settle();
    s.center();
    settle();
    assert!(
        s.focused.get(),
        "first real input resumes focus after reading"
    );
    assert_eq!(s.config.borrow().revision, revision);
    assert_eq!(
        text(&s.buffer()),
        body,
        "presentation must never mutate text"
    );
    s.reset_focus();
    s.project(original.document, original.selection, original.revision);
}
