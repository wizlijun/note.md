//! GTK text surfaces share Tauri's main loop and Wayland connection. The host
//! remains the only document/undo owner; every mutation is acknowledged durably.
use super::*;
use gtk::{gdk, glib, pango, prelude::*};
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    rc::Rc,
};

#[path = "linux_candidates.rs"]
mod candidates;
#[path = "linux_caret.rs"]
mod caret;
#[path = "linux_focus.rs"]
mod focus;
#[path = "linux_rtf.rs"]
mod rtf;

type Key = (String, String);
thread_local! {
    static SURFACES: RefCell<HashMap<Key, Rc<Surface>>> = RefCell::new(HashMap::new());
    static TYPING: RefCell<Option<TypingSoundHandler>> = RefCell::new(None);
    static CASCADES: RefCell<HashMap<String, Vec<String>>> = RefCell::new(HashMap::new());
}
struct Surface {
    view: gtk::TextView,
    scroll: gtk::ScrolledWindow,
    overlay: gtk::Overlay,
    allocation_handler: RefCell<Option<glib::SignalHandlerId>>,
    origin: Option<gtk::Widget>,
    css: gtk::CssProvider,
    decoration: gtk::DrawingArea,
    caret: gtk::DrawingArea,
    candidates: RefCell<Option<Rc<candidates::Panel>>>,
    line_pitch: Cell<f64>,
    caret_metrics: RefCell<Option<focus::CaretMetrics>>,
    focused: Cell<bool>,
    resume_focus: Cell<bool>,
    focus_frame: RefCell<focus::Frame>,
    pointer_tracking: Cell<bool>,
    last_input: Cell<Option<std::time::Instant>>,
    phase: std::time::Instant,
    config: RefCell<SurfaceConfig>,
    handler: EventHandler,
    updating: Cell<bool>,
    layout_pending: Cell<bool>,
    user_action: Cell<u32>,
    preedit: RefCell<String>,
    pending_selection: RefCell<Option<PendingSelection>>,
    composing: Cell<bool>,
    failed: Cell<bool>,
    fullscreen_down: Cell<bool>,
    sound_keys: RefCell<std::collections::HashSet<u16>>,
    search: RefCell<String>,
    visible: Cell<bool>,
}
struct PendingSelection {
    range: TextRange,
    generation: u64,
    revision: u64,
    insert: i32,
    anchor: i32,
}
fn text(buffer: &gtk::TextBuffer) -> String {
    buffer
        .text(&buffer.start_iter(), &buffer.end_iter(), true)
        .map(|s| s.to_string())
        .unwrap_or_default()
}
fn utf16_offset(s: &str, chars: i32) -> u32 {
    s.chars()
        .take(chars.max(0) as usize)
        .map(|c| c.len_utf16() as u32)
        .sum()
}
fn char_offset(s: &str, units: u32) -> i32 {
    let mut total = 0;
    for (i, c) in s.chars().enumerate() {
        if total >= units {
            return i as i32;
        }
        total += c.len_utf16() as u32;
    }
    s.chars().count() as i32
}
fn difference(before: &str, after: &str) -> (TextRange, String) {
    let a: Vec<_> = before.chars().collect();
    let b: Vec<_> = after.chars().collect();
    let prefix = a.iter().zip(&b).take_while(|(a, b)| a == b).count();
    let suffix = a[prefix..]
        .iter()
        .rev()
        .zip(b[prefix..].iter().rev())
        .take_while(|(a, b)| a == b)
        .count();
    (
        TextRange {
            start: a[..prefix].iter().map(|c| c.len_utf16() as u32).sum(),
            length: a[prefix..a.len() - suffix]
                .iter()
                .map(|c| c.len_utf16() as u32)
                .sum(),
        },
        b[prefix..b.len() - suffix].iter().collect(),
    )
}
impl Surface {
    fn prepare_blank(self: &Rc<Self>) {
        let blank = {
            let config = self.config.borrow();
            config.appearance.focus_typing && config.document.text.is_empty()
        };
        if blank && self.visible.get() && !self.failed.get() && !self.focused.replace(true) {
            *self.focus_frame.borrow_mut() = focus::Frame::new(true);
            self.resume_focus.set(false);
            self.appearance();
            self.defer_center();
        }
    }
    fn defer_center(self: &Rc<Self>) {
        if self.layout_pending.replace(true) {
            return;
        }
        let weak = Rc::downgrade(self);
        glib::idle_add_local_once(move || {
            if let Some(surface) = weak.upgrade() {
                surface.layout_pending.set(false);
                surface.position();
                if surface.visible.get() && surface.focused.get() && !surface.failed.get() {
                    surface.center();
                    surface.decoration.queue_draw();
                }
            }
        });
    }
    fn position(&self) {
        let bounds = self.config.borrow().bounds.clone();
        let (origin_x, origin_y) = self
            .origin
            .as_ref()
            .and_then(|origin| origin.translate_coordinates(&self.overlay, 0, 0))
            .unwrap_or((0, 0));
        let x = bounds.x.max(0.0) as i32 + origin_x;
        let y = bounds.y.max(0.0) as i32 + origin_y;
        for (widget, height) in [
            (self.scroll.upcast_ref::<gtk::Widget>(), bounds.height),
            (self.decoration.upcast_ref::<gtk::Widget>(), bounds.height),
        ] {
            if widget.margin_start() != x {
                widget.set_margin_start(x);
            }
            if widget.margin_top() != y {
                widget.set_margin_top(y);
            }
            if widget.size_request() != (bounds.width as i32, height as i32) {
                widget.set_size_request(bounds.width as i32, height as i32);
            }
        }
    }
    fn buffer(&self) -> gtk::TextBuffer {
        self.view.buffer().expect("text buffer")
    }
    fn selection(&self) -> TextRange {
        let b = self.buffer();
        let t = text(&b);
        let (start, end) = b.selection_bounds().unwrap_or_else(|| {
            let i = b.iter_at_mark(&b.get_insert().expect("insert mark"));
            (i, i)
        });
        let start = utf16_offset(&t, start.offset());
        TextRange {
            start,
            length: utf16_offset(&t, end.offset()) - start,
        }
    }
    fn identity(&self) -> (String, u64, u64) {
        let c = self.config.borrow();
        (c.surface_id.clone(), c.generation, c.revision)
    }
    fn dispatch(&self, event: NativeEvent) -> Result<EventReply, String> {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| (self.handler)(event)))
            .unwrap_or_else(|_| Err("native host callback failed".into()))
    }
    fn project(&self, doc: RenderDocument, selection: TextRange, revision: u64) {
        self.updating.set(true);
        let b = self.buffer();
        let current = text(&b);
        if current != doc.text {
            let (range, replacement) = difference(&current, &doc.text);
            let mut start = b.iter_at_offset(char_offset(&current, range.start));
            let mut end = b.iter_at_offset(char_offset(&current, range.start + range.length));
            b.delete(&mut start, &mut end);
            b.insert(&mut start, &replacement);
        }

        let table = b.tag_table().unwrap();
        let mut tags = Vec::new();
        table.foreach(|tag| tags.push(tag.clone()));
        for tag in tags {
            table.remove(&tag);
        }
        for run in &doc.runs {
            let tag = gtk::TextTag::new(None);
            if run.bold {
                tag.set_weight(700);
            }
            if run.italic {
                tag.set_style(pango::Style::Italic);
            }
            if run.strike {
                tag.set_strikethrough(true);
            }
            if run.heading > 0 {
                tag.set_weight(700);
            }
            if run.quote {
                tag.set_left_margin(20);
            }
            if run.link.is_some() {
                tag.set_underline(pango::Underline::Single);
            }
            b.tag_table().unwrap().add(&tag);
            b.apply_tag(
                &tag,
                &b.iter_at_offset(char_offset(&doc.text, run.range.start)),
                &b.iter_at_offset(char_offset(&doc.text, run.range.start + run.range.length)),
            );
        }
        let start = b.iter_at_offset(char_offset(&doc.text, selection.start));
        let end = b.iter_at_offset(char_offset(&doc.text, selection.start + selection.length));
        // Re-selecting an unchanged insertion point during an asynchronous IME
        // commit resets GTK's still-live preedit and may commit its raw pinyin.
        let insert = b.iter_at_mark(&b.get_insert().expect("insert mark"));
        let anchor = b.iter_at_mark(&b.selection_bound().expect("selection bound"));
        self.pending_selection.borrow_mut().take();
        if insert.offset() != end.offset() || anchor.offset() != start.offset() {
            if !self.preedit.borrow().is_empty() {
                *self.pending_selection.borrow_mut() = Some(PendingSelection {
                    range: selection.clone(),
                    generation: self.config.borrow().generation,
                    revision,
                    insert: insert.offset(),
                    anchor: anchor.offset(),
                });
            } else {
                b.select_range(&end, &start);
            }
        }
        {
            let mut c = self.config.borrow_mut();
            c.document = doc;
            c.selection = selection;
            c.revision = revision;
        }
        self.updating.set(false);
    }
    fn flush_pending_selection(&self) {
        if !self.preedit.borrow().is_empty() || self.user_action.get() != 0 {
            return;
        }
        let Some(pending) = self.pending_selection.borrow_mut().take() else {
            return;
        };
        let b = self.buffer();
        // A later surface generation/projection supersedes this target.
        if self.config.borrow().generation != pending.generation
            || self.config.borrow().revision != pending.revision
        {
            return;
        }
        if b.iter_at_mark(&b.get_insert().expect("insert mark"))
            .offset()
            != pending.insert
            || b.iter_at_mark(&b.selection_bound().expect("selection bound"))
                .offset()
                != pending.anchor
        {
            // Navigation wins, including the next edit's rollback position.
            self.config.borrow_mut().selection = self.selection();
            return;
        }
        let current = text(&b);
        let start = b.iter_at_offset(char_offset(&current, pending.range.start));
        let end = b.iter_at_offset(char_offset(
            &current,
            pending.range.start + pending.range.length,
        ));
        let updating = self.updating.replace(true);
        b.select_range(&end, &start);
        self.config.borrow_mut().selection = pending.range;
        self.updating.set(updating);
    }
    fn accept(&self, result: Result<EventReply, String>, fallback: Option<Projection>) -> bool {
        match result {
            Ok(reply) => {
                if reply.draft_error.is_some() {
                    if let Some(p) = reply.projection.or(fallback) {
                        let revision = self.config.borrow().revision;
                        self.project(p.document, p.selection, revision);
                    }
                    self.failed.set(true);
                    self.view.set_editable(false);
                    stop_typing(self);
                    self.reset_focus();
                    return false;
                }
                if reply.revision < self.config.borrow().revision {
                    return false;
                }
                if let Some(p) = reply.projection.or(fallback) {
                    self.project(p.document, p.selection, reply.revision);
                } else {
                    self.config.borrow_mut().revision = reply.revision;
                }
                true
            }
            Err(_) => false,
        }
    }
    fn edit(&self, range: TextRange, replacement: &str) -> bool {
        if self.failed.get() || !self.visible.get() {
            return false;
        }
        let (surface_id, generation, base_revision) = self.identity();
        let mut doc = self.config.borrow().document.clone();
        let byte_at = |units| {
            doc.text
                .char_indices()
                .nth(char_offset(&doc.text, units) as usize)
                .map(|p| p.0)
                .unwrap_or(doc.text.len())
        };
        let start = byte_at(range.start);
        let end = byte_at(range.start + range.length);
        doc.text.replace_range(start..end, replacement);
        // A host rich projection supersedes this plain fallback.
        doc.runs.clear();
        let selection = TextRange {
            start: range.start + replacement.encode_utf16().count() as u32,
            length: 0,
        };
        self.accept(
            self.dispatch(NativeEvent::Edit {
                surface_id,
                generation,
                base_revision,
                range,
                replacement: replacement.into(),
            })
            .and_then(|reply| {
                if reply.draft_error.is_some() || reply.revision > base_revision {
                    Ok(reply)
                } else {
                    Err("edit was not durably acknowledged".into())
                }
            }),
            Some(Projection {
                document: doc,
                selection,
            }),
        )
    }
    fn action(&self, action: &str) -> bool {
        if self.composing.get() || (self.failed.get() && action != "save") {
            return false;
        }
        let (surface_id, generation, revision) = self.identity();
        self.accept(
            self.dispatch(NativeEvent::Action {
                surface_id,
                generation,
                revision,
                action: action.into(),
                range: self.selection(),
            }),
            None,
        )
    }
    fn find(&self, backwards: bool) -> bool {
        let query = self.search.borrow().clone();
        if query.is_empty() {
            return false;
        }
        let b = self.buffer();
        let selection = self.selection();
        let t = text(&b);
        let offset = if backwards {
            selection.start
        } else {
            selection.start + selection.length
        };
        let iter = b.iter_at_offset(char_offset(&t, offset));
        let flags = gtk::TextSearchFlags::TEXT_ONLY;
        let found = if backwards {
            iter.backward_search(&query, flags, None)
                .or_else(|| b.end_iter().backward_search(&query, flags, None))
        } else {
            iter.forward_search(&query, flags, None)
                .or_else(|| b.start_iter().forward_search(&query, flags, None))
        };
        if let Some((mut start, end)) = found {
            self.reading();
            b.select_range(&end, &start);
            self.view.scroll_to_iter(&mut start, 0.1, false, 0.0, 0.0);
            true
        } else {
            false
        }
    }
    fn perform(self: &Rc<Self>, action: &str) -> bool {
        match action {
            "select_all" => {
                let b = self.buffer();
                b.select_range(&b.end_iter(), &b.start_iter());
                true
            }
            "copy" => {
                self.clipboard(false);
                true
            }
            "cut" => {
                self.clipboard(true);
                true
            }
            "paste" | "paste_plain" => {
                self.paste(action == "paste_plain");
                true
            }
            "find_next" => {
                self.find(false);
                true
            }
            "find_previous" => {
                self.find(true);
                true
            }
            "find" | "replace" | "link" => {
                if self.composing.get() {
                    return false;
                }
                if action == "link" && !self.action("link_begin") {
                    return false;
                }
                let parent = self
                    .view
                    .toplevel()
                    .and_then(|w| w.downcast::<gtk::Window>().ok());
                let locale = normalize_locale(&self.config.borrow().appearance.locale);
                let (link_title, replace_title, find_title, cancel, apply, replacement_label) =
                    match locale {
                        "zh" => ("链接地址", "查找与替换", "查找", "取消", "应用", "替换为"),
                        "ja" => (
                            "リンク先",
                            "検索と置換",
                            "検索",
                            "キャンセル",
                            "適用",
                            "置換文字列",
                        ),
                        _ => (
                            "Link URL",
                            "Find and replace",
                            "Find",
                            "Cancel",
                            "Apply",
                            "Replacement",
                        ),
                    };
                let title = match action {
                    "link" => link_title,
                    "replace" => replace_title,
                    _ => find_title,
                };
                let dialog = gtk::Dialog::with_buttons(
                    Some(title),
                    parent.as_ref(),
                    gtk::DialogFlags::MODAL,
                    &[
                        (cancel, gtk::ResponseType::Cancel),
                        (apply, gtk::ResponseType::Accept),
                    ],
                );
                let entry = gtk::Entry::new();
                entry.set_hexpand(true);
                if action != "link" {
                    entry.set_text(&self.search.borrow());
                }
                dialog.content_area().pack_start(&entry, false, false, 8);
                let replacement = gtk::Entry::new();
                if action == "replace" {
                    replacement.set_placeholder_text(Some(replacement_label));
                    dialog
                        .content_area()
                        .pack_start(&replacement, false, false, 8);
                }
                let weak = Rc::downgrade(self);
                let action = action.to_owned();
                let identity = self.identity();
                let focus_entry = entry.clone();
                dialog.connect_response(move |dialog, response| {
                    if let Some(s) = weak.upgrade() {
                        if s.identity() == identity {
                            if response == gtk::ResponseType::Accept {
                                if action == "link" {
                                    s.action(&format!("link_set:{}", entry.text()));
                                } else {
                                    *s.search.borrow_mut() = entry.text().into();
                                    let matched = s.find(false);
                                    if action == "replace" && matched {
                                        s.edit(s.selection(), replacement.text().as_str());
                                    }
                                }
                            } else if action == "link" {
                                s.action("link_cancel");
                            }
                        }
                    }
                    dialog.close();
                });
                dialog.show_all();
                focus_entry.grab_focus();
                true
            }
            _ => self.action(action),
        }
    }
    fn paste_current(&self, identity: &(String, u64, u64), selection: &TextRange) -> bool {
        let current = self.selection();
        self.identity() == *identity
            && current.start == selection.start
            && current.length == selection.length
            && !self.composing.get()
            && !self.failed.get()
            && self.visible.get()
            && self.view.has_focus()
    }
    fn finish_paste(
        &self,
        identity: (String, u64, u64),
        selection: TextRange,
        text: Option<String>,
        html: Option<String>,
        literal: bool,
    ) {
        if !self.paste_current(&identity, &selection) {
            return;
        }
        let (surface_id, generation, base_revision) = identity;
        self.accept(
            self.dispatch(NativeEvent::Paste {
                surface_id,
                generation,
                base_revision,
                range: selection,
                text,
                html,
                rtf: None,
                literal,
            }),
            None,
        );
    }
    fn paste_error(&self, message: &str) {
        let parent = self
            .view
            .toplevel()
            .and_then(|w| w.downcast::<gtk::Window>().ok());
        let locale = self.config.borrow().appearance.locale.clone();
        let title = match normalize_locale(&locale) {
            "zh" => "无法粘贴富文本，正文未更改",
            "ja" => "リッチテキストを貼り付けられません。本文は変更されていません",
            _ => "Cannot paste rich text; the document was not changed",
        };
        let dialog = gtk::MessageDialog::new(
            parent.as_ref(),
            gtk::DialogFlags::MODAL,
            gtk::MessageType::Error,
            gtk::ButtonsType::Close,
            title,
        );
        dialog.set_secondary_text(Some(message));
        dialog.connect_response(|dialog, _| dialog.close());
        dialog.show_all();
    }
    fn paste_rtf(
        self: &Rc<Self>,
        identity: (String, u64, u64),
        selection: TextRange,
        literal: bool,
        alternate: bool,
    ) {
        let weak = Rc::downgrade(self);
        let mime = if alternate {
            "application/rtf"
        } else {
            "text/rtf"
        };
        gtk::Clipboard::get(&gdk::SELECTION_CLIPBOARD).request_contents(
            &gdk::Atom::intern(mime),
            move |_, data| {
                let Some(surface) = weak.upgrade() else {
                    return;
                };
                if !surface.paste_current(&identity, &selection) {
                    return;
                }
                if data.length() > rtf::MAX_BYTES as i32 {
                    surface.paste_error("RTF clipboard exceeds 2 MiB");
                    return;
                }
                let bytes = data.data();
                if bytes.is_empty() {
                    if !alternate {
                        surface.paste_rtf(identity, selection, literal, true);
                    }
                    return;
                }
                match rtf::plain_text(&bytes) {
                    Ok(text) => {
                        surface.finish_paste(identity, selection, Some(text), None, literal)
                    }
                    Err(message) => surface.paste_error(&message),
                }
            },
        );
    }
    fn paste(self: &Rc<Self>, literal: bool) {
        let identity = self.identity();
        let selection = self.selection();
        let weak = Rc::downgrade(self);
        let clipboard = gtk::Clipboard::get(&gdk::SELECTION_CLIPBOARD);
        clipboard.request_text(move |clipboard, value| {
            let text = value.map(str::to_owned);
            let weak = weak.clone();
            clipboard.request_contents(&gdk::Atom::intern("text/html"), move |_, data| {
                let Some(surface) = weak.upgrade() else {
                    return;
                };
                if !surface.paste_current(&identity, &selection) {
                    return;
                }
                let html = if literal {
                    None
                } else {
                    String::from_utf8(data.data())
                        .ok()
                        .filter(|value| !value.is_empty())
                };
                if text.is_none() && html.is_none() {
                    surface.paste_rtf(identity, selection, literal, false);
                } else {
                    surface.finish_paste(identity, selection, text, html, literal);
                }
            });
        });
    }
    fn clipboard(&self, cut: bool) {
        if self.composing.get() || (cut && self.failed.get()) {
            return;
        }
        let range = self.selection();
        if range.length == 0 {
            return;
        }
        let (surface_id, generation, revision) = self.identity();
        let Ok(reply) = self.dispatch(NativeEvent::Clipboard {
            surface_id: surface_id.clone(),
            generation,
            revision,
            ranges: vec![range.clone()],
            cut: false,
        }) else {
            return;
        };
        let Some(value) = reply.clipboard_text else {
            return;
        };
        gtk::Clipboard::get(&gdk::SELECTION_CLIPBOARD).set_text(&value);
        if cut {
            self.accept(
                self.dispatch(NativeEvent::Clipboard {
                    surface_id,
                    generation,
                    revision,
                    ranges: vec![range],
                    cut: true,
                }),
                None,
            );
        }
    }
    fn appearance(&self) {
        let c = self.config.borrow();
        let a = &c.appearance;
        let family = CASCADES
            .with(|s| s.borrow().get(&a.font_family).map(|v| v.join(", ")))
            .unwrap_or_else(|| {
                if a.font_family == "Sumi System" {
                    "monospace".into()
                } else {
                    a.font_family.clone()
                }
            });
        let css = &self.css;
        let safe_family = family
            .split(", ")
            .map(|part| format!("\"{}\"", part.replace(['"', '\\', '\n', '\r'], "")))
            .collect::<Vec<_>>()
            .join(", ");
        let _=css.load_from_data(format!("textview {{ font-family: {}; font-size: {}px; font-weight: {}; color: {}; background-color: {}; caret-color: transparent; -gtk-secondary-caret-color: transparent; }} textview text {{ background-color: {}; color: {}; caret-color: transparent; -gtk-secondary-caret-color: transparent; }} textview text selection {{ background-color: alpha({}, 0.22); color: {}; }}",safe_family,a.font_size,if matches!(a.font_family.as_str(),"Sumi Plex"|"Sumi Zhaohua"|"Sumi Youcha"){300}else{400},a.foreground,a.background,a.background,a.foreground,a.foreground,a.foreground).as_bytes());
        self.view
            .style_context()
            .add_provider(css, gtk::STYLE_PROVIDER_PRIORITY_APPLICATION);
        let horizontal = (24.0 * a.font_size / 22.0)
            .max(16.0)
            .min(c.bounds.width / 4.0);
        let vertical = (32.0 * a.font_size / 22.0)
            .max(20.0)
            .min(c.bounds.height / 4.0);
        let cell_width = self
            .view
            .create_pango_layout(Some("M"))
            .pixel_size()
            .0
            .max(1) as f64;
        let glyph_height = self
            .view
            .create_pango_layout(Some("Ag中"))
            .pixel_size()
            .1
            .max(1) as f64;
        let line_extra = (a.font_size * a.line_height - glyph_height).max(0.0);
        let width = a.max_columns as f64 * cell_width;
        let margin = horizontal.max((c.bounds.width - width) / 2.0) as i32;
        self.view.set_left_margin(margin);
        self.view.set_right_margin(margin);
        let pad = if self.focused.get() {
            (c.bounds.height - a.bottom_inset - a.font_size * a.line_height).max(0.0) / 2.0
        } else {
            vertical
        };
        self.view.set_top_margin(pad as i32);
        self.view.set_bottom_margin((pad + a.bottom_inset) as i32);
        self.view.set_pixels_above_lines((line_extra / 2.0) as i32);
        self.view.set_pixels_below_lines((line_extra / 2.0) as i32);
        // Wrapped and paragraph lines share the candidate row pitch.
        self.view
            .set_pixels_inside_wrap((line_extra / 2.0) as i32 * 2);
        self.line_pitch
            .set(glyph_height + (line_extra / 2.0).floor() * 2.0);
        // GTK's margin changes may scroll cached text pixels without damaging
        // their old location. Repaint the text widget once after layout changes.
        self.view.queue_draw();
        self.caret.queue_draw();
    }
    fn viewport(&self) -> Viewport {
        let rect = self.view.visible_rect();
        let (iter, top) = self.view.line_at_y(rect.y());
        Viewport {
            start: utf16_offset(&text(&self.buffer()), iter.offset()),
            offset: (rect.y() - top) as f64,
        }
    }
}
#[allow(non_upper_case_globals)] // GDK keys use their canonical XKB names.
fn shortcut(key: gdk::keys::Key, mask: gdk::ModifierType) -> Option<&'static str> {
    use gdk::keys::constants::*;
    // Caps Lock changes keyvals but is not a shortcut modifier. Shift remains
    // explicit in mask, so Ctrl+Shift+V still differs from Ctrl+V.
    let key = key.to_lower();
    let ctrl = gdk::ModifierType::CONTROL_MASK;
    let shift = gdk::ModifierType::SHIFT_MASK;
    let alt = gdk::ModifierType::MOD1_MASK;
    if mask == ctrl {
        return match key {
            a => Some("select_all"),
            c => Some("copy"),
            x => Some("cut"),
            v => Some("paste"),
            z => Some("undo"),
            y => Some("redo"),
            b => Some("bold"),
            i => Some("italic"),
            k => Some("link"),
            f => Some("find"),
            g => Some("find_next"),
            n => Some("new_page"),
            o => Some("menu"),
            s => Some("save"),
            w => Some("close"),
            comma => Some("settings"),
            equal | plus => Some("zoom_in"),
            minus => Some("zoom_out"),
            _0 => Some("zoom_reset"),
            bracketright => Some("indent"),
            bracketleft => Some("outdent"),
            _ => None,
        };
    }
    if mask == ctrl | shift {
        return match key {
            z => Some("redo"),
            x => Some("strike"),
            v => Some("paste_plain"),
            g => Some("find_previous"),
            s => Some("export"),
            plus | equal => Some("zoom_in"),
            _9 | parenleft => Some("quote"),
            _8 | asterisk => Some("bullet_list"),
            _7 | ampersand => Some("ordered_list"),
            _ => None,
        };
    }
    if mask == ctrl | alt {
        return match key {
            Left => Some("previous_page"),
            Right => Some("next_page"),
            f => Some("replace"),
            _0 => Some("paragraph"),
            _1 => Some("heading1"),
            _2 => Some("heading2"),
            _3 => Some("heading3"),
            _4 => Some("heading4"),
            _5 => Some("heading5"),
            _6 => Some("heading6"),
            _ => None,
        };
    }
    if mask.is_empty() {
        return match key {
            F11 => Some("fullscreen"),
            Escape => Some("menu"),
            Tab => Some("indent"),
            _ => None,
        };
    }
    if mask == shift && matches!(key, Tab | ISO_Left_Tab) {
        return Some("outdent");
    }
    None
}
fn surface(window: &str, id: &str, generation: u64) -> Result<Rc<Surface>, String> {
    SURFACES
        .with(|s| s.borrow().get(&(window.into(), id.into())).cloned())
        .filter(|s| s.config.borrow().generation == generation)
        .ok_or_else(|| "surface not mounted or stale generation".into())
}
pub fn mount(
    parent: &gtk::ApplicationWindow,
    window: &str,
    config: SurfaceConfig,
    handler: EventHandler,
    origin: Option<gtk::Widget>,
) -> Result<(), String> {
    let key = (window.to_owned(), config.surface_id.clone());
    if SURFACES.with(|s| s.borrow().contains_key(&key)) {
        return Err("surface already mounted".into());
    }
    let child = parent.child().ok_or("native window has no content")?;
    let overlay = if let Ok(existing) = child.clone().downcast::<gtk::Overlay>() {
        existing
    } else {
        let overlay = gtk::Overlay::new();
        parent.remove(&child);
        overlay.add(&child);
        parent.add(&overlay);
        overlay.show();
        overlay
    };
    let view = gtk::TextView::new();
    view.set_wrap_mode(gtk::WrapMode::WordChar);
    view.set_accepts_tab(true);
    let scroll = gtk::ScrolledWindow::new(None::<&gtk::Adjustment>, None::<&gtk::Adjustment>);
    // External hides the scrollbar without letting long content enlarge the viewport.
    scroll.set_policy(gtk::PolicyType::Never, gtk::PolicyType::External);
    scroll.set_shadow_type(gtk::ShadowType::None);
    scroll.set_halign(gtk::Align::Start);
    scroll.set_valign(gtk::Align::Start);
    scroll.add(&view);
    overlay.add_overlay(&scroll);
    let decoration = gtk::DrawingArea::new();
    decoration.set_halign(gtk::Align::Start);
    decoration.set_valign(gtk::Align::Start);
    overlay.add_overlay(&decoration);
    overlay.set_overlay_pass_through(&decoration, true);
    let caret = caret::new();
    caret.set_halign(gtk::Align::Start);
    caret.set_valign(gtk::Align::Start);
    caret.set_no_show_all(true);
    overlay.add_overlay(&caret);
    overlay.set_overlay_pass_through(&caret, true);
    let blank = config.appearance.focus_typing && config.document.text.is_empty();
    let s = Rc::new(Surface {
        view,
        scroll,
        overlay,
        allocation_handler: RefCell::new(None),
        origin,
        css: gtk::CssProvider::new(),
        decoration,
        caret,
        candidates: RefCell::new(None),
        line_pitch: Cell::new(35.0),
        caret_metrics: RefCell::new(None),
        focused: Cell::new(blank),
        resume_focus: Cell::new(false),
        focus_frame: RefCell::new(focus::Frame::new(blank)),
        pointer_tracking: Cell::new(false),
        last_input: Cell::new(None),
        phase: std::time::Instant::now(),
        config: RefCell::new(config.clone()),
        handler,
        updating: Cell::new(false),
        layout_pending: Cell::new(false),
        user_action: Cell::new(0),
        preedit: RefCell::new(String::new()),
        pending_selection: RefCell::new(None),
        composing: Cell::new(false),
        failed: Cell::new(false),
        fullscreen_down: Cell::new(false),
        sound_keys: RefCell::new(std::collections::HashSet::new()),
        search: RefCell::new(String::new()),
        visible: Cell::new(true),
    });
    *s.candidates.borrow_mut() = Some(candidates::Panel::attach(&s));
    let weak = Rc::downgrade(&s);
    let allocation_handler = s.overlay.connect_get_child_position(move |_, child| {
        let s = weak.upgrade()?;
        if child != s.scroll.upcast_ref::<gtk::Widget>()
            && child != s.decoration.upcast_ref::<gtk::Widget>()
        {
            return None;
        }
        let config = s.config.borrow();
        // size_request is only a minimum. The host bounds are the actual native
        // allocation; GTK removes these margins when allocating the child.
        Some(gdk::Rectangle::new(
            0,
            0,
            (config.bounds.width as i32).max(1) + child.margin_start() + child.margin_end(),
            (config.bounds.height as i32).max(1) + child.margin_top() + child.margin_bottom(),
        ))
    });
    *s.allocation_handler.borrow_mut() = Some(allocation_handler);
    s.project(config.document, config.selection, config.revision);
    s.appearance();
    let weak = Rc::downgrade(&s);
    s.buffer().connect_apply_tag(move |buffer, _, _, _| {
        if weak.upgrade().is_some_and(|s| !s.updating.get()) {
            buffer.stop_signal_emission_by_name("apply-tag");
        }
    });
    let weak = Rc::downgrade(&s);
    s.buffer().connect_remove_tag(move |buffer, _, _, _| {
        if weak.upgrade().is_some_and(|s| !s.updating.get()) {
            buffer.stop_signal_emission_by_name("remove-tag");
        }
    });
    let weak = Rc::downgrade(&s);
    s.buffer().connect_begin_user_action(move |_| {
        if let Some(s) = weak.upgrade() {
            if !s.updating.get() {
                s.user_action.set(s.user_action.get() + 1);
            }
        }
    });
    let weak = Rc::downgrade(&s);
    s.buffer().connect_end_user_action(move |b| {
        if let Some(s) = weak.upgrade() {
            if s.updating.get() {
                return;
            }
            let depth = s.user_action.get().saturating_sub(1);
            s.user_action.set(depth);
            if depth == 0 {
                let before = s.config.borrow().document.text.clone();
                let after = text(b);
                if before != after {
                    s.typing();
                    let (range, replacement) = difference(&before, &after);
                    if !s.edit(range, &replacement) && !s.failed.get() {
                        let c = s.config.borrow().clone();
                        s.project(c.document, c.selection, c.revision);
                    }
                    s.center();
                }
            }
        }
    });
    let weak = Rc::downgrade(&s);
    s.buffer().connect_insert_text(move |b, iter, value| {
        if let Some(s) = weak.upgrade() {
            // set_editable(false) can synchronously reset an IM context and
            // reenter GTK's commit transaction. Never mutate a failed draft.
            if !s.updating.get() && s.failed.get() {
                b.stop_signal_emission_by_name("insert-text");
                return;
            }
            if !s.updating.get() && s.user_action.get() == 0 {
                b.stop_signal_emission_by_name("insert-text");
                let range = TextRange {
                    start: utf16_offset(&text(b), iter.offset()),
                    length: 0,
                };
                s.typing();
                s.edit(range, value);
                s.center();
                *iter = b.iter_at_mark(&b.get_insert().expect("insert mark"));
            }
        }
    });
    let weak = Rc::downgrade(&s);
    s.buffer().connect_delete_range(move |b, start, end| {
        if let Some(s) = weak.upgrade() {
            if !s.updating.get() && s.failed.get() {
                b.stop_signal_emission_by_name("delete-range");
                return;
            }
            if !s.updating.get() && s.user_action.get() == 0 {
                b.stop_signal_emission_by_name("delete-range");
                let t = text(b);
                let pos = utf16_offset(&t, start.offset());
                s.edit(
                    TextRange {
                        start: pos,
                        length: utf16_offset(&t, end.offset()) - pos,
                    },
                    "",
                );
                *start = b.iter_at_mark(&b.get_insert().expect("insert mark"));
                *end = *start;
            }
        }
    });
    let weak = Rc::downgrade(&s);
    s.buffer().connect_mark_set(move |_, _, mark| {
        if let Some(s) = weak.upgrade() {
            if !s.updating.get()
                && s.user_action.get() == 0
                && !s.composing.get()
                && mark.name().as_deref() == Some("insert")
            {
                let range = s.selection();
                s.config.borrow_mut().selection = range.clone();
                let (surface_id, generation, revision) = s.identity();
                let _ = s.dispatch(NativeEvent::Selection {
                    surface_id,
                    generation,
                    revision,
                    range,
                });
                s.center();
            }
        }
    });
    let weak = Rc::downgrade(&s);
    s.view.connect_preedit_changed(move |_, value| {
        if let Some(s) = weak.upgrade() {
            *s.preedit.borrow_mut() = value.into();
            if !value.is_empty() {
                s.typing();
                s.center();
                if !s.composing.replace(true) {
                    let (surface_id, generation, revision) = s.identity();
                    let _ = s.dispatch(NativeEvent::Composition {
                        surface_id,
                        generation,
                        revision,
                        active: true,
                    });
                }
            } else {
                // GTK can clear preedit before its final commit callback. Keep
                // the host remote-update barrier through that input transaction.
                let weak = Rc::downgrade(&s);
                glib::idle_add_local_once(move || {
                    if let Some(s) = weak.upgrade() {
                        if s.preedit.borrow().is_empty() && s.user_action.get() == 0 {
                            s.flush_pending_selection();
                            if !s.composing.replace(false) {
                                return;
                            }
                            let range = s.selection();
                            s.config.borrow_mut().selection = range.clone();
                            let (surface_id, generation, revision) = s.identity();
                            let _ = s.dispatch(NativeEvent::Composition {
                                surface_id: surface_id.clone(),
                                generation,
                                revision,
                                active: false,
                            });
                            let _ = s.dispatch(NativeEvent::Selection {
                                surface_id,
                                generation,
                                revision,
                                range,
                            });
                        }
                    }
                });
            }
        }
    });
    let weak = Rc::downgrade(&s);
    s.view.connect_copy_clipboard(move |v| {
        v.stop_signal_emission_by_name("copy-clipboard");
        if let Some(s) = weak.upgrade() {
            s.clipboard(false);
        }
    });
    let weak = Rc::downgrade(&s);
    s.view.connect_cut_clipboard(move |v| {
        v.stop_signal_emission_by_name("cut-clipboard");
        if let Some(s) = weak.upgrade() {
            s.clipboard(true);
        }
    });
    let weak = Rc::downgrade(&s);
    s.view.connect_paste_clipboard(move |view| {
        view.stop_signal_emission_by_name("paste-clipboard");
        if let Some(s) = weak.upgrade() {
            s.paste(false);
        }
    });
    let weak = Rc::downgrade(&s);
    s.view.connect_key_press_event(move |_, e| {
        let Some(s) = weak.upgrade() else {
            return glib::Propagation::Proceed;
        };
        s.flush_pending_selection();
        emit_typing(&s, e, false);
        if s.composing.get() {
            return glib::Propagation::Proceed;
        }
        let mask = e.state()
            & (gdk::ModifierType::CONTROL_MASK
                | gdk::ModifierType::SHIFT_MASK
                | gdk::ModifierType::MOD1_MASK
                | gdk::ModifierType::SUPER_MASK
                | gdk::ModifierType::META_MASK);
        let key = e.keyval();
        let action = shortcut(key, mask);
        if !mask.is_empty()
            && matches!(
                key,
                gdk::keys::constants::Up
                    | gdk::keys::constants::Down
                    | gdk::keys::constants::Left
                    | gdk::keys::constants::Right
                    | gdk::keys::constants::Home
                    | gdk::keys::constants::End
            )
        {
            s.reading();
        }
        if mask.is_empty()
            && matches!(
                key,
                gdk::keys::constants::Left
                    | gdk::keys::constants::Right
                    | gdk::keys::constants::Home
                    | gdk::keys::constants::End
                    | gdk::keys::constants::Page_Up
                    | gdk::keys::constants::Page_Down
            )
        {
            s.reading();
        }
        if let Some(action) = action {
            if action == "fullscreen" && s.fullscreen_down.replace(true) {
                return glib::Propagation::Stop;
            }
            s.perform(action);
            glib::Propagation::Stop
        } else {
            glib::Propagation::Proceed
        }
    });
    let weak = Rc::downgrade(&s);
    s.view.connect_button_press_event(move |_, _| {
        if let Some(s) = weak.upgrade() {
            s.pointer_tracking.set(true);
        }
        glib::Propagation::Proceed
    });
    let weak = Rc::downgrade(&s);
    s.view.connect_button_release_event(move |_, _| {
        let weak = weak.clone();
        glib::idle_add_local_once(move || {
            if let Some(s) = weak.upgrade() {
                s.pointer_tracking.set(false);
                s.reading();
            }
        });
        glib::Propagation::Proceed
    });
    let weak = Rc::downgrade(&s);
    s.view.connect_scroll_event(move |_, _| {
        if let Some(s) = weak.upgrade() {
            s.reading();
        }
        glib::Propagation::Proceed
    });
    let weak = Rc::downgrade(&s);
    s.view.connect_focus_in_event(move |_, _| {
        let weak = weak.clone();
        glib::idle_add_local_once(move || {
            if let Some(s) = weak.upgrade() {
                if let Some(p) = s.candidates.borrow().as_ref() {
                    p.sync_active();
                }
            }
        });
        glib::Propagation::Proceed
    });
    let weak = Rc::downgrade(&s);
    s.view.connect_focus_out_event(move |_, _| {
        if let Some(s) = weak.upgrade() {
            // A key released in another window never reaches this TextView.
            s.fullscreen_down.set(false);
            stop_typing(&s);
            s.reset_focus();
            if let Some(p) = s.candidates.borrow().as_ref() {
                p.release();
            }
            s.caret.hide();
        }
        glib::Propagation::Proceed
    });
    let weak = Rc::downgrade(&s);
    s.view.connect_key_release_event(move |_, e| {
        if let Some(s) = weak.upgrade() {
            emit_typing(&s, e, true);
            if e.keyval() == gdk::keys::constants::F11 {
                s.fullscreen_down.set(false);
            }
            if s.focused.get()
                && (e.keyval() == gdk::keys::constants::Up
                    || e.keyval() == gdk::keys::constants::Down)
            {
                s.center();
            }
        }
        glib::Propagation::Proceed
    });
    let weak = Rc::downgrade(&s);
    s.scroll.vadjustment().connect_value_changed(move |_| {
        if let Some(s) = weak.upgrade() {
            if !s.updating.get() {
                let (surface_id, generation, revision) = s.identity();
                let _ = s.dispatch(NativeEvent::Viewport {
                    surface_id,
                    generation,
                    revision,
                    viewport: s.viewport(),
                });
            }
        }
    });
    let weak = Rc::downgrade(&s);
    s.decoration.connect_draw(move |_, cr| {
        if let Some(s) = weak.upgrade() {
            s.draw(cr);
        }
        glib::Propagation::Proceed
    });
    let weak = Rc::downgrade(&s);
    s.caret.connect_draw(move |_, cr| {
        if let Some(s) = weak.upgrade() {
            s.draw_caret(cr);
        }
        glib::Propagation::Proceed
    });
    let weak = Rc::downgrade(&s);
    glib::timeout_add_local(std::time::Duration::from_millis(33), move || {
        let Some(s) = weak.upgrade() else {
            return glib::ControlFlow::Break;
        };
        if let Some(p) = s.candidates.borrow().as_ref() {
            p.sync_active();
            p.arrange();
        }
        if s.visible.get() && s.view.has_focus() {
            s.tick_focus();
        }
        glib::ControlFlow::Continue
    });
    let weak = Rc::downgrade(&s);
    glib::idle_add_local_once(move || {
        if let Some(s) = weak.upgrade() {
            if s.focused.get() {
                s.center();
            } else {
                let viewport = s.config.borrow().viewport.clone();
                let b = s.buffer();
                let mut iter = b.iter_at_offset(char_offset(&text(&b), viewport.start));
                s.updating.set(true);
                s.view.scroll_to_iter(&mut iter, 0.0, true, 0.0, 0.0);
                let adjustment = s.scroll.vadjustment();
                adjustment.set_value(adjustment.value() + viewport.offset);
                s.updating.set(false);
            }
        }
    });
    let weak = Rc::downgrade(&s);
    s.scroll.connect_size_allocate(move |_, _| {
        if let Some(surface) = weak.upgrade() {
            surface.defer_center();
        }
    });
    if let Some(origin) = &s.origin {
        let weak = Rc::downgrade(&s);
        origin.connect_size_allocate(move |_, _| {
            if let Some(surface) = weak.upgrade() {
                surface.defer_center();
            }
        });
    }
    s.scroll.show_all();
    s.decoration.show();
    SURFACES.with(|surfaces| surfaces.borrow_mut().insert(key, s));
    command(
        window,
        &config.surface_id,
        config.generation,
        SurfaceCommand::SetBounds {
            bounds: config.bounds,
        },
    )?;
    Ok(())
}
pub fn command(
    window: &str,
    id: &str,
    generation: u64,
    command: SurfaceCommand,
) -> Result<(), String> {
    let s = surface(window, id, generation)?;
    match command {
        SurfaceCommand::SetBounds { bounds } => {
            s.config.borrow_mut().bounds = bounds;
            s.position();
            s.appearance();
            if let Some(p) = s.candidates.borrow().as_ref() {
                p.refresh();
            }
            s.defer_center();
        }
        SurfaceCommand::SetAppearance { appearance } => {
            if s.composing.get() {
                return Err("composition active".into());
            }
            s.config.borrow_mut().appearance = appearance;
            if !s.config.borrow().appearance.focus_typing {
                s.reset_focus();
            }
            s.appearance();
            s.prepare_blank();
            if let Some(p) = s.candidates.borrow().as_ref() {
                p.refresh();
            }
            s.defer_center();
        }
        SurfaceCommand::SetLocale { locale } => s.config.borrow_mut().appearance.locale = locale,
        SurfaceCommand::ApplyDocument {
            base_revision,
            revision,
            document,
            selection,
        } => {
            if s.composing.get() {
                return Err("composition active".into());
            }
            if s.config.borrow().revision != base_revision {
                return Err("stale document revision".into());
            }
            s.reset_focus();
            s.project(document, selection, revision);
            s.failed.set(false);
            s.view.set_editable(true);
        }
        SurfaceCommand::Focus => {
            s.view.grab_focus();
            if let Some(p) = s.candidates.borrow().as_ref() {
                p.sync_active();
            }
            s.prepare_blank();
        }
        SurfaceCommand::PreparePanel => {
            if s.failed.get() {
                return Err("保存失败，草稿仍保留在编辑器中；请先恢复保存或复制文字".into());
            }
            stop_typing(&s);
            if s.composing.get() {
                return Err("请先完成输入法选词，再打开面板；预编辑文字已保留".into());
            }
            return self::command(
                window,
                id,
                generation,
                SurfaceCommand::SetVisible { visible: false },
            );
        }
        SurfaceCommand::SetVisible { visible } => {
            if !visible && s.failed.get() {
                return Err("保存失败，无法隐藏未保存草稿".into());
            }
            if !visible && s.composing.get() {
                return Err("composition active".into());
            }
            s.visible.set(visible);
            if visible {
                s.position();
                s.prepare_blank();
                s.defer_center();
            }
            s.scroll.set_visible(visible);
            s.decoration.set_visible(visible);
            if !visible {
                if let Some(p) = s.candidates.borrow().as_ref() {
                    p.release();
                }
                s.caret.hide();
                stop_typing(&s);
                s.reset_focus();
                // DOM focus alone does not restore GTK focus after the native
                // text widget was hidden. Return keyboard ownership to WebKit.
                if let Some(origin) = &s.origin {
                    origin.grab_focus();
                }
            }
        }
    }
    Ok(())
}
pub fn inspect(window: &str, id: &str, generation: u64) -> Result<SurfaceState, String> {
    let s = surface(window, id, generation)?;
    let c = s.config.borrow();
    let composing = s.composing.get();
    Ok(SurfaceState {
        surface_id: c.surface_id.clone(),
        generation,
        revision: c.revision,
        text: text(&s.buffer()),
        selection: s.selection(),
        composing,
        textkit2: false,
        visible: s.visible.get(),
        viewport: s.viewport(),
    })
}
pub fn detach(window: &str, id: &str, generation: u64) -> Result<(), String> {
    let s = surface(window, id, generation)?;
    if s.failed.get() {
        return Err("保存失败，草稿仍保留在编辑器中".into());
    }
    if s.composing.get() {
        return Err("composition active".into());
    }
    SURFACES.with(|all| all.borrow_mut().remove(&(window.into(), id.into())));
    stop_typing(&s);
    let panel = s.candidates.borrow_mut().take();
    if let Some(p) = panel {
        p.release();
        s.overlay.remove(&p.widget);
    }
    if let Some(handler) = s.allocation_handler.borrow_mut().take() {
        s.overlay.disconnect(handler);
    }
    s.overlay.remove(&s.scroll);
    s.overlay.remove(&s.decoration);
    s.overlay.remove(&s.caret);
    Ok(())
}
pub fn detach_window(window: &str) {
    let removed = SURFACES.with(|all| {
        let mut all = all.borrow_mut();
        let keys: Vec<_> = all.keys().filter(|(w, _)| w == window).cloned().collect();
        keys.into_iter()
            .filter_map(|k| all.remove(&k))
            .collect::<Vec<_>>()
    });
    for s in removed {
        stop_typing(&s);
        let panel = s.candidates.borrow_mut().take();
        if let Some(p) = panel {
            p.release();
            s.overlay.remove(&p.widget);
        }
        if let Some(handler) = s.allocation_handler.borrow_mut().take() {
            s.overlay.disconnect(handler);
        }
        s.overlay.remove(&s.scroll);
        s.overlay.remove(&s.decoration);
        s.overlay.remove(&s.caret);
    }
}
pub fn is_supported() -> bool {
    true
}
pub fn menu_command(action: &str) -> bool {
    if let Some(action) = action.strip_prefix("input:") {
        use webkit2gtk::WebViewExt;
        let windows = SURFACES.with(|all| {
            all.borrow()
                .values()
                .filter_map(|surface| surface.view.toplevel()?.downcast::<gtk::Window>().ok())
                .collect::<Vec<_>>()
        });
        for window in windows {
            if !window.is_active() {
                continue;
            }
            let Some(focus) = window.focused_widget() else {
                continue;
            };
            if let Ok(webview) = focus.clone().downcast::<webkit2gtk::WebView>() {
                let command = match action {
                    "select_all" => "SelectAll",
                    "undo" => "Undo",
                    "redo" => "Redo",
                    _ => return false,
                };
                webview.execute_editing_command(command);
                return true;
            }
            if action == "select_all" {
                if let Ok(entry) = focus.downcast::<gtk::Entry>() {
                    entry.select_region(0, -1);
                    return true;
                }
            }
        }
        return false;
    }

    let active = SURFACES.with(|s| {
        s.borrow()
            .values()
            .find(|s| s.view.has_focus() && s.visible.get())
            .cloned()
    });
    if let Some(s) = active {
        s.perform(action);
        true
    } else {
        false
    }
}
pub fn configure_typing(enabled: bool, handler: Option<TypingSoundHandler>) -> TypingMonitorStatus {
    let surfaces = SURFACES.with(|all| all.borrow().values().cloned().collect::<Vec<_>>());
    for s in surfaces {
        stop_typing(&s);
    }
    TYPING.with(|h| *h.borrow_mut() = if enabled { handler } else { None });
    typing_status(false)
}
pub fn typing_status(_: bool) -> TypingMonitorStatus {
    let enabled = TYPING.with(|h| h.borrow().is_some());
    TypingMonitorStatus {
        enabled,
        permission_granted: true,
        listening: enabled,
    }
}
fn stop_typing(s: &Surface) {
    s.sound_keys.borrow_mut().clear();
    let handler = TYPING.with(|h| h.borrow().clone());
    if let Some(handler) = handler {
        let (surface_id, generation, _) = s.identity();
        handler(TypingSoundEvent {
            surface_id,
            generation,
            role: TypingSoundRole::Stop,
        });
    }
}
fn emit_typing(s: &Surface, e: &gdk::EventKey, release: bool) {
    if s.failed.get() || !s.visible.get() || !s.view.has_focus() {
        return;
    }
    if !release
        && e.state().intersects(
            gdk::ModifierType::CONTROL_MASK
                | gdk::ModifierType::SUPER_MASK
                | gdk::ModifierType::META_MASK,
        )
    {
        return;
    }
    if release {
        if !s.sound_keys.borrow_mut().remove(&e.hardware_keycode()) {
            return;
        }
    } else {
        s.sound_keys.borrow_mut().insert(e.hardware_keycode());
    }
    let role = match e.keyval() {
        gdk::keys::constants::Shift_L
        | gdk::keys::constants::Shift_R
        | gdk::keys::constants::Control_L
        | gdk::keys::constants::Control_R
        | gdk::keys::constants::Alt_L
        | gdk::keys::constants::Alt_R
        | gdk::keys::constants::Super_L
        | gdk::keys::constants::Super_R => {
            if release {
                TypingSoundRole::KeyUp
            } else {
                TypingSoundRole::Modifier
            }
        }
        gdk::keys::constants::space => {
            if release {
                TypingSoundRole::SpaceUp
            } else {
                TypingSoundRole::Space
            }
        }
        gdk::keys::constants::Return | gdk::keys::constants::KP_Enter => {
            if release {
                TypingSoundRole::KeyUp
            } else {
                TypingSoundRole::Enter
            }
        }
        gdk::keys::constants::BackSpace | gdk::keys::constants::Delete => {
            if release {
                TypingSoundRole::KeyUp
            } else {
                TypingSoundRole::Delete
            }
        }
        _ => {
            if release {
                TypingSoundRole::KeyUp
            } else {
                TypingSoundRole::Key
            }
        }
    };
    let handler = TYPING.with(|h| h.borrow().clone());
    if let Some(handler) = handler {
        let (surface_id, generation, _) = s.identity();
        handler(TypingSoundEvent {
            surface_id,
            generation,
            role,
        });
    }
}

