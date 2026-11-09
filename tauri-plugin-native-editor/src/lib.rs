//! A host-controlled native text surface. This crate registers no JavaScript commands.
//! The host authorizes a document session before mounting and owns Markdown/CRDT/storage.
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{plugin::TauriPlugin, Runtime, WebviewWindow};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Appearance {
    pub font_family: String,
    pub font_size: f64,
    pub line_height: f64,
    pub foreground: String,
    pub background: String,
    pub max_columns: u32,
    pub bottom_inset: f64,
    /// Initial UI language. Live updates use SetLocale without reapplying text styles.
    #[serde(default = "default_locale")]
    pub locale: String,
    #[serde(default, alias = "caretMotion")]
    pub caret_motion: CaretMotion,
    #[serde(default = "default_focus_typing", alias = "focusTyping")]
    pub focus_typing: bool,
}
fn default_locale() -> String { "en".into() }
fn default_focus_typing() -> bool { true }

/// UI language only; unknown languages use English without changing document data.
pub fn normalize_locale(locale: &str) -> &'static str {
    match locale.trim().split(['-', '_']).next().unwrap_or_default().to_ascii_lowercase().as_str() {
        "zh" => "zh",
        "ja" => "ja",
        _ => "en",
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CaretMotion {
    #[default]
    Breathing,
    Steady,
}
impl Default for Appearance {
    fn default() -> Self {
        Self {
            font_family: "Noto Sans CJK SC".into(),
            font_size: 22.0,
            line_height: 1.6,
            foreground: "#d0d0d0".into(),
            background: "#111111".into(),
            max_columns: 80,
            bottom_inset: 0.0,
            locale: default_locale(),
            caret_motion: CaretMotion::Breathing,
            focus_typing: default_focus_typing(),
        }
    }
}
#[derive(Clone, Debug, Deserialize, Serialize, Default)]
pub struct TextRange {
    pub start: u32,
    pub length: u32,
}
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct Viewport {
    pub start: u32,
    pub offset: f64,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct StyleRun {
    pub range: TextRange,
    #[serde(default)]
    pub bold: bool,
    #[serde(default)]
    pub italic: bool,
    #[serde(default)]
    pub strike: bool,
    #[serde(default)]
    pub heading: u8,
    #[serde(default)]
    pub quote: bool,
    #[serde(default)]
    pub link: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize, Default)]
pub struct RenderDocument {
    pub text: String,
    #[serde(default)]
    pub runs: Vec<StyleRun>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SurfaceConfig {
    pub surface_id: String,
    pub generation: u64,
    pub revision: u64,
    pub bounds: Bounds,
    pub appearance: Appearance,
    pub document: RenderDocument,
    #[serde(default)]
    pub selection: TextRange,
    #[serde(default)]
    pub viewport: Viewport,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum NativeEvent {
    Edit {
        surface_id: String,
        generation: u64,
        base_revision: u64,
        range: TextRange,
        replacement: String,
    },
    Clipboard {
        surface_id: String,
        generation: u64,
        revision: u64,
        ranges: Vec<TextRange>,
        cut: bool,
    },
    Paste {
        surface_id: String,
        generation: u64,
        base_revision: u64,
        range: TextRange,
        text: Option<String>,
        html: Option<String>,
        rtf: Option<String>,
        #[serde(default)]
        literal: bool,
    },
    Selection {
        surface_id: String,
        generation: u64,
        revision: u64,
        range: TextRange,
    },
    Viewport {
        surface_id: String,
        generation: u64,
        revision: u64,
        viewport: Viewport,
    },
    Composition {
        surface_id: String,
        generation: u64,
        revision: u64,
        active: bool,
    },
    Action {
        surface_id: String,
        generation: u64,
        revision: u64,
        action: String,
        range: TextRange,
    },
}
/// Ephemeral sound roles only: never characters or document content.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TypingSoundRole { Key, Space, Enter, Delete, Modifier, KeyUp, SpaceUp, Stop }
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct TypingSoundEvent {
    pub surface_id: String,
    pub generation: u64,
    pub role: TypingSoundRole,
}
/// Runs on the native main thread. Only enqueue with try_send; never block or reenter AppKit.
pub type TypingSoundHandler = Arc<dyn Fn(TypingSoundEvent) + Send + Sync>;
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub struct TypingMonitorStatus {
    pub enabled: bool,
    pub permission_granted: bool,
    pub listening: bool,
}

/// Configure intent without showing a system permission prompt.
pub async fn configure_typing_monitor<R: Runtime>(app: &tauri::AppHandle<R>, enabled: bool, handler: Option<TypingSoundHandler>) -> Result<TypingMonitorStatus, String> {
    typing_on_main(app, move || platform_typing_configure(enabled, handler)).await
}
pub async fn typing_monitor_status<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<TypingMonitorStatus, String> {
    typing_on_main(app, || platform_typing_status(false)).await
}
/// Call only from the explicit user permission action, never on mount/startup.
pub async fn request_typing_permission<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<TypingMonitorStatus, String> {
    typing_on_main(app, || platform_typing_status(true)).await
}
async fn typing_on_main<R: Runtime>(app: &tauri::AppHandle<R>, f: impl FnOnce() -> TypingMonitorStatus + Send + 'static) -> Result<TypingMonitorStatus, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || { let _ = tx.send(f()); }).map_err(|e| e.to_string())?;
    rx.await.map_err(|_| "native typing monitor main thread stopped".to_owned())
}
fn platform_typing_configure(enabled: bool, handler: Option<TypingSoundHandler>) -> TypingMonitorStatus {
    #[cfg(target_os = "macos")] { platform::configure_typing(enabled, handler) }
    #[cfg(not(target_os = "macos"))] { let _ = (enabled, handler); TypingMonitorStatus { enabled: false, permission_granted: false, listening: false } }
}
fn platform_typing_status(request: bool) -> TypingMonitorStatus {
    #[cfg(target_os = "macos")] { platform::typing_status(request) }
    #[cfg(not(target_os = "macos"))] { let _ = request; TypingMonitorStatus { enabled: false, permission_granted: false, listening: false } }
}

/// Controlled rich projection installed synchronously before the next native input.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Projection {
    pub document: RenderDocument,
    pub selection: TextRange,
}
#[derive(Clone, Debug)]
pub struct EventReply {
    pub revision: u64,
    pub projection: Option<Projection>,
    pub clipboard_text: Option<String>,
    /// Retain the supplied draft without acknowledging its revision.
    pub draft_error: Option<String>,
}
impl From<u64> for EventReply {
    fn from(revision: u64) -> Self {
        Self {
            revision,
            projection: None,
            clipboard_text: None,
            draft_error: None,
        }
    }
}
/// Accept Edit/Action/Paste/Clipboard synchronously; return the accepted revision and any
/// rich projection in the same reply. A positive edit ACK requires a synchronous
/// durable host-journal commit; never reenter AppKit here. On journal failure,
/// return draft_error plus the current projection to retain a read-only draft
/// without advancing the native accepted revision. Selection/composition replies
/// do not mutate text.
pub type EventHandler = Arc<dyn Fn(NativeEvent) -> Result<EventReply, String> + Send + Sync>;
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SurfaceState {
    pub surface_id: String,
    pub generation: u64,
    pub revision: u64,
    pub text: String,
    pub selection: TextRange,
    pub composing: bool,
    pub textkit2: bool,
    pub visible: bool,
    pub viewport: Viewport,
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("native-editor")
        .on_window_ready(|window| {
            #[cfg(target_os = "macos")]
            {
                use tauri::Manager;
                let label = window.label().to_owned();
                let app = window.app_handle().clone();
                window.on_window_event(move |event| {
                    if matches!(event, tauri::WindowEvent::Destroyed) {
                        let label = label.clone();
                        let _ = app.run_on_main_thread(move || platform::detach_window(&label));
                    }
                });
            }
            #[cfg(not(target_os = "macos"))]
            let _ = window;
        })
        .build()
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "command", rename_all = "snake_case")]
pub enum SurfaceCommand {
    SetBounds {
        bounds: Bounds,
    },
    SetAppearance {
        appearance: Appearance,
    },
    /// Update UI labels without disturbing composition, selection or caret state.
    SetLocale {
        locale: String,
    },
    ApplyDocument {
        base_revision: u64,
        revision: u64,
        document: RenderDocument,
        selection: TextRange,
    },
    Focus,
    PreparePanel,
    SetVisible {
        visible: bool,
    },
}

fn validate(config: &SurfaceConfig) -> Result<(), String> {
    if config.surface_id.is_empty()
        || config.surface_id.len() > 200
        || config.revision > i64::MAX as u64
    {
        return Err("invalid surface identity/revision".into());
    }
    validate_bounds(&config.bounds)?;
    validate_appearance(&config.appearance)?;
    validate_document(&config.document)?;
    let end = u64::from(config.selection.start) + u64::from(config.selection.length);
    if end > config.document.text.encode_utf16().count() as u64
        || !utf16_boundary(&config.document.text, config.selection.start)
        || !utf16_boundary(&config.document.text, end as u32)
        || !utf16_boundary(&config.document.text, config.viewport.start)
        || !config.viewport.offset.is_finite() || config.viewport.offset.abs() > 10000.0 {
        return Err("invalid initial selection/viewport".into());
    }
    Ok(())
}
fn validate_bounds(b: &Bounds) -> Result<(), String> {
    if [b.x, b.y, b.width, b.height].iter().any(|v| !v.is_finite())
        || b.width < 0.0
        || b.height < 0.0
    {
        return Err("invalid bounds".into());
    }
    Ok(())
}
fn validate_appearance(a: &Appearance) -> Result<(), String> {
    if !a.font_size.is_finite()
        || !(8.0..=96.0).contains(&a.font_size)
        || !a.line_height.is_finite()
        || !(1.0..=3.0).contains(&a.line_height)
        || !(20..=200).contains(&a.max_columns)
        || !a.bottom_inset.is_finite()
        || !(0.0..=2000.0).contains(&a.bottom_inset)
    {
        return Err("invalid appearance".into());
    }
    for c in [&a.foreground, &a.background] {
        if c.len() != 7 || !c.starts_with('#') || !c[1..].bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("invalid color".into());
        }
    }
    Ok(())
}
fn utf16_boundary(text: &str, position: u32) -> bool {
    let mut offset = 0;
    for character in text.chars() {
        if offset == position {
            return true;
        }
        offset += character.len_utf16() as u32;
    }
    offset == position
}
fn validate_document(d: &RenderDocument) -> Result<(), String> {
    let mut boundaries = Vec::with_capacity(d.text.chars().count() + 1);
    let mut offset = 0u32;
    boundaries.push(offset);
    for c in d.text.chars() {
        offset = offset
            .checked_add(c.len_utf16() as u32)
            .ok_or("document too long")?;
        boundaries.push(offset);
    }
    for run in &d.runs {
        let end = run
            .range
            .start
            .checked_add(run.range.length)
            .ok_or("invalid style range")?;
        if run.heading > 6
            || boundaries.binary_search(&run.range.start).is_err()
            || boundaries.binary_search(&end).is_err()
        {
            return Err("invalid style range".into());
        }
    }
    Ok(())
}

pub fn is_supported() -> bool {
    #[cfg(target_os = "macos")]
    {
        platform::is_supported()
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

/// Register a trusted bundled font for this process only. No JS command exposes
/// this API; the host resolves its fixed resource path and expected family.
pub async fn register_font<R: Runtime>(
    window: &WebviewWindow<R>,
    path: std::path::PathBuf,
    expected_family: String,
) -> Result<(), String> {
    if !path.is_absolute() || expected_family.is_empty() {
        return Err("invalid bundled font identity".into());
    }
    #[cfg(target_os = "macos")]
    {
        on_main(window, move || {
            platform::register_font(&path, &expected_family)
        })
        .await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
        Err("native font registration is not supported on this platform".into())
    }
}

/// Compose already registered trusted faces. The first family remains the
/// primary face (Latin); later descriptors supply missing glyphs in order.
fn validate_font_cascade(alias: &str, families: &[String]) -> Result<(), String> {
    if alias.is_empty()
        || !(1..=8).contains(&families.len())
        || families.iter().any(String::is_empty)
    {
        return Err("invalid font cascade".into());
    }
    Ok(())
}

pub async fn register_font_cascade<R: Runtime>(
    window: &WebviewWindow<R>,
    alias: String,
    families: Vec<String>,
) -> Result<(), String> {
    validate_font_cascade(&alias, &families)?;
    #[cfg(target_os = "macos")]
    {
        on_main(window, move || {
            platform::register_font_cascade(&alias, &families)
        })
        .await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
        Err("native font registration is not supported on this platform".into())
    }
}

pub async fn mount<R: Runtime>(
    window: &WebviewWindow<R>,
    config: SurfaceConfig,
    handler: EventHandler,
) -> Result<(), String> {
    validate(&config)?;
    #[cfg(target_os = "macos")]
    {
        let label = window.label().to_owned();
        let (tx, rx) = tokio::sync::oneshot::channel();
        window
            .with_webview(move |webview| {
                // Bounds originate in the WebView viewport, not NSWindow's content
                // view (which can include a title bar/safe-area offset).
                let _ = tx.send(platform::mount(webview.inner(), &label, config, handler));
            })
            .map_err(|e| e.to_string())?;
        rx.await
            .map_err(|_| "native mount callback cancelled".to_owned())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, config, handler);
        Err("native editor is not supported on this platform".into())
    }
}

fn validate_command(command: &SurfaceCommand) -> Result<(), String> {
    match command {
        SurfaceCommand::SetBounds { bounds } => validate_bounds(bounds)?,
        SurfaceCommand::SetAppearance { appearance } => validate_appearance(appearance)?,
        SurfaceCommand::ApplyDocument {
            document,
            revision,
            base_revision,
            selection,
        } => {
            validate_document(document)?;
            if *revision < *base_revision
                || *revision > i64::MAX as u64
                || u64::from(selection.start) + u64::from(selection.length)
                    > document.text.encode_utf16().count() as u64
                || !utf16_boundary(&document.text, selection.start)
                || !utf16_boundary(
                    &document.text,
                    selection.start.saturating_add(selection.length),
                )
            {
                return Err("invalid revision/selection".into());
            }
        }
        _ => {}
    }
    Ok(())
}
pub async fn command<R: Runtime>(
    window: &WebviewWindow<R>,
    surface_id: String,
    generation: u64,
    command: SurfaceCommand,
) -> Result<(), String> {
    command_and_then(window, surface_id, generation, command, || Ok(())).await
}
/// Complete host state reconciliation in the same main-thread turn as the native
/// command. No input can enter between successful ApplyDocument and `complete`.
/// On validation or native command failure, `complete` is never invoked.
pub async fn command_and_then<R: Runtime, T: Send + 'static>(
    window: &WebviewWindow<R>,
    surface_id: String,
    generation: u64,
    command: SurfaceCommand,
    complete: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    validate_command(&command)?;
    #[cfg(target_os = "macos")]
    {
        let label = window.label().to_owned();
        on_main(window, move || {
            complete_command(platform::command(&label, &surface_id, generation, command), complete)
        }).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, surface_id, generation, command, complete);
        Err("native editor is not supported on this platform".into())
    }
}
#[cfg(any(target_os = "macos", test))]
fn complete_command<T>(result: Result<(), String>, complete: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    result?;
    complete()
}
pub async fn inspect<R: Runtime>(
    window: &WebviewWindow<R>,
    surface_id: String,
    generation: u64,
) -> Result<SurfaceState, String> {
    #[cfg(target_os = "macos")]
    {
        let label = window.label().to_owned();
        on_main(window, move || {
            platform::inspect(&label, &surface_id, generation)
        })
        .await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, surface_id, generation);
        Err("native editor is not supported on this platform".into())
    }
}