thread_local! {static FONT_FAMILIES:RefCell<HashMap<String,String>>=RefCell::new(HashMap::new());}
#[link(name = "fontconfig")]
unsafe extern "C" {
    fn FcConfigAppFontAddFile(config: *mut std::ffi::c_void, file: *const u8) -> i32;
    fn FcConfigBuildFonts(config: *mut std::ffi::c_void) -> i32;
    fn FcFreeTypeQuery(
        file: *const u8,
        id: i32,
        blanks: *mut std::ffi::c_void,
        count: *mut i32,
    ) -> *mut std::ffi::c_void;
    fn FcPatternGetString(
        pattern: *mut std::ffi::c_void,
        object: *const std::ffi::c_char,
        index: i32,
        value: *mut *mut u8,
    ) -> i32;
    fn FcPatternDestroy(pattern: *mut std::ffi::c_void);
}
#[link(name = "pangocairo-1.0")]
unsafe extern "C" {
    fn pango_cairo_font_map_get_default() -> *mut std::ffi::c_void;
}
#[link(name = "pangoft2-1.0")]
unsafe extern "C" {
    fn pango_fc_font_map_config_changed(map: *mut std::ffi::c_void);
}
pub fn register_font(path: &std::path::Path, expected_family: &str) -> Result<(), String> {
    use std::os::unix::ffi::OsStrExt;
    let path = std::ffi::CString::new(path.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
    let mut count = 0;
    let pattern =
        unsafe { FcFreeTypeQuery(path.as_ptr().cast(), 0, std::ptr::null_mut(), &mut count) };
    if pattern.is_null() {
        return Err("writing font is missing or invalid".into());
    }
    let property = |name: &[u8]| {
        let mut value = std::ptr::null_mut();
        if unsafe { FcPatternGetString(pattern, name.as_ptr().cast(), 0, &mut value) } == 0
            && !value.is_null()
        {
            unsafe { std::ffi::CStr::from_ptr(value.cast()) }
                .to_string_lossy()
                .into_owned()
        } else {
            String::new()
        }
    };
    let family = property(b"family\0");
    let postscript = property(b"postscriptname\0");
    unsafe {
        FcPatternDestroy(pattern);
    }
    if expected_family != family && expected_family != postscript {
        return Err("writing font does not match the expected family or PostScript name".into());
    }
    if unsafe { FcConfigAppFontAddFile(std::ptr::null_mut(), path.as_ptr().cast()) } == 0 {
        return Err("native font registration failed".into());
    }
    unsafe {
        FcConfigBuildFonts(std::ptr::null_mut());
    }
    FONT_FAMILIES.with(|f| f.borrow_mut().insert(expected_family.into(), family));
    // Pango's Fc font-set cache must be invalidated, including before the
    // first Sumi surface is mounted. Merely rebuilding Fontconfig is not enough.
    unsafe {
        let map = pango_cairo_font_map_get_default();
        if !map.is_null() {
            pango_fc_font_map_config_changed(map);
        }
    }
    Ok(())
}
pub fn register_font_cascade(alias: &str, families: &[String]) -> Result<(), String> {
    let resolved = FONT_FAMILIES.with(|registered| {
        families
            .iter()
            .map(|f| {
                registered
                    .borrow()
                    .get(f)
                    .cloned()
                    .ok_or_else(|| format!("font has not been registered: {f}"))
            })
            .collect::<Result<Vec<_>, String>>()
    })?;
    CASCADES.with(|c| c.borrow_mut().insert(alias.into(), resolved));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn utf16_gtk_coordinates() {
        let s = "a😀中\n";
        assert_eq!(utf16_offset(s, 2), 3);
        assert_eq!(char_offset(s, 3), 2);
        assert_eq!(char_offset(s, 5), 4);
    }
    #[test]
    fn replacement_diff_preserves_unicode_boundaries() {
        let (r, t) = difference("A😀中B", "A😃文B");
        assert_eq!(r.start, 1);
        assert_eq!(r.length, 3);
        assert_eq!(t, "😃文");
        let (r, t) = difference("a", "a\n");
        assert_eq!(r.start, 1);
        assert_eq!(r.length, 0);
        assert_eq!(t, "\n");
    }
    #[test]
    fn linux_shortcuts_use_exact_modifiers() {
        use gdk::{keys::constants::*, ModifierType as M};
        assert_eq!(shortcut(b, M::CONTROL_MASK), Some("bold"));
        assert_eq!(
            shortcut(_1, M::CONTROL_MASK | M::MOD1_MASK),
            Some("heading1")
        );
        assert_eq!(
            shortcut(V, M::CONTROL_MASK | M::SHIFT_MASK),
            Some("paste_plain")
        );
        assert_eq!(shortcut(F11, M::empty()), Some("fullscreen"));
        for mask in [M::CONTROL_MASK, M::SHIFT_MASK, M::MOD1_MASK, M::SUPER_MASK, M::META_MASK] {
            assert_eq!(shortcut(F11, mask), None);
        }
        assert_eq!(shortcut(Return, M::SUPER_MASK), None);
        assert_eq!(shortcut(KP_Enter, M::SUPER_MASK), None);
        assert_eq!(shortcut(Return, M::CONTROL_MASK), None);
        assert_eq!(
            shortcut(b, M::CONTROL_MASK | M::MOD1_MASK | M::SHIFT_MASK),
            None
        );
    }
    #[test]
    fn linux_shortcuts_ignore_caps_lock_letter_case_without_ignoring_shift() {
        use gdk::{keys::constants::*, ModifierType as M};
        assert_eq!(shortcut(B, M::CONTROL_MASK), Some("bold"));
        assert_eq!(shortcut(v, M::CONTROL_MASK | M::SHIFT_MASK), Some("paste_plain"));
        assert_eq!(shortcut(z, M::CONTROL_MASK | M::SHIFT_MASK), Some("redo"));
        assert_eq!(shortcut(I, M::SUPER_MASK), None);
        assert_eq!(shortcut(b, M::CONTROL_MASK | M::SHIFT_MASK), None);
    }
    #[test]
    #[ignore = "requires isolated Wayland compositor, grim, magick and SUMI_NATIVE_DAMAGE_DIR"]
    fn native_wayland_damage() {
        fn settle() {
            for _ in 0..60 {
                while gtk::events_pending() {
                    gtk::main_iteration_do(false);
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
        }
        let directory = std::path::PathBuf::from(std::env::var("SUMI_NATIVE_DAMAGE_DIR").unwrap());
        std::fs::create_dir_all(&directory).unwrap();
        let capture = |name: &str| {
            let path = directory.join(format!("{name}.png"));
            assert!(std::process::Command::new("grim")
                .arg(&path)
                .status()
                .unwrap()
                .success());
            path
        };
        gtk::init().unwrap();
        let app = gtk::Application::new(
            Some("net.notemd.sumi.damage-test"),
            gtk::gio::ApplicationFlags::NON_UNIQUE,
        );
        app.register(None::<&gtk::gio::Cancellable>).unwrap();
        let window = gtk::ApplicationWindow::new(&app);
        window.set_default_size(800, 500);
        let webview = webkit2gtk::WebView::new();
        webkit2gtk::WebViewExt::load_html(
            &webview,
            "<body style='background:#f3ead7'>Native damage test</body>",
            None,
        );
        window.add(&webview);
        let sample = "Alpha 中文 😀\nSecond line remains exactly once\nThird line REOPEN_OK";
        let config = SurfaceConfig {
            surface_id: "damage".into(),
            generation: 1,
            revision: 0,
            bounds: Bounds {
                x: 0.0,
                y: 0.0,
                width: 800.0,
                height: 500.0,
            },
            appearance: Appearance {
                caret_motion: CaretMotion::Steady,
                background: "#f3ead7".into(),
                foreground: "#45433d".into(),
                ..Appearance::default()
            },
            document: RenderDocument {
                text: sample.into(),
                runs: vec![],
            },
            selection: TextRange {
                start: sample.encode_utf16().count() as u32,
                length: 0,
            },
            viewport: Viewport::default(),
        };
        mount(
            &window,
            "damage",
            config,
            Arc::new(|_| Ok(0.into())),
            Some(webview.upcast()),
        )
        .unwrap();
        window.show_all();
        let surface = surface("damage", "damage", 1).unwrap();
        surface.view.grab_focus();
        settle();
        assert!(surface.view.has_focus());
        for _ in 0..4 {
            surface.typing();
        }
        settle();
        assert!(surface.focused.get());
        capture("focused");
        surface.reading();
        let previous = surface.selection().start;
        surface.view.emit_by_name::<()>(
            "move-cursor",
            &[&gtk::MovementStep::LogicalPositions, &-1i32, &false],
        );
        assert_eq!(
            surface.selection().start,
            previous - 1,
            "native keyboard navigation remains enabled"
        );
        settle();
        let before = capture("reading-before-redraw");
        surface.overlay.queue_draw();
        surface.view.queue_draw();

        settle();
        let after = capture("reading-after-redraw");
        let difference = std::process::Command::new("magick")
            .arg(&before)
            .arg(&after)
            .args([
                "-compose",
                "difference",
                "-composite",
                "-format",
                "%[fx:mean]",
                "info:",
            ])
            .output()
            .unwrap();
        assert!(difference.status.success());
        let difference = String::from_utf8(difference.stdout)
            .unwrap()
            .trim()
            .parse::<f64>()
            .unwrap();
        surface.view.set_cursor_visible(false);
        surface.view.queue_draw();
        settle();
        let without_native_cursor = capture("native-cursor-disabled");
        let cursor_difference = std::process::Command::new("magick")
            .arg(&after)
            .arg(&without_native_cursor)
            .args([
                "-compose",
                "difference",
                "-composite",
                "-format",
                "%[fx:mean]",
                "info:",
            ])
            .output()
            .unwrap();
        assert!(cursor_difference.status.success());
        let cursor_difference = String::from_utf8(cursor_difference.stdout)
            .unwrap()
            .trim()
            .parse::<f64>()
            .unwrap();
        surface.view.set_cursor_visible(true);
        let long_line =
            "FINAL_OMARCHY 保存验证 😀 VERIFIED_PACKAGE_REOPEN_OK NAVIGATION_Y ".repeat(10);
        surface.project(
            RenderDocument {
                text: long_line.clone(),
                runs: vec![],
            },
            TextRange::default(),
            0,
        );
        for width in [800.0, 400.0] {
            command(
                "damage",
                "damage",
                1,
                SurfaceCommand::SetBounds {
                    bounds: Bounds {
                        x: 0.0,
                        y: 0.0,
                        width,
                        height: 500.0,
                    },
                },
            )
            .unwrap();
            settle();
            let buffer = surface.buffer();
            let mut iter = buffer.start_iter();
            let mut rows = 1;
            while surface.view.forward_display_line(&mut iter) {
                rows += 1;
            }
            eprintln!(
                "wrap bounds={width} scroll={} view={} mode={:?} rows={rows} margins={},{}",
                surface.scroll.allocated_width(),
                surface.view.allocated_width(),
                surface.view.wrap_mode(),
                surface.view.left_margin(),
                surface.view.right_margin()
            );
            assert_eq!(surface.view.wrap_mode(), gtk::WrapMode::WordChar);
            assert!(surface.view.allocated_width() <= width as i32);
            assert!(rows > 1, "long paragraph must wrap within native bounds");
            for offset in 0..buffer.char_count() {
                let rect = surface.view.iter_location(&buffer.iter_at_offset(offset));
                assert!(
                    rect.x() + rect.width() <= surface.view.allocated_width(),
                    "glyph at {offset} clipped beyond narrow view"
                );
            }
            capture(&format!("wrap-{width}"));
        }
        detach("damage", "damage", 1).unwrap();
        window.close();
        assert_eq!(
            difference, 0.0,
            "navigation must match a fresh repaint, without stale text pixels"
        );
        assert_eq!(
            cursor_difference, 0.0,
            "CSS must suppress every system caret pixel while preserving navigation"
        );
    }
    #[test]
    #[ignore = "requires isolated Wayland display; measures real fullscreen GTK allocation"]
    fn native_fullscreen_font_geometry() {
        fn settle() {
            for _ in 0..30 {
                while gtk::events_pending() { gtk::main_iteration_do(false); }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
        }
        gtk::init().unwrap();
        let app = gtk::Application::new(Some("net.notemd.sumi.font-geometry"), gtk::gio::ApplicationFlags::NON_UNIQUE);
        app.register(None::<&gtk::gio::Cancellable>).unwrap();
        let window = gtk::ApplicationWindow::new(&app);
        window.set_default_size(960, 720);
        window.add(&gtk::DrawingArea::new());
        let config = SurfaceConfig {
            surface_id: "font-geometry".into(), generation: 1, revision: 0,
            bounds: Bounds { x: 0.0, y: 0.0, width: 960.0, height: 720.0 },
            appearance: Appearance { font_size: 22.0, focus_typing: false, ..Appearance::default() },
            document: RenderDocument { text: "M Ag中\nM Ag中".into(), runs: vec![] },
            selection: TextRange::default(), viewport: Viewport::default(),
        };
        mount(&window, "font-geometry", config, Arc::new(|_| Ok(0.into())), None).unwrap();
        window.show_all();
        let s = surface("font-geometry", "font-geometry", 1).unwrap();
        let mut records = Vec::new();
        for (stage, fullscreen, font_size) in [("normal", false, 22.0), ("fullscreen", true, 22.0), ("restored", false, 22.0), ("normal-large", false, 27.5), ("fullscreen-large", true, 27.5), ("restored-large", false, 27.5)] {
            if fullscreen { window.fullscreen(); } else { window.unfullscreen(); }
            settle();
            let width = window.allocated_width();
            let height = window.allocated_height();
            command("font-geometry", "font-geometry", 1, SurfaceCommand::SetBounds { bounds: Bounds { x: 0.0, y: 0.0, width: width as f64, height: height as f64 } }).unwrap();
            let mut appearance = s.config.borrow().appearance.clone();
            appearance.font_size = font_size;
            command("font-geometry", "font-geometry", 1, SurfaceCommand::SetAppearance { appearance }).unwrap();
            settle();
            let metrics = ["M", "Ag中"].map(|sample| {
                let layout = s.view.create_pango_layout(Some(sample));
                let (width, height) = layout.size();
                let (ink, _) = layout.pixel_extents();
                serde_json::json!({"sample":sample,"width":width as f64 / pango::SCALE as f64,"height":height as f64 / pango::SCALE as f64,"ink":[ink.x(),ink.y(),ink.width(),ink.height()]})
            });
            let caret = s.caret_geometry();
            let first = s.view.iter_location(&s.buffer().start_iter());
            assert!(caret.height() > 0 && caret.height() <= first.height());
            assert!(caret.y() >= first.y() && caret.y() + caret.height() <= first.y() + first.height() + 1);
            assert_eq!(text(&s.buffer()), "M Ag中\nM Ag中");
            records.push(serde_json::json!({"stage":stage,"font_size":s.config.borrow().appearance.font_size,"scale":window.scale_factor(),"allocation":[width,height],"textview":[s.view.allocated_width(),s.view.allocated_height()],"metrics":metrics,"caret":[caret.x(),caret.y(),caret.width(),caret.height()],"line":[first.x(),first.y(),first.width(),first.height()]}));
        }
        // Compare the same effective font size across window modes. Different
        // sizes legitimately have different hinting and fallback-font metrics.
        for offset in [0, 3] {
            assert_eq!(records[offset]["metrics"], records[offset + 1]["metrics"]);
            assert_eq!(records[offset]["metrics"], records[offset + 2]["metrics"]);
        }
        let evidence = serde_json::to_string_pretty(&records).unwrap();
        println!("{evidence}");
        if let Ok(dir) = std::env::var("SUMI_CANDIDATE_TEST_ARTIFACTS") {
            std::fs::write(std::path::Path::new(&dir).join("font-geometry.json"), evidence).unwrap();
        }
        detach("font-geometry", "font-geometry", 1).unwrap();
        window.close();
    }

    #[test]
    #[ignore = "requires GTK display connection; renders only an offscreen window"]
    fn native_focus_center_is_idempotent_offscreen() {
        fn settle() {
            for _ in 0..4 {
                while gtk::events_pending() {
                    gtk::main_iteration_do(false);
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
        }
        gtk::init().unwrap();
        let app = gtk::Application::new(
            Some("net.notemd.sumi.focus-stability-test"),
            gtk::gio::ApplicationFlags::NON_UNIQUE,
        );
        app.register(None::<&gtk::gio::Cancellable>).unwrap();
        let hidden = gtk::ApplicationWindow::new(&app);
        hidden.add(&gtk::DrawingArea::new());
        let line = "Stable line 中文 stays on the same baseline.\n";
        let config = SurfaceConfig {
            surface_id: "focus-stability".into(),
            generation: 1,
            revision: 0,
            bounds: Bounds {
                x: 0.0,
                y: 0.0,
                width: 1280.0,
                height: 500.0,
            },
            appearance: Appearance {
                focus_typing: true,
                ..Appearance::default()
            },
            document: RenderDocument {
                text: line.repeat(100),
                runs: vec![],
            },
            selection: TextRange {
                start: (line.encode_utf16().count() * 50) as u32,
                length: 0,
            },
            viewport: Viewport::default(),
        };
        mount(
            &hidden,
            "focus-stability",
            config,
            Arc::new(|_| Ok(0.into())),
            None,
        )
        .unwrap();
        let s = surface("focus-stability", "focus-stability", 1).unwrap();
        hidden.remove(&s.overlay);
        let offscreen = gtk::OffscreenWindow::new();
        offscreen.set_default_size(1280, 800);
        offscreen.add(&s.overlay);
        offscreen.show_all();
        s.focused.set(true);
        *s.focus_frame.borrow_mut() = focus::Frame::new(true);
        s.appearance();
        settle();
        assert_eq!(s.scroll.vscrollbar_policy(), gtk::PolicyType::External);
        assert!(!s.scroll.vscrollbar().unwrap().is_child_visible());
        assert_eq!(s.scroll.shadow_type(), gtk::ShadowType::None);
        for font_size in [22.0, 22.0 * (800.0_f64 / 720.0).sqrt(), 27.5] {
            s.config.borrow_mut().appearance.font_size = font_size;
            s.appearance();
            settle();
            let cursor = s.view.cursor_locations(None).0;
            // Force a half-pixel centering target independently of the installed font.
            let opposite_parity_height = if cursor.height() % 2 == 0 {
                501.0
            } else {
                500.0
            };
            let adjustment = s.scroll.vadjustment();
            for height in [
                opposite_parity_height,
                opposite_parity_height + 1.0,
                opposite_parity_height + 0.25,
                800.0,
            ] {
                s.config.borrow_mut().bounds.height = height;
                s.position();
                s.appearance();
                settle();
                // Also exercise a fractional adjustment left by the spatial animation.
                for fraction in [0.0, 0.25, 0.8] {
                    let was = s.updating.replace(true);
                    adjustment.set_value(1000.0 + fraction);
                    s.updating.set(was);
                    settle();
                    let mut samples = Vec::new();
                    for _ in 0..20 {
                        s.center();
                        let cursor = s.view.cursor_locations(None).0;
                        let (_, y) = s.view.buffer_to_window_coords(
                            gtk::TextWindowType::Widget,
                            cursor.x(),
                            cursor.y(),
                        );
                        samples.push((adjustment.value(), y));
                        settle();
                    }
                    println!("focus font={font_size} height={height} fraction={fraction} samples={samples:?}");
                    assert!(samples[0].0 > adjustment.lower() + 10.0);
                    assert!(samples[0].0 < adjustment.upper() - adjustment.page_size() - 10.0);
                    assert!(
                        samples.iter().all(|sample| *sample == samples[0]),
                        "unchanged focus layout must be idempotent: {samples:?}"
                    );
                }
            }
            focus::verify_center_animation(&s);
        }
        s.reset_focus();
        settle();
        let cursor = s.view.cursor_locations(None).0;
        let before = s
            .view
            .buffer_to_window_coords(gtk::TextWindowType::Widget, 0, cursor.y())
            .1;
        let adjustment = s.scroll.vadjustment();
        adjustment.set_value(adjustment.value() + 50.0);
        settle();
        let after = s
            .view
            .buffer_to_window_coords(gtk::TextWindowType::Widget, 0, cursor.y())
            .1;
        assert_eq!(
            after - before,
            -50,
            "hidden scrollbar must preserve scrolling"
        );
        assert_eq!(
            s.scroll.allocated_height(),
            s.config.borrow().bounds.height as i32
        );
        if let Ok(dir) = std::env::var("SUMI_CANDIDATE_TEST_ARTIFACTS") {
            offscreen
                .pixbuf()
                .unwrap()
                .savev(
                    std::path::Path::new(&dir).join("focus-scrollbar.png"),
                    "png",
                    &[],
                )
                .unwrap();
        }
        detach("focus-stability", "focus-stability", 1).unwrap();
        offscreen.close();
        hidden.close();
    }

    #[test]
    #[ignore = "requires GTK display connection; renders only an offscreen window"]
    fn native_caret_geometry_offscreen() {
        gtk::init().unwrap();
        let app = gtk::Application::new(
            Some("net.notemd.sumi.caret-test"),
            gtk::gio::ApplicationFlags::NON_UNIQUE,
        );
        app.register(None::<&gtk::gio::Cancellable>).unwrap();
        let hidden = gtk::ApplicationWindow::new(&app);
        hidden.add(&gtk::DrawingArea::new());
        let config = SurfaceConfig {
            surface_id: "caret".into(),
            generation: 1,
            revision: 0,
            bounds: Bounds {
                x: 0.0,
                y: 0.0,
                width: 700.0,
                height: 500.0,
            },
            appearance: Appearance {
                focus_typing: false,
                ..Appearance::default()
            },
            document: RenderDocument::default(),
            selection: TextRange::default(),
            viewport: Viewport::default(),
        };
        mount(&hidden, "caret", config, Arc::new(|_| Ok(0.into())), None).unwrap();
        let s = surface("caret", "caret", 1).unwrap();
        hidden.remove(&s.overlay);
        let offscreen = gtk::OffscreenWindow::new();
        offscreen.set_default_size(700, 500);
        offscreen.add(&s.overlay);
        offscreen.show_all();
        s.caret.realize();
        assert_eq!(
            s.caret.window().unwrap().window_type(),
            gdk::WindowType::Child
        );
        for line_height in [1.0, 3.0] {
            s.config.borrow_mut().appearance.line_height = line_height;
            s.appearance();
            for sample in ["A", "中", "😀", "A😀中", "🧑‍💻", "A🧑‍💻中", "á", "سلام", ""]
            {
                for (bold, italic) in [(false, false), (true, false), (true, true)] {
                    s.project(
                        RenderDocument {
                            text: sample.into(),
                            runs: vec![StyleRun {
                                range: TextRange {
                                    start: 0,
                                    length: sample.encode_utf16().count() as u32,
                                },
                                bold,
                                italic,
                                strike: false,
                                heading: 0,
                                quote: false,
                                link: None,
                            }],
                        },
                        TextRange::default(),
                        0,
                    );
                    while gtk::events_pending() {
                        gtk::main_iteration_do(false);
                    }
                    let context = s.view.pango_context();
                    let metrics = context.metrics(
                        context.font_description().as_ref(),
                        context.language().as_ref(),
                    );
                    let ascent = metrics.ascent() as f64 / pango::SCALE as f64;
                    let height =
                        (metrics.ascent() + metrics.descent()) as f64 / pango::SCALE as f64;
                    let layout = s.view.create_pango_layout(Some(sample));
                    let attrs = pango::AttrList::new();
                    if bold {
                        attrs.insert(pango::AttrInt::new_weight(pango::Weight::Bold));
                    }
                    if italic {
                        attrs.insert(pango::AttrInt::new_style(pango::Style::Italic));
                    }
                    layout.set_attributes(Some(&attrs));
                    let baseline = layout.baseline() as f64 / pango::SCALE as f64
                        + s.view.pixels_above_lines() as f64;
                    for offset in 0..=sample.chars().count() {
                        s.buffer()
                            .place_cursor(&s.buffer().iter_at_offset(offset as i32));
                        let caret = s.caret_geometry();
                        assert!(
                            (caret.height() as f64 - height).abs() < 1.1,
                            "fixed height {sample:?}@{offset}: {} != {height}",
                            caret.height()
                        );
                        assert!(
                            (caret.y() as f64 + ascent - baseline).abs() < 1.1,
                            "baseline {sample:?}@{offset}: {} != {baseline}",
                            caret.y() as f64 + ascent
                        );
                    }
                }
            }
        }
        // Repeating an acknowledged position must not emit mark-set, which
        // GtkTextView treats as an instruction to reset its IM context.
        let doc = RenderDocument {
            text: "你好".into(),
            runs: vec![],
        };
        s.project(
            doc.clone(),
            TextRange {
                start: 2,
                length: 0,
            },
            1,
        );
        let moves = Rc::new(Cell::new(0));
        let observed = moves.clone();
        let mark_handler = s
            .buffer()
            .connect_mark_set(move |_, _, _| observed.set(observed.get() + 1));
        s.project(
            doc.clone(),
            TextRange {
                start: 2,
                length: 0,
            },
            1,
        );
        assert_eq!(moves.get(), 0);
        s.buffer().disconnect(mark_handler);
        s.view.emit_by_name::<()>("preedit-changed", &[&"ni hao"]);
        s.project(doc, TextRange::default(), 2);
        assert!(s.pending_selection.borrow().is_some());
        assert_eq!(s.selection().start, 2);
        // Navigation after the host reply supersedes its deferred target.
        s.buffer().place_cursor(&s.buffer().iter_at_offset(1));
        s.view.emit_by_name::<()>("preedit-changed", &[&""]);
        while gtk::events_pending() {
            gtk::main_iteration_do(false);
        }
        assert!(s.pending_selection.borrow().is_none());
        assert_eq!(s.selection().start, 1);
        assert_eq!(
            s.config.borrow().selection.start,
            1,
            "rollback must retain the user's current position"
        );
        // A failed draft must also reject nested GTK user actions, such as an
        // IM-context reset emitting another commit before set_editable returns.
        let preserved = text(&s.buffer());
        s.failed.set(true);
        s.view.set_editable(false);
        s.buffer().begin_user_action();
        s.buffer().insert_at_cursor("ni hao");
        s.buffer().delete(
            &mut s.buffer().start_iter(),
            &mut s.buffer().iter_at_offset(1),
        );
        s.buffer().end_user_action();
        assert_eq!(text(&s.buffer()), preserved);
        s.failed.set(false);
        s.view.set_editable(true);
        detach("caret", "caret", 1).unwrap();
        offscreen.close();
        hidden.close();
    }

    // Explicit opt-in: this is a real GTK/Wayland surface, not a mocked widget.
    #[test]
    #[ignore = "requires a desktop display; run with --ignored --test-threads=1"]
    fn native_wayland_transactions() {
        gtk::init().unwrap();
        let app = gtk::Application::new(
            Some("net.notemd.sumi.native-test"),
            gtk::gio::ApplicationFlags::NON_UNIQUE,
        );
        app.register(None::<&gtk::gio::Cancellable>).unwrap();
        let window = gtk::ApplicationWindow::new(&app);
        window.set_default_size(800, 600);
        let content = gtk::Box::new(gtk::Orientation::Vertical, 0);
        let header = gtk::Label::new(Some("Native GTK header"));
        header.set_size_request(-1, 40);
        content.pack_start(&header, false, false, 0);
        let origin = gtk::DrawingArea::new();
        content.pack_start(&origin, true, true, 0);
        window.add(&content);
        let events = Arc::new(std::sync::Mutex::new(Vec::<NativeEvent>::new()));
        let failure = Arc::new(std::sync::atomic::AtomicU8::new(0));
        let recorded = events.clone();
        let mode = failure.clone();
        let handler: EventHandler = Arc::new(move |event| {
            recorded.lock().unwrap().push(event.clone());
            if let NativeEvent::Edit { base_revision, .. } = event {
                match mode.load(std::sync::atomic::Ordering::SeqCst) {
                    1 => Err("rejected".into()),
                    5 => Ok(EventReply {
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
                            selection: TextRange::default(),
                        }),
                        ..EventReply::from(base_revision)
                    }),
                    3 => Ok(base_revision.into()),
                    2 => Ok(EventReply {
                        revision: base_revision,
                        projection: None,
                        clipboard_text: None,
                        draft_error: Some("journal unavailable".into()),
                    }),
                    _ => Ok((base_revision + 1).into()),
                }
            } else if let NativeEvent::Clipboard { revision, cut, .. } = event {
                if cut {
                    Ok(EventReply {
                        revision: revision + 1,
                        projection: Some(Projection {
                            document: RenderDocument {
                                text: "😃文B".into(),
                                runs: vec![],
                            },
                            selection: TextRange::default(),
                        }),
                        ..EventReply::from(revision)
                    })
                } else if mode.load(std::sync::atomic::Ordering::SeqCst) == 4 {
                    Err("clipboard serialization failed".into())
                } else {
                    Ok(EventReply {
                        revision,
                        clipboard_text: Some("**A**".into()),
                        ..EventReply::from(revision)
                    })
                }
            } else {
                Ok(0.into())
            }
        });
        let config = SurfaceConfig {
            surface_id: "test".into(),
            generation: 1,
            revision: 0,
            bounds: Bounds {
                x: 10.0,
                y: 20.0,
                width: 700.0,
                height: 500.0,
            },
            appearance: Appearance::default(),
            document: RenderDocument {
                text: "A😀中B".into(),
                runs: vec![],
            },
            selection: TextRange::default(),
            viewport: Viewport::default(),
        };
        mount(
            &window,
            "test",
            config,
            handler,
            Some(origin.clone().upcast()),
        )
        .unwrap();
        window.show_all();
        while gtk::events_pending() {
            gtk::main_iteration_do(false);
        }
        let s = surface("test", "test", 1).unwrap();
        for height in [40, 70] {
            header.set_size_request(-1, height);
            for _ in 0..10 {
                while gtk::events_pending() {
                    gtk::main_iteration_do(false);
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            let (_, origin_y) = origin.translate_coordinates(&s.overlay, 0, 0).unwrap();
            assert!(origin_y >= height);
            assert_eq!(
                s.scroll.margin_top(),
                20 + origin_y,
                "native bounds follow WebKit-origin allocation, including a changing host header"
            );
            assert_eq!(s.decoration.margin_top(), s.scroll.margin_top());
        }
        // Exercise real identity checks and registration on an installed font,
        // without downloading assets or changing the system font collection.
        let matched_font = std::process::Command::new("fc-match")
            .args([
                "-f",
                "%{file}\n%{family[0]}\n%{postscriptname[0]}\n",
                "monospace",
            ])
            .output()
            .unwrap();
        assert!(matched_font.status.success());
        let font = String::from_utf8(matched_font.stdout).unwrap();
        let mut parts = font.lines();
        let path = std::path::Path::new(parts.next().unwrap());
        let family = parts.next().unwrap();
        let postscript = parts.next().unwrap();
        assert!(register_font(path, "Wrong Sumi test identity").is_err());
        register_font(path, postscript).unwrap();
        register_font_cascade("Sumi Linux test", &[postscript.into()]).unwrap();
        assert_eq!(
            CASCADES.with(|maps| maps.borrow()["Sumi Linux test"].clone()),
            vec![family.to_owned()]
        );
        let loaded = s
            .view
            .pango_context()
            .load_font(&pango::FontDescription::from_string(family))
            .unwrap();
        assert_eq!(loaded.describe().family().as_deref(), Some(family));
        command("test", "test", 1, SurfaceCommand::PreparePanel).unwrap();
        assert!(!inspect("test", "test", 1).unwrap().visible);
        command(
            "test",
            "test",
            1,
            SurfaceCommand::SetVisible { visible: true },
        )
        .unwrap();
        let b = s.buffer();
        b.begin_user_action();
        let mut start = b.iter_at_offset(1);
        let mut end = b.iter_at_offset(3);
        b.delete(&mut start, &mut end);
        let mut insert = b.iter_at_offset(1);
        b.insert(&mut insert, "😃文");
        b.end_user_action();
        let state = inspect("test", "test", 1).unwrap();
        assert_eq!(state.text, "A😃文B");
        assert_eq!(state.revision, 1);
        let edits: Vec<_> = events
            .lock()
            .unwrap()
            .iter()
            .filter(|e| matches!(e, NativeEvent::Edit { .. }))
            .cloned()
            .collect();
        assert_eq!(edits.len(), 1);
        match &edits[0] {
            NativeEvent::Edit {
                range, replacement, ..
            } => {
                assert_eq!(range.start, 1);
                assert_eq!(range.length, 3);
                assert_eq!(replacement, "😃文");
            }
            _ => unreachable!(),
        }
        assert!(command("test", "test", 2, SurfaceCommand::Focus).is_err());
        assert!(command(
            "test",
            "test",
            1,
            SurfaceCommand::ApplyDocument {
                base_revision: 0,
                revision: 2,
                document: RenderDocument::default(),
                selection: TextRange::default()
            }
        )
        .is_err());
        // A failed search must never replace an unrelated existing selection.
        b.select_range(&b.iter_at_offset(1), &b.start_iter());
        *s.search.borrow_mut() = "not present".into();
        assert!(s.perform("replace"));
        let dialog = gtk::Window::list_toplevels()
            .into_iter()
            .find_map(|w| w.downcast::<gtk::Dialog>().ok())
            .unwrap();
        dialog.response(gtk::ResponseType::Accept);
        assert_eq!(inspect("test", "test", 1).unwrap().text, "A😃文B");
        assert_eq!(inspect("test", "test", 1).unwrap().revision, 1);
        // Exercise the asynchronous GTK clipboard fallback, offering RTF only.
        s.view.grab_focus();
        window.present();
        for _ in 0..100 {
            while gtk::events_pending() {
                gtk::main_iteration_do(false);
            }
            if s.view.has_focus() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(
            s.view.has_focus(),
            "clipboard acceptance needs native keyboard focus"
        );
        let clipboard = gtk::Clipboard::get(&gdk::SELECTION_CLIPBOARD);
        for mime in ["text/rtf", "application/rtf"] {
            let before_paste = events.lock().unwrap().len();
            assert!(clipboard.set_with_data(
                &[gtk::TargetEntry::new(mime, gtk::TargetFlags::empty(), 0)],
                move |_, data, _| {
                    data.set(&gdk::Atom::intern(mime), 8, br"{\rtf1\ansi Hello \u20013?}");
                },
            ));
            s.paste(false);
            for _ in 0..100 {
                while gtk::events_pending() {
                    gtk::main_iteration_do(false);
                }
                if events.lock().unwrap()[before_paste..]
                    .iter()
                    .any(|e| matches!(e, NativeEvent::Paste { .. }))
                {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            assert!(events.lock().unwrap()[before_paste..].iter().any(|event|
                matches!(event, NativeEvent::Paste { text: Some(text), html: None, rtf: None, literal: false, .. } if text == "Hello 中")
            ), "RTF-only {mime} must reach the host as decoded plain text");
        }
        // A cut first obtains serialized Markdown, then requests host deletion.
        // A serialization failure must not reach the deletion callback.
        b.select_range(&b.iter_at_offset(1), &b.start_iter());
        let before_cut = events.lock().unwrap().len();
        s.clipboard(true);
        let cut_flags: Vec<_> = events.lock().unwrap()[before_cut..]
            .iter()
            .filter_map(|event| match event {
                NativeEvent::Clipboard { cut, .. } => Some(*cut),
                _ => None,
            })
            .collect();
        assert_eq!(cut_flags, vec![false, true]);
        let copied = Rc::new(RefCell::new(None));
        let observed = copied.clone();
        clipboard.request_text(move |_, value| {
            *observed.borrow_mut() = value.map(str::to_owned);
        });
        for _ in 0..100 {
            while gtk::events_pending() {
                gtk::main_iteration_do(false);
            }
            if copied.borrow().is_some() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert_eq!(copied.borrow().as_deref(), Some("**A**"));
        assert_eq!(inspect("test", "test", 1).unwrap().text, "😃文B");
        s.project(
            RenderDocument {
                text: "A😃文B".into(),
                runs: vec![],
            },
            TextRange {
                start: 0,
                length: 1,
            },
            1,
        );
        failure.store(4, std::sync::atomic::Ordering::SeqCst);
        let before_failed_cut = events.lock().unwrap().len();
        s.clipboard(true);
        assert_eq!(events.lock().unwrap().len(), before_failed_cut + 1);
        assert_eq!(inspect("test", "test", 1).unwrap().text, "A😃文B");
        assert_eq!(inspect("test", "test", 1).unwrap().revision, 1);
        // Equal revisions do not acknowledge edits; restore both text and selection.
        failure.store(3, std::sync::atomic::Ordering::SeqCst);
        b.place_cursor(&b.start_iter());
        b.begin_user_action();
        b.insert_at_cursor("未确认");
        b.end_user_action();
        assert_eq!(inspect("test", "test", 1).unwrap().text, "A😃文B");
        assert_eq!(inspect("test", "test", 1).unwrap().selection.start, 0);
        // GTK clears preedit before committing. The host barrier must remain
        // active through the final edit and end at its acknowledged revision.
        failure.store(0, std::sync::atomic::Ordering::SeqCst);
        let first_ime_event = events.lock().unwrap().len();
        s.view.emit_by_name::<()>("preedit-changed", &[&"ni"]);
        s.view.emit_by_name::<()>("preedit-changed", &[&""]);
        assert!(s.composing.get());
        b.begin_user_action();
        b.insert_at_cursor("你");
        b.end_user_action();
        assert!(s.composing.get());
        while gtk::events_pending() {
            gtk::main_iteration_do(false);
        }
        assert!(!s.composing.get());
        let ime_events = events.lock().unwrap()[first_ime_event..].to_vec();
        let begin = ime_events
            .iter()
            .position(|e| matches!(e, NativeEvent::Composition { active: true, .. }))
            .unwrap();
        let edit = ime_events
            .iter()
            .position(|e| matches!(e, NativeEvent::Edit { .. }))
            .unwrap();
        let end = ime_events
            .iter()
            .position(|e| {
                matches!(
                    e,
                    NativeEvent::Composition {
                        active: false,
                        revision: 2,
                        ..
                    }
                )
            })
            .unwrap();
        assert!(begin < edit && edit < end);
        // Restore the fixture revision for the failure cases below.
        s.project(
            RenderDocument {
                text: "A😃文B".into(),
                runs: vec![],
            },
            TextRange::default(),
            1,
        );
        // GTK/Fcitx can deliver commit before clearing preedit. A host rich
        // projection may change both the text and the desired insertion point.
        failure.store(5, std::sync::atomic::Ordering::SeqCst);
        b.place_cursor(&b.end_iter());
        let before_projection = events.lock().unwrap().len();
        s.view.emit_by_name::<()>("preedit-changed", &[&"ni hao"]);
        b.begin_user_action();
        b.insert_at_cursor("你好");
        b.end_user_action();
        assert_eq!(text(&b), "你好");
        assert_eq!(
            s.selection().start,
            2,
            "selection waits for IME commit stack to drain"
        );
        assert!(s.pending_selection.borrow().is_some());
        s.view.emit_by_name::<()>("preedit-changed", &[&""]);
        assert!(s.composing.get());
        while gtk::events_pending() {
            gtk::main_iteration_do(false);
        }
        assert_eq!(s.selection().start, 0);
        assert!(s.pending_selection.borrow().is_none());
        assert!(!s.composing.get());
        let projected_events = events.lock().unwrap()[before_projection..].to_vec();
        assert_eq!(
            projected_events
                .iter()
                .filter(|event| matches!(event, NativeEvent::Edit { .. }))
                .count(),
            1
        );
        assert!(projected_events.iter().any(|event| matches!(
            event,
            NativeEvent::Composition {
                active: false,
                revision: 2,
                ..
            }
        )));
        s.project(
            RenderDocument {
                text: "A😃文B".into(),
                runs: vec![],
            },
            TextRange::default(),
            1,
        );
        failure.store(1, std::sync::atomic::Ordering::SeqCst);
        b.begin_user_action();
        b.insert_at_cursor("拒绝");
        b.end_user_action();
        assert_eq!(inspect("test", "test", 1).unwrap().text, "A😃文B");
        failure.store(2, std::sync::atomic::Ordering::SeqCst);
        b.begin_user_action();
        b.insert_at_cursor("草稿");
        b.end_user_action();
        let state = inspect("test", "test", 1).unwrap();
        assert!(state.text.contains("草稿"));
        assert_eq!(state.revision, 1);
        assert!(!s.view.is_editable());
        let before_save = events.lock().unwrap().len();
        s.action("save");
        assert!(events.lock().unwrap()[before_save..]
            .iter()
            .any(|event| matches!(event, NativeEvent::Action { action, .. } if action == "save")));

        s.view.emit_by_name::<()>("preedit-changed", &[&"ni"]);
        assert!(inspect("test", "test", 1).unwrap().composing);
        assert!(command("test", "test", 1, SurfaceCommand::PreparePanel).is_err());
        assert!(detach("test", "test", 1).is_err());
        assert_eq!(s.preedit.borrow().as_str(), "ni");
        s.view.emit_by_name::<()>("preedit-changed", &[&""]);
        assert!(inspect("test", "test", 1).unwrap().composing);
        while gtk::events_pending() {
            gtk::main_iteration_do(false);
        }
        assert!(!inspect("test", "test", 1).unwrap().composing);
        focus::verify_native_focus(&s);
        let revision = s.config.borrow().revision;
        command(
            "test",
            "test",
            1,
            SurfaceCommand::ApplyDocument {
                base_revision: revision,
                revision,
                document: RenderDocument::default(),
                selection: TextRange::default(),
            },
        )
        .unwrap();
        command("test", "test", 1, SurfaceCommand::PreparePanel).unwrap();
        command(
            "test",
            "test",
            1,
            SurfaceCommand::SetVisible { visible: true },
        )
        .unwrap();
        for _ in 0..10 {
            while gtk::events_pending() {
                gtk::main_iteration_do(false);
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(
            s.focused.get(),
            "returning from settings keeps a ready blank page centered"
        );
        let (cursor, _) = s.view.cursor_locations(None);
        let (_, y) =
            s.view
                .buffer_to_window_coords(gtk::TextWindowType::Widget, cursor.x(), cursor.y());
        assert!((y as f64 + cursor.height() as f64 / 2.0 - 250.0).abs() < 3.0);
        assert_eq!(s.config.borrow().revision, revision);
        assert!(text(&s.buffer()).is_empty());
        let mut reopened = s.config.borrow().clone();
        reopened.generation = 2;
        reopened.document = RenderDocument {
            text: "重挂后仍然可见 Hello 😀".into(),
            runs: vec![],
        };
        reopened.selection = TextRange::default();
        reopened.viewport = Viewport::default();
        let handler = s.handler.clone();
        detach("test", "test", 1).unwrap();
        assert!(inspect("test", "test", 1).is_err());
        window.hide();
        window.show_all();
        mount(
            &window,
            "test",
            reopened.clone(),
            handler,
            Some(origin.clone().upcast()),
        )
        .unwrap();
        command("test", "test", 2, SurfaceCommand::Focus).unwrap();
        let restored = surface("test", "test", 2).unwrap();
        for _ in 0..20 {
            while gtk::events_pending() {
                gtk::main_iteration_do(false);
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let state = inspect("test", "test", 2).unwrap();
        assert!(state.visible && restored.view.is_mapped() && restored.scroll.is_mapped());
        assert_eq!(state.text, reopened.document.text);
        assert!(restored.caret.is_mapped());
        let caret_window = restored.caret.window().unwrap();
        assert_eq!(caret_window.window_type(), gdk::WindowType::Subsurface);
        assert!(caret_window.has_native());
        assert!(caret_window.is_pass_through());
        assert_eq!(caret_window.width(), restored.caret.allocated_width());
        assert_eq!(caret_window.height(), restored.caret.allocated_height());
        assert_eq!(caret_window.scale_factor(), restored.view.scale_factor());
        for x in [30.0, 60.0] {
            let mut bounds = restored.config.borrow().bounds.clone();
            bounds.x = x;
            command("test", "test", 2, SurfaceCommand::SetBounds { bounds }).unwrap();
            for _ in 0..200 {
                while gtk::events_pending() {
                    gtk::main_iteration_do(false);
                }
                let cursor = restored.caret_geometry();
                let (cx, cy) = restored.view.buffer_to_window_coords(
                    gtk::TextWindowType::Widget,
                    cursor.x(),
                    cursor.y(),
                );
                let (ox, oy) = restored
                    .overlay
                    .translate_coordinates(&window, 0, 0)
                    .unwrap();
                if caret_window.position()
                    == (
                        ox + restored.scroll.margin_start() + cx,
                        oy + restored.scroll.margin_top() + cy,
                    )
                {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            let (ox, oy) = restored
                .overlay
                .translate_coordinates(&window, 0, 0)
                .unwrap();
            let cursor = restored.caret_geometry();
            let (cx, cy) = restored.view.buffer_to_window_coords(
                gtk::TextWindowType::Widget,
                cursor.x(),
                cursor.y(),
            );
            assert_eq!(
                caret_window.position(),
                (
                    ox + restored.scroll.margin_start() + cx,
                    oy + restored.scroll.margin_top() + cy
                ),
                "native subsurface follows the GTK overlay's changed position"
            );
        }
        command("test", "test", 2, SurfaceCommand::PreparePanel).unwrap();
        assert!(!restored.caret.is_mapped() && !caret_window.is_visible());
        command(
            "test",
            "test",
            2,
            SurfaceCommand::SetVisible { visible: true },
        )
        .unwrap();
        command("test", "test", 2, SurfaceCommand::Focus).unwrap();
        for _ in 0..10 {
            while gtk::events_pending() {
                gtk::main_iteration_do(false);
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(restored.caret.is_mapped() && caret_window.is_visible());
        let mut pixels = gtk::cairo::ImageSurface::create(
            gtk::cairo::Format::ARgb32,
            restored.view.allocated_width(),
            restored.view.allocated_height(),
        )
        .unwrap();
        let cr = gtk::cairo::Context::new(&pixels).unwrap();
        restored.view.draw(&cr);
        drop(cr);
        pixels.flush();
        let data = pixels.data().unwrap();
        let colors: std::collections::HashSet<_> = data
            .chunks_exact(4)
            .map(|pixel| [pixel[0], pixel[1], pixel[2], pixel[3]])
            .collect();
        assert!(
            colors.len() > 2,
            "remounted TextView must rasterize visible glyphs, not a blank background"
        );
        drop(data);
        detach("test", "test", 2).unwrap();
        assert!(caret_window.is_destroyed());
        window.close();
    }
}