/// Inspect, admit and render a host transaction in one main-thread turn. Native
/// input cannot observe a core revision whose projection has not been applied.
/// Composition is rejected before `prepare` can mutate the host document.
pub async fn transaction<R: Runtime, T: Send + 'static>(
    window: &WebviewWindow<R>,
    surface_id: String,
    generation: u64,
    prepare: impl FnOnce(&SurfaceState) -> Result<(T, Option<EventReply>), String> + Send + 'static,
) -> Result<T, String> {
    #[cfg(target_os = "macos")]
    {
        let label = window.label().to_owned();
        on_main(window, move || {
            let state = platform::inspect(&label, &surface_id, generation)?;
            if state.composing {
                return Err("composition active".into());
            }
            let (result, reply) = prepare(&state)?;
            if let Some(EventReply {
                revision,
                projection: Some(projection),
                ..
            }) = reply
            {
                validate_document(&projection.document)?;
                let command = SurfaceCommand::ApplyDocument {
                    base_revision: state.revision,
                    revision,
                    document: projection.document,
                    selection: projection.selection,
                };
                validate_command(&command)?;
                platform::command(&label, &surface_id, generation, command)?;
            }
            Ok(result)
        })
        .await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, surface_id, generation, prepare);
        Err("native editor is not supported on this platform".into())
    }
}
pub async fn detach<R: Runtime>(
    window: &WebviewWindow<R>,
    surface_id: String,
    generation: u64,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let label = window.label().to_owned();
        on_main(window, move || {
            platform::detach(&label, &surface_id, generation)
        })
        .await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, surface_id, generation);
        Ok(())
    }
}
#[cfg(target_os = "macos")]
async fn on_main<R: Runtime, T: Send + 'static>(
    window: &WebviewWindow<R>,
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    window
        .run_on_main_thread(move || {
            let _ = tx.send(f());
        })
        .map_err(|e| e.to_string())?;
    rx.await
        .map_err(|_| "native main thread stopped".to_owned())?
}

#[cfg(target_os = "macos")]
mod platform;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn draft_reconciliation_runs_only_after_command_success_before_next_input() {
        let protected = std::cell::Cell::new(true);
        assert!(complete_command(Err("stale native revision".into()), || { protected.set(false); Ok(()) }).is_err());
        assert!(protected.get(), "failed native apply must retain host protection");
        let order = std::cell::RefCell::new(Vec::new());
        let command_result = { order.borrow_mut().push("native applied"); Ok(()) };
        complete_command(command_result, || { order.borrow_mut().push("host reconciled"); protected.set(false); Ok(()) }).unwrap();
        order.borrow_mut().push("next input");
        assert!(!protected.get());
        assert_eq!(*order.borrow(), ["native applied", "host reconciled", "next input"]);
    }

    #[test]
    fn typing_sound_wire_contains_only_surface_identity_and_role() {
        let roles = [TypingSoundRole::Key, TypingSoundRole::Space, TypingSoundRole::Enter, TypingSoundRole::Delete, TypingSoundRole::Modifier, TypingSoundRole::KeyUp, TypingSoundRole::SpaceUp, TypingSoundRole::Stop];
        for (role, name) in roles.into_iter().zip(["key", "space", "enter", "delete", "modifier", "key_up", "space_up", "stop"]) {
            let value = serde_json::to_value(TypingSoundEvent { surface_id: "surface".into(), generation: 9, role }).unwrap();
            assert_eq!(value, serde_json::json!({"surface_id":"surface", "generation":9, "role":name}));
            assert_eq!(serde_json::from_value::<TypingSoundEvent>(value).unwrap().role, role);
        }
        assert!(serde_json::from_value::<TypingSoundRole>(serde_json::json!("text")).is_err());
    }
    #[test]
    fn locale_defaults_for_older_appearance_and_normalizes_regions() {
        let mut value = serde_json::to_value(Appearance::default()).unwrap();
        value.as_object_mut().unwrap().remove("locale");
        assert_eq!(serde_json::from_value::<Appearance>(value).unwrap().locale, "en");
        for (input, expected) in [("zh-CN", "zh"), ("ZH_hant_TW", "zh"), ("ja-JP", "ja"), (" JA_jp ", "ja"), ("en-GB", "en"), ("de", "en"), ("", "en")] {
            assert_eq!(normalize_locale(input), expected);
        }
        let command = SurfaceCommand::SetLocale { locale: "ja-JP".into() };
        assert!(validate_command(&command).is_ok());
        assert_eq!(serde_json::to_value(command).unwrap(), serde_json::json!({"command":"set_locale","locale":"ja-JP"}));
    }
    #[test]
    fn focus_typing_defaults_on_and_preserves_explicit_off() {
        let mut value = serde_json::to_value(Appearance::default()).unwrap();
        assert_eq!(value["focus_typing"], true);
        value.as_object_mut().unwrap().remove("focus_typing");
        assert!(serde_json::from_value::<Appearance>(value.clone()).unwrap().focus_typing);
        value["focusTyping"] = serde_json::json!(false);
        let disabled = serde_json::from_value::<Appearance>(value.clone()).unwrap();
        assert!(!disabled.focus_typing);
        assert_eq!(serde_json::to_value(disabled).unwrap()["focus_typing"], false);
        value["focusTyping"] = serde_json::json!("false");
        assert!(serde_json::from_value::<Appearance>(value).is_err());
    }
    #[test]
    fn caret_motion_defaults_and_accepts_only_supported_modes() {
        let mut value = serde_json::to_value(Appearance::default()).unwrap();
        value.as_object_mut().unwrap().remove("caret_motion");
        assert_eq!(
            serde_json::from_value::<Appearance>(value.clone()).unwrap().caret_motion,
            CaretMotion::Breathing
        );
        value["caretMotion"] = serde_json::json!("steady");
        assert_eq!(
            serde_json::from_value::<Appearance>(value.clone()).unwrap().caret_motion,
            CaretMotion::Steady
        );
        value["caretMotion"] = serde_json::json!("blink");
        assert!(serde_json::from_value::<Appearance>(value).is_err());
        assert_eq!(serde_json::to_value(CaretMotion::Breathing).unwrap(), "breathing");
    }
    #[test]
    fn single_face_presets_are_valid_but_empty_cascades_are_not() {
        assert!(validate_font_cascade("Sumi WenKai", &["LXGWWenKaiMonoLite-Regular".into()]).is_ok());
        assert!(validate_font_cascade("Sumi WenKai", &[]).is_err());
        assert!(validate_font_cascade("Sumi WenKai", &[String::new()]).is_err());
        assert!(validate_font_cascade("", &["Font".into()]).is_err());
        assert!(validate_font_cascade("Too many", &vec!["Font".into(); 9]).is_err());
    }
    #[test]
    fn reject_invalid_geometry_and_attributes() {
        assert!(validate_bounds(&Bounds {
            x: f64::NAN,
            y: 0.,
            width: 100.,
            height: 100.
        })
        .is_err());
        let mut a = Appearance::default();
        a.foreground = "red".into();
        assert!(validate_appearance(&a).is_err());
        let doc = RenderDocument {
            text: "😀".into(),
            runs: vec![StyleRun {
                range: TextRange {
                    start: 0,
                    length: 3,
                },
                bold: true,
                italic: false,
                strike: false,
                heading: 0,
                quote: false,
                link: None,
            }],
        };
        assert!(validate_document(&doc).is_err());
    }
}

/// Main-thread native menu dispatch. Only the actual key-window Sumi responder
/// can consume this command; other text fields retain AppKit behavior.
pub fn menu_command(command: &str) -> bool {
    #[cfg(target_os = "macos")]
    { platform::menu_command(command) }
    #[cfg(not(target_os = "macos"))]
    { let _ = command; false }
}
