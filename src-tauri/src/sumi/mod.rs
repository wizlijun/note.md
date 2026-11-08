//! Host-owned Sumi sessions. Native surfaces never own files or network credentials.
pub mod coordinator;
pub mod credentials;
mod auth;
pub mod durability;
mod export;
mod external;
mod fonts;
mod service;
mod sound;
mod paste;
pub mod recovery;
pub mod sync;

use durability::{Durability, DurableEvent, LocalEdit};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU8, AtomicU64, Ordering},
        Arc, LazyLock, Mutex, OnceLock,
    },
};
use tauri::{Emitter, Manager, Runtime, WebviewWindow};
use tauri_plugin_native_editor as native;
use uuid::Uuid;
use write_core::{catalog::Entry, render::SourceMap, storage, Document};

type Result<T> = std::result::Result<T, String>;
const PLUGIN: &str = "notemd.sumi";
// A hidden singleton WebView remains alive. Fence new native mounts from the
// moment closing starts until the explicit plugin-window show path reopens it.
static PLUGIN_QUIESCING: AtomicBool = AtomicBool::new(false);
static PLUGIN_WINDOW_HIDDEN: AtomicBool = AtomicBool::new(false);
fn is_plugin_window(label: &str) -> bool {
    label == crate::plugin_runtime::windows::window_label(PLUGIN, "main")
}
fn require_visible_native_window<R: Runtime>(window: &WebviewWindow<R>) -> Result<()> {
    if is_plugin_window(window.label()) && (PLUGIN_WINDOW_HIDDEN.load(Ordering::Acquire) || !window.is_visible().map_err(err)?) {
        return Err("Sumi 窗口已关闭，请重新打开后继续书写".into());
    }
    Ok(())
}
/// Called only after the explicit singleton open/show path, not ordinary focus
/// events that may have been queued before closing.
pub fn plugin_window_shown<R: Runtime>(app: &tauri::AppHandle<R>, label: &str) {
    if !is_plugin_window(label) || !app.get_webview_window(label).is_some_and(|w|w.is_visible().unwrap_or(false)) {return;}
    PLUGIN_WINDOW_HIDDEN.store(false, Ordering::Release);
    push(app, &json!({"type":"sumi-window-state","visible":true}));
}
static WORKSPACES: LazyLock<tokio::sync::Mutex<HashMap<PathBuf, Arc<Workspace>>>> =
    LazyLock::new(Default::default);
// Explicit UI changes win over the asynchronously persisted settings file.
static UI_LOCALE: Mutex<Option<String>> = Mutex::new(None);
static FONT_MANAGERS: LazyLock<Mutex<HashMap<PathBuf, fonts::Manager>>> =
    LazyLock::new(Default::default);

fn font_manager<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<fonts::Manager> {
    let directory = app.path().app_local_data_dir().map_err(err)?.join("sumi/fonts/v1");
    Ok(FONT_MANAGERS.lock().map_err(err)?.entry(directory.clone())
        .or_insert_with(|| fonts::Manager::new(directory, service::connector(app))).clone())
}
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn client() -> u64 {
    Uuid::new_v4().as_u128() as u32 as u64
}
fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
fn date() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Preferences {
    theme: String,
    font_family: String,
    font_size: f64,
    line_height: f64,
    max_columns: u32,
    bottom_inset: f64,
    #[serde(default = "default_caret_motion")]
    caret_motion: String,
}
fn default_caret_motion() -> String {
    "breathing".into()
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            theme: "dim".into(),
            font_family: "Sumi Plex".into(),
            font_size: 22.,
            line_height: 1.6,
            max_columns: 80,
            bottom_inset: 0.,
            caret_motion: default_caret_motion(),
        }
    }
}
impl Preferences {
    fn normalize_stored_font(&mut self) -> bool {
        if !fonts::known_font(&self.font_family) {
            self.font_family = "Sumi Plex".into();
            true
        } else {
            false
        }
    }
    fn validate(&self) -> Result<()> {
        if !matches!(self.theme.as_str(), "ink" | "dim" | "paper" | "sepia" | "crt" | "crt-blue")
            || !fonts::known_font(&self.font_family)
            || !matches!(self.caret_motion.as_str(), "breathing" | "steady")
            || !self.font_size.is_finite()
            || !(8. ..=96.).contains(&self.font_size)
            || !self.line_height.is_finite()
            || !(1. ..=3.).contains(&self.line_height)
            || !(20..=200).contains(&self.max_columns)
            || !self.bottom_inset.is_finite()
            || !(0. ..=2000.).contains(&self.bottom_inset)
        {
            return Err("无效的写作外观设置".into());
        }
        Ok(())
    }
    fn appearance(&self) -> native::Appearance {
        let (foreground, background) = match self.theme.as_str() {
            "paper" => ("#111111", "#ffffff"),
            "sepia" => ("#44413c", "#f3ead7"),
            "crt" => ("#0ccc68", "#000000"),
            "crt-blue" => ("#7fb4ff", "#000000"),
            "ink" => ("#ffffff", "#000000"),
            _ => ("#b8b8b8", "#111111"),
        };
        native::Appearance {
            font_family: self.font_family.clone(),
            font_size: self.font_size,
            line_height: self.line_height,
            max_columns: self.max_columns,
            bottom_inset: self.bottom_inset,
            locale: "en".into(), // Runtime UI language is injected by ensure_font.
            foreground: foreground.into(),
            background: background.into(),
            caret_motion: match self.caret_motion.as_str() {
                "steady" => native::CaretMotion::Steady,
                _ => native::CaretMotion::Breathing,
            },
        }
    }
}
#[derive(Clone, Serialize)]
pub struct Opened {
    page_id: String,
    raw: String,
    revision: u64,
    projected: bool,
    projection_identity: Option<durability::ProjectionIdentity>,
}
#[derive(Clone, Serialize)]
#[serde(untagged)]
pub enum EditorEntry<T> {
    Opened(T),
    Existing { kind: &'static str, page_id: String },
}
fn existing_editor<T>(page: &str) -> EditorEntry<T> {
    EditorEntry::Existing {kind:"existing_owner",page_id:page.into()}
}
#[derive(Clone, Serialize, PartialEq, Eq)]
pub struct Surface {
    surface_id: String,
    generation: u64,
}
#[derive(Clone)]
struct Owner {
    window: String,
    tab: String,
    surface: Option<Surface>,
    composing: bool,
    selection: native::TextRange,
    viewport: native::Viewport,
    suspended: bool,
    generation: u64,
    source_baseline: Option<u64>,
    typing_style: Option<write_core::render::TypingStyle>,
}
#[derive(Clone)]
struct ClipboardDraft {
    text: String,
    html: Option<String>,
    rtf: Option<String>,
    anchor: write_core::SelectionAnchor,
}
#[derive(Default)]
struct BackgroundCandidate {
    session: Option<write_core::CandidateSession>,
    pending_op: Option<String>,
}
struct RemoteCandidate {
    background: Arc<Mutex<BackgroundCandidate>>,
    base: Arc<AtomicU64>,
    journal: VecDeque<(u64, Vec<u8>)>,
    journal_bytes: usize,
    acknowledgements: Vec<write_core::CandidateCommit>,
    pending_commits: HashMap<String, u64>,
}
impl Default for RemoteCandidate {
    fn default() -> Self {
        Self {
            background: Arc::new(Mutex::new(BackgroundCandidate::default())),
            base: Arc::new(AtomicU64::new(u64::MAX)),
            journal: VecDeque::new(),
            journal_bytes: 0,
            acknowledgements: Vec::new(),
            pending_commits: HashMap::new(),
        }
    }
}
impl RemoteCandidate {
    fn record(&mut self, revision: u64, update: &[u8]) {
        self.journal_bytes += update.len();
        self.journal.push_back((revision, update.to_vec()));
        while self.journal.len() > 2048 || self.journal_bytes > 8 * 1024 * 1024 {
            if let Some((_, old)) = self.journal.pop_front() {
                self.journal_bytes -= old.len();
            }
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
struct ReadingPosition {
    selection: Vec<u8>,
    viewport: Vec<u8>,
    offset: f64,
}
#[derive(Clone)]
struct CleanupSnapshot {
    window: String,
    tab: String,
    surface: Option<Surface>,
    owner_generation: u64,
    snapshot: Opened,
}
struct Paper {
    cleanup_snapshot: Option<CleanupSnapshot>,
    projection_identity: Option<durability::ProjectionIdentity>,
    remote: RemoteCandidate,
    pending_clipboard: Option<ClipboardDraft>,
    pending_link: Option<write_core::SelectionAnchor>,
    position: Option<ReadingPosition>,
    position_dirty: bool,
    position_resolved: bool,
    position_serial: u64,
    doc: Document,
    view: SourceMap,
    entry: Entry,
    owner: Option<Owner>,
    baselines: HashMap<u64, Vec<u8>>,
    raw: String,
    durable_revision: u64,
    error: Option<String>,
    projection_error: Option<String>,
}
impl Paper {
    fn from_loaded(loaded: durability::Loaded) -> Result<Self> {
        let doc = Document::restore(
            &loaded.entry.id,
            loaded.entry.epoch,
            client(),
            &loaded.full_state,
            loaded.revision,
        )
        .map_err(err)?;
        let view = SourceMap::new(&doc.body(), doc.revision());
        let mut baselines = HashMap::new();
        baselines.insert(doc.revision(), loaded.full_state);
        Ok(Self {
            cleanup_snapshot: None,
            projection_identity: None,
            remote: RemoteCandidate::default(),
            pending_clipboard: None,
            pending_link: None,
            position: None,
            position_dirty: false,
            position_resolved: true,
            position_serial: 0,
            doc,
            view,
            entry: loaded.entry,
            owner: None,
            baselines,
            raw: loaded.raw_markdown,
            durable_revision: loaded.revision,
            error: None,
            projection_error: None,
        })
    }
    fn opened(&mut self) -> Opened {
        let revision = self.doc.revision();
        let pinned = self
            .owner
            .as_mut()
            .map(|o| *o.source_baseline.get_or_insert(revision));
        self.baselines
            .retain(|r, _| Some(*r) == pinned || *r == revision);
        self.baselines.insert(revision, self.doc.encode_full());
        Opened {
            page_id: self.entry.id.clone(),
            raw: self.raw.clone(),
            revision,
            projected: self.error.is_none() && self.projection_error.is_none(),
            projection_identity: self.projection_identity.clone(),
        }
    }
}
const ACTIVE: u8 = 0;
const QUIESCING: u8 = 1;
const QUIESCED: u8 = 2;
pub(super) struct Workspace {
    phase: AtomicU8,
    root: PathBuf,
    selected_root: PathBuf,
    durable: Durability,
    sound_backend: Option<service::Backend>,
    sound: sound::Controller,
    papers: Mutex<HashMap<String, Paper>>,
    preferences: Mutex<Preferences>,
    appearance_changes: tokio::sync::Mutex<()>,
    font_selection: Mutex<FontSelection>,
    active: Mutex<Option<String>>,
    navigation_version: AtomicU64,
    position_writes: tokio::sync::Mutex<()>,
    lifecycle: tokio::sync::Mutex<()>,
    network: OnceLock<coordinator::Handle>,
    pending_directory: Mutex<Option<Vec<Entry>>>,
}

impl Workspace {
    fn writable(&self) -> Result<()> {
        if self.phase.load(Ordering::Acquire) != ACTIVE {
            return Err("Sumi 正在停用或交接，草稿已保留".into());
        }
        Ok(())
    }
}

#[derive(Default)]
struct FontSelection {
    generation: u64,
    pending: Option<String>,
}

fn authorize(plugin: &str) -> Result<()> {
    if plugin != PLUGIN {
        return Err("CAPABILITY_DENIED: Sumi identity required".into());
    }
    let state = crate::plugin_runtime::STATE
        .read()
        .map_err(|_| "插件状态不可用")?;
    let (manifest, _) = state.plugins.get(plugin).ok_or("Sumi 插件未启用")?;
    for cap in ["editor.native", "editor.write", "vault.read", "vault.write"] {
        if !manifest.capabilities.iter().any(|c| c == cap) {
            return Err(format!("CAPABILITY_DENIED: {cap}"));
        }
    }
    Ok(())
}
fn root<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf> {
    crate::sotvault::resolve_vault_root(app)
        .ok_or("请先打开 Vault")?
        .canonicalize()
        .map_err(err)
}
fn current<R: Runtime>(app: &tauri::AppHandle<R>, ws: &Workspace) -> Result<()> {
    ws.writable()?;
    authorize(PLUGIN)?;
    if root(app)? != ws.root {
        return Err("Vault 已切换，旧编辑会话已停止".into());
    }
    Ok(())
}
// The GUI's selected-root identity is cached in memory. Do not stat/canonicalize
// a filesystem path on every native keystroke.
fn current_native<R: Runtime>(app: &tauri::AppHandle<R>, ws: &Workspace) -> Result<()> {
    ws.writable()?;
    authorize(PLUGIN)?;
    let manager = app
        .try_state::<Arc<crate::vault_sync::VaultSyncManager>>()
        .ok_or("Vault 状态尚未就绪")?;
    let selected = manager.repo_path.lock().map_err(err)?;
    if selected.as_ref().map(PathBuf::from).as_ref() != Some(&ws.selected_root) {
        return Err("Vault 已切换，旧编辑会话已停止".into());
    }
    Ok(())
}
async fn owned_workspace<R: Runtime>(
    window: &WebviewWindow<R>,
    plugin: &str,
    page: &str,
    tab: &str,
) -> Result<Arc<Workspace>> {
    host_window(window)?;
    if plugin != PLUGIN {
        return Err("CAPABILITY_DENIED".into());
    }
    let workspaces = WORKSPACES
        .lock()
        .await
        .values()
        .cloned()
        .collect::<Vec<_>>();
    for ws in workspaces {
        let matches = ws
            .papers
            .lock()
            .map_err(err)?
            .get(page)
            .and_then(|p| p.owner.as_ref())
            .is_some_and(|o| o.window == window.label() && o.tab == tab);
        if matches {
            return Ok(ws);
        }
    }
    Err("写作会话已关闭".into())
}
fn host_window<R: Runtime>(window: &WebviewWindow<R>) -> Result<()> {
    if window.label() != "main" {
        return Err("CAPABILITY_DENIED: main editor window required".into());
    }
    Ok(())
}
fn push<R: Runtime>(app: &tauri::AppHandle<R>, payload: &Value) {
    crate::plugin_runtime::windows::push_to_window(app, PLUGIN, "main", payload);
}

async fn workspace<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<Arc<Workspace>> {
    authorize(PLUGIN)?;
    let selected_root = crate::sotvault::resolve_vault_root(app).ok_or("请先打开 Vault")?;
    let root = root(app)?;
    let mut all = WORKSPACES.lock().await;
    if let Some(ws) = all.get(&root) {
        ws.writable()?;
        return Ok(ws.clone());
    }
    if PLUGIN_QUIESCING.load(Ordering::Acquire) { return Err("Sumi 正在停止，不能创建新会话".into()); }
    let database = app
        .path()
        .app_data_dir()
        .map_err(err)?
        .join("sumi")
        .join(storage::sha256(root.to_string_lossy().as_bytes()))
        .join("documents.sqlite3");
    let event_app = app.clone();
    let event_root = root.clone();
    let backend = service::Backend::open(app, root.clone(), database).await?;
    let durable = Durability::from_backend(backend.clone(), move |event| {
        let app = event_app.clone();
        let root = event_root.clone();
        tauri::async_runtime::spawn(async move {
            durable_event(&app, &root, event).await;
        });
    });
    let preferences = load_preferences(&durable).await?;
    let active = durable
        .preferences("activePage".into())
        .await?
        .and_then(|v| v.as_str().map(str::to_owned));
    let ws = Arc::new(Workspace {
        phase: AtomicU8::new(ACTIVE),
        root: root.clone(),
        selected_root,
        durable,
        sound_backend: Some(backend.clone()),
        sound: sound::Controller::default(),
        papers: Mutex::new(HashMap::new()),
        preferences: Mutex::new(preferences),
        appearance_changes: tokio::sync::Mutex::new(()),
        font_selection: Mutex::new(FontSelection::default()),
        active: Mutex::new(active),
        navigation_version: AtomicU64::new(1),
        position_writes: tokio::sync::Mutex::new(()),
        lifecycle: tokio::sync::Mutex::new(()),
        network: OnceLock::new(),
        pending_directory: Mutex::new(None),
    });
    all.insert(root, ws.clone());
    drop(all);
    let _ = ws.network.set(coordinator::start(backend));
    let weak = Arc::downgrade(&ws);
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            let Some(ws) = weak.upgrade() else { break; };
            if ws.phase.load(Ordering::Acquire) == ACTIVE { let _ = flush_positions(&ws, None).await; }
        }
    });
    Ok(ws)
}
/// Only called by the authenticated native plugin process, never the UI bridge.
async fn background_request<R: Runtime>(app: &tauri::AppHandle<R>, root: &PathBuf, method: &str, params: Value) -> Result<Value> {
    let ws=WORKSPACES.lock().await.get(root).cloned().ok_or("Sumi会话已关闭")?;
    if method == "durable" {
        ws.durable.notify(serde_json::from_value(params).map_err(err)?);
        return Ok(Value::Null);
    }
    current(app,&ws)?;
    if params.get("root").and_then(Value::as_str) != Some(root.to_string_lossy().as_ref()) {
        return Err("Sumi后台工作区绑定不一致".into());
    }
    let profile=storage::sha256(root.to_string_lossy().as_bytes());
    let result=match method {
        "current" => json!({"current":true}),
        "editor_state" => {
            let active=ws.active.lock().map_err(err)?.clone();
            let papers=ws.papers.lock().map_err(err)?;
            let owned=papers.iter().filter_map(|(id,p)|p.owner.as_ref().map(|o|json!({"pageId":id,"hasSurface":o.surface.is_some()}))).collect::<Vec<_>>();
            let vectors=papers.iter().map(|(id,p)|json!({"pageId":id,"stateVector":p.doc.state_vector()})).collect::<Vec<_>>();
            json!({"active":active,"owned":owned,"vectors":vectors})
        },
        "directory" => {directory_changed(app,&ws,serde_json::from_value(params["entries"].clone()).map_err(err)?).await?;Value::Null},
        "remote" => {
            let update=serde_json::from_value(params["update"].clone()).map_err(err)?;
            let generation=params["generation"].as_u64().ok_or("无效的Sumi远端版本")?;
            integrate_remote(app,&ws,update,generation).await?;Value::Null
        },
        "status" => {
            if let Some(handle)=ws.network.get() {
                if handle.set_status(params["status"].clone()) {
                    let state=state_value(&ws).await?;
                    current(app,&ws)?;
                    push(app,&json!({"type":"sumi-state","state":state}));
                }
            }
            Value::Null
        },
        "auth_load" => serde_json::to_value(auth::load_identity(&profile).await?).map_err(err)?,
        "auth_pair" => {
            let server=params["server"].as_str().ok_or("缺少Sumi服务地址")?;
            let invitation=serde_json::from_value(params["invitation"].clone()).map_err(err)?;
            serde_json::to_value(auth::pair(&profile,server,invitation).await?).map_err(err)?
        },
        "auth_token" => serde_json::to_value(auth::token(&profile,serde_json::from_value(params["identity"].clone()).map_err(err)?).await?).map_err(err)?,
        _ => return Err("未知的Sumi后台回调".into()),
    };
    current(app,&ws)?;
    Ok(result)
}
async fn durable_event<R: Runtime>(app: &tauri::AppHandle<R>, root: &PathBuf, event: DurableEvent) {
    let ws = WORKSPACES.lock().await.get(root).cloned();
    let Some(ws) = ws else { return };
    let refresh_state = !matches!(&event, DurableEvent::Committed { .. });
    let (payload, target) = {
        let Ok(mut papers) = ws.papers.lock() else {
            return;
        };
        let page = match &event {
            DurableEvent::Saved { page_id, .. }
            | DurableEvent::Failed { page_id, .. }
            | DurableEvent::Committed { page_id, .. } => page_id,
        };
        let target = papers
            .get(page)
            .and_then(|p| p.owner.as_ref())
            .map(|o| o.window.clone());
        let payload = match event {
            DurableEvent::Committed { page_id, revision } => {
                let mut tab = None;
                if let Some(p) = papers.get_mut(&page_id) {
                    p.durable_revision = p.durable_revision.max(revision);
                    if revision >= p.doc.revision() && !p.entry.deleted && !p.owner.as_ref().is_some_and(|o| o.suspended) { p.error = None; }
                    tab = p.owner.as_ref().map(|o| o.tab.clone());
                }
                json!({"page_id":page_id,"tab_id":tab,"revision":revision,"durable":true})
            }
            DurableEvent::Saved {
                page_id,
                revision,
                projected,
                projection_error,
                projection_identity,
                raw_markdown,
            } => {
                let mut tab = None;
                if let Some(p) = papers.get_mut(&page_id) {
                    if revision >= p.durable_revision {
                        p.durable_revision = revision;
                        p.raw = raw_markdown.clone();
                        p.projection_error = projection_error.clone();
                        if revision >= p.doc.revision() && !p.entry.deleted && !p.owner.as_ref().is_some_and(|o| o.suspended) { p.error = None; }
                        p.projection_identity = projection_identity.clone();
                    }
                    tab = p.owner.as_ref().map(|o| o.tab.clone());
                }
                json!({"page_id":page_id,"tab_id":tab,"revision":revision,"raw":raw_markdown,"durable":true,"projected":projected,"projection_identity":projection_identity,"error":projection_error})
            }
            DurableEvent::Failed {
                page_id,
                revision,
                error,
            } => {
                let mut tab = None;
                let mut durable = false;
                if let Some(p) = papers.get_mut(&page_id) {
                    durable = revision <= p.durable_revision;
                    if durable { p.projection_error = Some(error.clone()); }
                    else { p.error = Some(error.clone()); }
                    tab = p.owner.as_ref().map(|o| o.tab.clone());
                }
                json!({"page_id":page_id,"tab_id":tab,"revision":revision,"durable":durable,"projected":false,"error":error})
            }
        };
        (payload, target)
    };
    if let Some(target) = target {
        let _ = app.emit_to(target, "sumi-state", payload);
    }
    if refresh_state && current(app, &ws).is_ok() {
        if let Ok(state) = state_value(&ws).await {
            push(app, &json!({"type":"sumi-state","state":state}));
        }
    }
}
/// Must run outside lifecycle: a first remote snapshot enters through
/// integrate_remote, which acquires that same gate before installing state.
async fn prepare_page(ws: &Workspace, id: &str) -> Result<()> {
    let known = ws.papers.lock().map_err(err)?.contains_key(id);
    if known || ws.durable.load(id.into()).await.is_ok() { return Ok(()); }
    ws.network.get().ok_or("此页尚未下载，请先连接同步服务")?.prepare_page(id.into()).await
}
async fn ensure(ws: &Workspace, id: &str) -> Result<()> {
    if ws.papers.lock().map_err(err)?.contains_key(id) {
        return Ok(());
    }
    let loaded = ws.durable.load(id.into()).await?;
    ws.papers
        .lock()
        .map_err(err)?
        .entry(id.into())
        .or_insert(Paper::from_loaded(loaded)?);
    Ok(())
}
fn reading_position(p: &Paper) -> Result<Option<ReadingPosition>> {
    let Some(owner) = p.owner.as_ref().filter(|o| !o.composing) else { return Ok(None); };
    let selection_range = bounded_selection(&p.view.document.text,owner.selection.clone());
    let viewport_range = bounded_selection(&p.view.document.text,native::TextRange { start: owner.viewport.start, length: 0 });
    let selection = p.view.anchor_selection(&p.doc, &write_core::render::TextRange { start: selection_range.start, length: selection_range.length }).map_err(err)?;
    let viewport = p.view.anchor_selection(&p.doc, &write_core::render::TextRange { start: viewport_range.start, length: 0 }).map_err(err)?;
    Ok(Some(ReadingPosition { selection: p.doc.serialize_selection(&selection).map_err(err)?, viewport: p.doc.serialize_selection(&viewport).map_err(err)?, offset: owner.viewport.offset }))
}
fn resolve_reading_position(p: &Paper) -> Result<(native::TextRange, native::Viewport)> {
    let resolved = (|| -> Result<_> {
        let position = p.position.as_ref().ok_or("no saved reading position")?;
        if !position.offset.is_finite() || position.offset.abs() > 10000. { return Err("invalid reading offset".into()); }
        let selection = p.doc.deserialize_selection(&position.selection).map_err(err)?;
        let viewport = p.doc.deserialize_selection(&position.viewport).map_err(err)?;
        let selection = p.view.resolve_selection(&p.doc, &selection).map_err(err)?;
        let viewport = p.view.resolve_selection(&p.doc, &viewport).map_err(err)?;
        Ok((native::TextRange { start: selection.start, length: selection.length },native::Viewport { start: viewport.start, offset: position.offset }))
    })();
    // Keep unresolved encoded anchors: a delayed remote dependency can make
    // them resolvable later. Never reinterpret another page's offsets.
    resolved
}
async fn load_position(ws: &Workspace, page: &str) -> Result<()> {
    if ws.papers.lock().map_err(err)?.get(page).is_some_and(|p| p.position.is_some()) { return Ok(()); }
    let value = ws.durable.preferences(format!("readingPosition:{page}")).await?;
    let position = value.and_then(|v| serde_json::from_value::<ReadingPosition>(v).ok())
        .filter(|p| p.selection.len() <= 1024 && p.viewport.len() <= 1024);
    if let Some(p) = ws.papers.lock().map_err(err)?.get_mut(page) { p.position = position; }
    Ok(())
}
async fn flush_positions(ws: &Workspace, only: Option<&str>) -> Result<()> {
    // Serialize background and forced flushes so an older multi-page batch can
    // never overwrite a newer close/selection checkpoint.
    let _writer = ws.position_writes.lock().await;
    if ws.phase.load(Ordering::Acquire) == QUIESCED { return Ok(()); }
    let pending = {
        let papers = ws.papers.lock().map_err(err)?;
        let mut pending = Vec::new();
        for (id,p) in papers.iter().filter(|(id,p)| p.position_dirty && only.is_none_or(|target| target == id.as_str())) {
            if let Some(position) = reading_position(p)? { pending.push((id.clone(),p.position_serial,position)); }
        }
        pending
    };
    for (id,serial,position) in pending {
        if let Err(error) = ws.durable.set_preferences(format!("readingPosition:{id}"),serde_json::to_value(&position).map_err(err)?).await {
            if let Some(p) = ws.papers.lock().map_err(err)?.get_mut(&id) { if p.error.is_none() { p.error = Some(format!("阅读位置尚未保存：{error}")); } }
            return Err(error);
        }
        if let Some(p) = ws.papers.lock().map_err(err)?.get_mut(&id) {
            if p.error.as_ref().is_some_and(|e|e.starts_with("阅读位置尚未保存：")) { p.error = None; }
            p.position = Some(position);
            if p.position_serial == serial { p.position_dirty = false; }
        }
    }
    Ok(())
}
fn position_changed(p: &mut Paper) {
    p.position_dirty = true;
    p.position_resolved = true;
    p.position_serial = p.position_serial.saturating_add(1);
}
async fn capture_native_position<R: Runtime>(window: &WebviewWindow<R>, ws: &Workspace, page: &str, tab: &str, surface: &str, generation: u64) -> Result<()> {
    let snapshot = native::inspect(window, surface.into(), generation).await?;
    if snapshot.composing { return Err("composition active".into()); }
    let mut papers = ws.papers.lock().map_err(err)?;
    let p = papers.get_mut(page).ok_or("missing page")?;
    if snapshot.revision != p.doc.revision() { return Err("position revision changed".into()); }
    let o = owner(p,window.label(),tab,Some((surface,generation)))?;
    o.selection = snapshot.selection;
    o.viewport = snapshot.viewport;
    if p.position_resolved || p.position_dirty { position_changed(p); }
    Ok(())
}

async fn state_value(ws: &Workspace) -> Result<Value> {
    let entries = ws.durable.list().await?;
    let excerpts = ws.durable.excerpts().await?;
    let pending = ws.durable.outbox_count().await?;
    let papers = ws.papers.lock().map_err(err)?;
    let pages:Vec<_>=entries.iter().map(|e|json!({"id":e.id,"deleted":e.deleted,"excerpt":papers.get(&e.id).map(|p|p.view.document.text.chars().take(80).collect::<String>()).unwrap_or_else(|| excerpts.get(&e.id).map(|text| text.chars().take(80).collect()).unwrap_or_default())})).collect();
    let mut sync = ws
        .network
        .get()
        .map(|h| h.status())
        .unwrap_or_else(|| json!({"connected":false,"message":"本机写作"}));
    sync["pending"] = json!(pending);
    let save = if papers.values().any(|p| p.error.is_some()) {
        "error"
    } else if papers
        .values()
        .any(|p| p.durable_revision < p.doc.revision())
    {
        "saving"
    } else if papers.values().any(|p| p.projection_error.is_some()) {
        "projection-pending"
    } else {
        "saved"
    };
    let active = ws.active.lock().map_err(err)?;
    let navigation_version = ws.navigation_version.load(Ordering::Acquire);
    Ok(
        json!({"available":native::is_supported(),"reason":if native::is_supported(){""}else{"Sumi 原生编辑需要 macOS 13 或更新版本"},"pages":pages,"activePageId":*active,"navigationVersion":navigation_version,"preferences":*ws.preferences.lock().map_err(err)?,"sync":sync,"saveState":save}),
    )
}
async fn activate_page(ws: &Workspace, id: &str) -> Result<()> {
    ws.durable.set_preferences("activePage".into(), json!(id)).await?;
    let mut active = ws.active.lock().map_err(err)?;
    if active.as_deref() != Some(id) {
        let previous = active.replace(id.into());
        ws.navigation_version.fetch_add(1, Ordering::Release);
        drop(active);
        let mut papers = ws.papers.lock().map_err(err)?;
        for page in previous.as_deref().into_iter().chain(std::iter::once(id)) {
            if let Some(owner) = papers.get_mut(page).and_then(|p| p.owner.as_mut()) { owner.typing_style = None; }
        }
    }
    Ok(())
}
fn adjacent_after_delete(entries: &[Entry], removed: &str) -> Option<String> {
    let index = entries.iter().position(|entry| entry.id == removed)?;
    entries[index+1..].iter().chain(entries[..index].iter().rev())
        .find(|entry| !entry.deleted && entry.id != removed).map(|entry| entry.id.clone())
}
fn creation_marker(request_id: &str, after: &Option<String>, kind: &str) -> Value {
    json!({"request_id":request_id,"after_id":after,"kind":kind,"owner":PLUGIN})
}
async fn existing_creation(ws: &Workspace, request_id: &str, after: &Option<String>, kind: &str) -> Result<Option<durability::Loaded>> {
    let id=Uuid::parse_str(request_id).map_err(|_|"无效的新纸页操作标识")?.to_string();
    if !ws.durable.list().await?.iter().any(|entry|entry.id==id) { return Ok(None); }
    let loaded=ws.durable.load(id.clone()).await?;
    let marker=loaded.frontmatter.get(serde_yaml::Value::String("sumi_creation".into())).and_then(|value|serde_json::to_value(value).ok());
    if marker != Some(creation_marker(&id,after,kind)) { return Err("新纸页操作标识已属于另一页；不会复用或覆盖其内容".into()); }
    if loaded.entry.deleted { return Err("这次新建已完成，但纸页已在废纸篓；请从废纸篓恢复".into()); }
    Ok(Some(loaded))
}
async fn create_paper_durable(ws: &Workspace, request_id: &str, after: Option<String>, kind: &str, author: String) -> Result<String> {
    let id=Uuid::parse_str(request_id).map_err(|_|"无效的新纸页操作标识")?.to_string();
    let loaded = if let Some(loaded)=existing_creation(ws,&id,&after,kind).await? { loaded }
    else {
        let doc=Document::new(&id,1,client()).map_err(err)?;
        let mut header=serde_yaml::Mapping::new();header.insert("author".into(),author.into());
        header.insert("sumi_creation".into(),serde_yaml::to_value(creation_marker(&id,&after,kind)).map_err(err)?);
        ws.durable.create(durability::Create { page_id:id.clone(),epoch:1,full_state:doc.encode_full(),revision:0,after_id:after,first_write_date:None,frontmatter:Some(header),preserved_pair:None }).await?
    };
    ws.papers.lock().map_err(err)?.entry(id.clone()).or_insert(Paper::from_loaded(loaded)?);
    Ok(id)
}
async fn create_paper<R: Runtime>(app: &tauri::AppHandle<R>, ws: &Workspace, request_id: &str, after: Option<String>, kind: &str) -> Result<String> {
    if !native::is_supported() { return Err("当前系统不支持 Sumi 原生编辑".into()); }
    current(app,ws)?;
    let id=create_paper_durable(ws,request_id,after,kind,crate::okf::human_actor_for_vault(Some(&ws.root))).await?;
    current(app,ws)?;
    Ok(id)
}
fn native_document(map: &SourceMap) -> native::RenderDocument {
    native::RenderDocument {
        text: map.document.text.clone(),
        runs: map
            .document
            .runs
            .iter()
            .map(|r| native::StyleRun {
                range: native::TextRange {
                    start: r.range.start,
                    length: r.range.length,
                },
                bold: r.bold,
                italic: r.italic,
                strike: r.strike,
                heading: r.heading,
                quote: r.quote,
                link: r.link.clone(),
            })
            .collect(),
    }
}
fn owner<'a>(
    p: &'a mut Paper,
    window: &str,
    tab: &str,
    surface: Option<(&str, u64)>,
) -> Result<&'a mut Owner> {
    let o = p.owner.as_mut().ok_or("写作会话已关闭")?;
    if o.window != window || o.tab != tab {
        return Err("此页正在另一个编辑面中使用".into());
    }
    if let Some((id, generation)) = surface {
        if !o
            .surface
            .as_ref()
            .is_some_and(|s| s.surface_id == id && s.generation == generation)
        {
            return Err("原生编辑面已过期".into());
        }
    }
    Ok(o)
}
#[cfg(test)]
fn queue(ws: &Workspace, p: &mut Paper, update: Vec<u8>) -> Result<()> {
    queue_reserved(p, update, ws.durable.try_reserve_edit()?)
}
fn queue_reserved(p: &mut Paper, update: Vec<u8>, permit: durability::Permit) -> Result<()> {
    p.cleanup_snapshot = None;
    p.remote.record(p.doc.revision(), &update);
    permit.enqueue_local(LocalEdit {
        page_id: p.entry.id.clone(),
        epoch: p.entry.epoch,
        generation: p.entry.generation,
        revision: p.doc.revision(),
        op_id: Uuid::new_v4().to_string(),
        update,
        first_write_date: Some(date()),
    })
}

fn bounded_selection(text: &str, selection: native::TextRange) -> native::TextRange {
    let requested_end = selection.start.saturating_add(selection.length);
    let (mut offset,mut start,mut end) = (0u32,0u32,0u32);
    for ch in text.chars() {
        offset += ch.len_utf16() as u32;
        if offset <= selection.start { start = offset; }
        if offset <= requested_end { end = offset; } else { break; }
    }
    native::TextRange { start, length: end.saturating_sub(start) }
}

fn reply(p: &mut Paper) -> native::EventReply {
    let selection = bounded_selection(
        &p.view.document.text,
        p.owner
            .as_ref()
            .map(|o| o.selection.clone())
            .unwrap_or_default(),
    );
    if let Some(o) = p.owner.as_mut() {
        o.selection = selection.clone();
    }
    native::EventReply {
        revision: p.doc.revision(),
        clipboard_text: None,
        projection: Some(native::Projection {
            document: native_document(&p.view),
            selection,
        }),
    }
}
fn is_editor_action(action: &str) -> bool {
    matches!(action, "undo"|"redo"|"bold"|"italic"|"strike"|"paragraph"|"quote"|"bullet_list"|"ordered_list"
        |"heading1"|"heading2"|"heading3"|"heading4"|"heading5"|"heading6"|"indent"|"outdent"
        |"hard_break"|"link_begin"|"link_cancel"|"recover_paste_plain"|"recover_paste_original") || action.starts_with("link_set:")
}
fn apply_action(
    p: &mut Paper,
    action: &str,
    range: native::TextRange,
    at: i64,
) -> Result<Option<Vec<u8>>> {
    let before = p.doc.revision();
    if action == "hard_break" {
        let update = apply_input(p, &write_core::render::TextRange { start: range.start, length: range.length }, "  \n", true, at)?;
        return Ok(Some(update));
    }
    if range.length == 0 && matches!(action, "bold" | "italic" | "strike") {
        let context = p.view.typing_style(&write_core::render::TextRange { start: range.start, length: 0 }).map_err(err)?;
        let owner = p.owner.as_mut().ok_or("写作会话已关闭")?;
        if owner.composing { return Err("请先完成输入法组合".into()); }
        let mut style = owner.typing_style.unwrap_or(context);
        style.toggle(action); owner.typing_style = Some(style); owner.selection = range;
        return Ok(None);
    }
    if let Some(o) = p.owner.as_mut() {
        o.selection = range.clone();
        if range.length > 0 || matches!(action, "undo" | "redo" | "hard_break" | "paragraph" | "quote" | "bullet_list" | "ordered_list" | "indent" | "outdent") || action.starts_with("heading") || action.starts_with("link_") { o.typing_style = None; }
    }
    let anchor = p
        .view
        .anchor_selection(
            &p.doc,
            &write_core::render::TextRange {
                start: range.start,
                length: range.length,
            },
        )
        .ok();
    let mut explicit = None;
    let update = match action {
        "undo" => Some(p.doc.undo(at).map_err(err)?),
        "redo" => Some(p.doc.redo(at).map_err(err)?),
        "bold" | "italic" | "strike" | "paragraph" | "quote" | "bullet_list" | "ordered_list"
        | "heading1" | "heading2" | "heading3" | "heading4" | "heading5" | "heading6"
        | "indent" | "outdent" => Some(
            p.view
                .apply_format(
                    &mut p.doc,
                    &write_core::render::TextRange {
                        start: range.start,
                        length: range.length,
                    },
                    action,
                    at,
                )
                .map_err(err)?,
        ),
        "link_begin" => {
            let requested=write_core::render::TextRange{start:range.start,length:range.length};
            let selection=p.view.link_target(&requested).map_err(err)?.map(|(selection,_)|selection).unwrap_or(requested);
            if selection.length==0{return Err("请先选择要添加链接的文字".into());}
            p.pending_link=Some(p.view.anchor_selection(&p.doc,&selection).map_err(err)?);
            if let Some(owner)=p.owner.as_mut(){owner.selection=native::TextRange{start:selection.start,length:selection.length};}
            return Ok(None);
        }
        "link_cancel" => { p.pending_link = None; return Ok(None); }
        action if action.starts_with("link_set:") => {
            let link = p.pending_link.take().ok_or("链接选区已过期，请重新选择")?;
            let range = p.view.resolve_selection(&p.doc, &link).map_err(err)?;
            Some(p.view.apply_link(&mut p.doc, &range, &action[9..], at).map_err(err)?)
        }
        "recover_paste_plain" | "recover_paste_original" => {
            let draft = p.pending_clipboard.clone().ok_or("没有待恢复的粘贴草稿")?;
            let range = p
                .view
                .resolve_selection(&p.doc, &draft.anchor)
                .map_err(err)?;
            let text = if action == "recover_paste_plain" {
                draft.text
            } else if let Some(html) = draft.html {
                html
            } else if let Some(rtf) = draft.rtf {
                use base64::Engine;
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(&rtf)
                    .map_err(err)?;
                String::from_utf8(bytes).unwrap_or_else(|_| format!("RTF (base64): {rtf}"))
            } else {
                draft.text
            };
            if text.is_empty() {
                return Err("原剪贴板没有纯文本内容，请恢复原始粘贴".into());
            }
            let text = text.replace("\r\n", "\n").replace('\r', "\n");
            let update = p
                .view
                .apply_edit(&mut p.doc, &range, &text, at)
                .map_err(err)?;
            explicit = Some(native::TextRange {
                start: range
                    .start
                    .saturating_add(text.encode_utf16().count() as u32),
                length: 0,
            });
            p.pending_clipboard = None;
            Some(update)
        }
        _ => None,
    };
    if p.doc.revision() == before {
        return Ok(None);
    }
    p.view = SourceMap::new(&p.doc.body(), p.doc.revision());
    let selection = explicit.or_else(|| {
        anchor
            .and_then(|anchor| p.view.resolve_selection(&p.doc, &anchor).ok())
            .map(|range| native::TextRange {
                start: range.start,
                length: range.length,
            })
    });
    if let Some(selection) = selection {
        if let Some(o) = p.owner.as_mut() {
            o.selection = bounded_selection(&p.view.document.text, selection);
        }
    }
    Ok(update)
}
fn update_input_selection(p: &mut Paper, range: native::TextRange) {
    let range = bounded_selection(&p.view.document.text, range);
    if let Some(owner) = p.owner.as_mut() {
        if !owner.composing && (owner.selection.start != range.start || owner.selection.length != range.length) { owner.typing_style = None; }
        owner.selection = range;
    }
}

fn apply_input(p: &mut Paper, range: &write_core::render::TextRange, text: &str, markdown: bool, at: i64) -> Result<Vec<u8>> {
    let before = p.doc.revision();
    let pending = p.owner.as_ref().and_then(|owner| owner.typing_style);
    let (update, selected) = if let Some(style) = pending {
        let (update, selection) = p.view.apply_typing_insert(&mut p.doc, range, text, markdown, style, at).map_err(err)?;
        (update, selection.start)
    } else if markdown {
        let source = p.view.source_range(range).map_err(err)?;
        let end = p.doc.body()[..source.start].encode_utf16().count() as u32 + text.encode_utf16().count() as u32;
        let update = p.view.apply_markdown_paste(&mut p.doc, range, text, at).map_err(err)?;
        p.view = SourceMap::new(&p.doc.body(), p.doc.revision());
        (update, p.view.visible_offset(end).map_err(err)?)
    } else {
        (p.view.apply_edit(&mut p.doc, range, text, at).map_err(err)?, range.start.saturating_add(text.encode_utf16().count() as u32))
    };
    if p.doc.revision() != before {
        p.view = SourceMap::new(&p.doc.body(), p.doc.revision());
        let selection = bounded_selection(&p.view.document.text, native::TextRange { start: selected, length: 0 });
        if let Some(owner) = p.owner.as_mut() {
            owner.selection = selection;
            if text.contains('\n') { owner.typing_style = None; }
        }
    }
    Ok(update)
}

fn handle_native<R: Runtime>(
    app: &tauri::AppHandle<R>,
    ws: &Arc<Workspace>,
    page_id: &str,
    event: native::NativeEvent,
) -> Result<native::EventReply> {
    current_native(app, ws)?;
    let mut papers = ws.papers.lock().map_err(err)?;
    ws.writable()?;
    let p = papers.get_mut(page_id).ok_or("写作会话已关闭")?;
    let (surface, generation, revision) = match &event {
        native::NativeEvent::Edit {
            surface_id,
            generation,
            base_revision,
            ..
        }
        | native::NativeEvent::Paste {
            surface_id,
            generation,
            base_revision,
            ..
        } => (surface_id, *generation, *base_revision),
        native::NativeEvent::Selection {
            surface_id,
            generation,
            revision,
            ..
        }
        | native::NativeEvent::Viewport {
            surface_id,
            generation,
            revision,
            ..
        }
        | native::NativeEvent::Composition {
            surface_id,
            generation,
            revision,
            ..
        }
        | native::NativeEvent::Clipboard {
            surface_id,
            generation,
            revision,
            ..
        }
        | native::NativeEvent::Action {
            surface_id,
            generation,
            revision,
            ..
        } => (surface_id, *generation, *revision),
    };
    let o = p.owner.as_ref().ok_or("写作会话已关闭")?;
    if !o
        .surface
        .as_ref()
        .is_some_and(|s| s.surface_id == *surface && s.generation == generation)
    {
        return Err("原生编辑面已过期".into());
    }
    if o.suspended || p.entry.deleted || o.generation != p.entry.generation {
        return Err("页面生命周期已变化，旧草稿已保留，请重新打开".into());
    }
    if revision != p.doc.revision() {
        return Err("编辑版本已变化，请重试".into());
    }
    // Reserve capacity before touching the CRDT; an unavailable backend may
    // reject new edits, but must never accept an edit we cannot retain for replay.
    let mut permit = if match &event {
        native::NativeEvent::Edit { .. } | native::NativeEvent::Paste { .. } | native::NativeEvent::Clipboard { cut:true, .. } => true,
        native::NativeEvent::Action { action, .. } => is_editor_action(action),
        _ => false,
    } { Some(ws.durable.try_reserve_edit()?) } else { None };
    let before = p.doc.revision();
    let mut changed = false;
    let mut drain = false;
    match event {
        native::NativeEvent::Edit {
            range, replacement, ..
        } => {
            let update = apply_input(p, &write_core::render::TextRange { start: range.start, length: range.length }, &replacement, false, now())?;
            changed = p.doc.revision() != before;
            if changed {
                if let Err(error) = queue_reserved(p, update, permit.take().ok_or("缺少编辑保存预留")?) { p.error = Some(error); }
            }
        }
        native::NativeEvent::Selection { range, .. } => {
            update_input_selection(p, range);
            position_changed(p);
        }
        native::NativeEvent::Viewport { viewport, .. } => {
            if !viewport.offset.is_finite() || viewport.offset.abs() > 10000. { return Err("invalid viewport".into()); }
            let start = bounded_selection(&p.view.document.text, native::TextRange { start: viewport.start, length: 0 }).start;
            p.owner.as_mut().unwrap().viewport = native::Viewport { start, offset: viewport.offset };
            position_changed(p);
        }
        native::NativeEvent::Composition { active, .. } => {
            p.owner.as_mut().unwrap().composing = active;
            drain = !active;
            let _=app.emit("sumi-state",json!({"page_id":page_id,"tab_id":p.owner.as_ref().map(|o|&o.tab),"revision":revision,"durable":false,"composing":active}));
        }
        native::NativeEvent::Clipboard { ranges, cut, .. } => {
            if p.owner.as_ref().is_some_and(|o| o.composing) { return Err("请先完成输入法组合".into()); }
            let ranges: Vec<_> = ranges.into_iter().map(|r| write_core::render::TextRange { start: r.start, length: r.length }).collect();
            let text = p.view.clipboard_markdown(&ranges).map_err(err)?;
            if !cut { return Ok(native::EventReply { revision, projection: None, clipboard_text: Some(text) }); }
            let update = p.view.cut_selections(&mut p.doc, &ranges, now()).map_err(err)?;
            changed = p.doc.revision() != before;
            if changed {
                p.view = SourceMap::new(&p.doc.body(), p.doc.revision());
                p.owner.as_mut().unwrap().selection = bounded_selection(&p.view.document.text, native::TextRange { start: ranges.iter().map(|r| r.start).min().unwrap_or(0), length: 0 });
                if let Err(error) = queue_reserved(p, update, permit.take().ok_or("缺少编辑保存预留")?) { p.error = Some(error); }
            }
        }
        native::NativeEvent::Paste { range, text, html, rtf, literal, .. } => {
            if p.owner.as_ref().is_some_and(|o| o.composing) { return Err("请先完成输入法组合".into()); }
            if text.as_ref().map_or(0, String::len) + html.as_ref().map_or(0, String::len) + rtf.as_ref().map_or(0, String::len) > 4 * 1024 * 1024 {
                return Err("剪贴板超过 4 MiB，请分段粘贴".into());
            }
            let range = write_core::render::TextRange { start: range.start, length: range.length };
            let anchor = p.view.anchor_selection(&p.doc, &range).map_err(err)?;
            let markdown = match paste::markdown(text.as_deref(), html.as_deref()) {
                Ok(value) => value,
                Err(error) => {
                    p.pending_clipboard = Some(ClipboardDraft { text: text.unwrap_or_default(), html, rtf, anchor });
                    let _=app.emit("sumi-state",json!({"page_id":page_id,"revision":revision,"durable":false,"notice":error}));
                    return Err(error);
                }
            };
            if markdown.is_empty() { return Ok(p.doc.revision().into()); }
            let update = apply_input(p, &range, &markdown, !literal, now())?;
            changed = p.doc.revision() != before;
            if changed {
                if let Err(error) = queue_reserved(p, update, permit.take().ok_or("缺少编辑保存预留")?) { p.error = Some(error); }
            }
            p.pending_clipboard = None;
        }
        native::NativeEvent::Action { action, range, .. } => {
            if action == "fullscreen" {
                let window = app
                    .get_webview_window(&p.owner.as_ref().unwrap().window)
                    .ok_or("编辑窗口已关闭")?;
                window
                    .set_fullscreen(!window.is_fullscreen().map_err(err)?)
                    .map_err(err)?;
                return Ok(p.doc.revision().into());
            }
            if matches!(action.as_str(), "save" | "zoom_in" | "zoom_out" | "zoom_reset") {
                let owner=p.owner.as_ref().unwrap().clone();
                let app=app.clone();let ws=ws.clone();let page=page_id.to_owned();let action=action.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error)=document_command(&app,&ws,&page,&owner.window,&owner.tab,&action).await {
                        let _=app.emit_to(&owner.window,"sumi-state",json!({"page_id":page,"notice":error}));
                        if is_plugin_window(&owner.window){push(&app,&json!({"type":"sumi-error","message":error}));}
                    }
                });
                return Ok(p.doc.revision().into());
            }
            let update = apply_action(p, &action, range, now())?;
            if action=="link_begin" {return Ok(reply(p));}
            changed = p.doc.revision() != before;
            if let Some(update) = update {
                if let Err(error) = queue_reserved(p, update, permit.take().ok_or("缺少编辑保存预留")?) {
                    p.error = Some(error);
                }
            } else if !is_editor_action(&action) && !matches!(
                action.as_str(),
                "undo"
                    | "redo"
                    | "bold"
                    | "italic"
                    | "strike"
                    | "recover_paste_plain"
                    | "recover_paste_original"
            ) {
                let payload = json!({"page_id":page_id,"tab_id":p.owner.as_ref().map(|o|&o.tab),"action":action});
                let target = &p.owner.as_ref().unwrap().window;
                let _ = app.emit_to(target, "sumi-action", &payload);
                if target == &crate::plugin_runtime::windows::window_label(PLUGIN, "main") {
                    push(app, &json!({"type":"sumi-action","action":action}));
                }
            }
        }
    }
    let accepted = if changed {
        position_changed(p);
        reply(p)
    } else {
        p.doc.revision().into()
    };
    drop(papers);
    if drain {
        let app = app.clone();
        let ws = ws.clone();
        let page = page_id.to_owned();
        tauri::async_runtime::spawn(async move {
            drain_after_composition(&app, &ws, &page).await;
        });
    }
    Ok(accepted)
}
pub(super) async fn integrate_remote<R: Runtime>(
    app: &tauri::AppHandle<R>,
    ws: &Arc<Workspace>,
    incoming: storage::PendingUpdate,
    generation: u64,
) -> Result<()> {
    current(app, ws)?;
    let page = incoming.page_id.clone();
    if !ws
        .durable
        .record_inbox(incoming.clone(), generation)
        .await?
    {
        return Ok(());
    }
    let _lease = ws.lifecycle.lock().await;
    ws.writable()?;
    if ensure(ws, &page).await.is_err() {
        // No editable owner exists before the first validated full state arrives.
        if ws.papers.lock().map_err(err)?.contains_key(&page) {
            return Err("写作状态恢复失败".into());
        }
        let loaded = ws.durable.receive_remote(incoming, generation).await?;
        ws.papers
            .lock()
            .map_err(err)?
            .insert(page, Paper::from_loaded(loaded)?);
        return Ok(());
    }
    drain_remote_locked(app, ws, &page).await
}
async fn retry_accepted_remote(ws: &Workspace, page: &str, op: &str) -> Result<bool> {
    let accepted = ws
        .papers
        .lock()
        .map_err(err)?
        .get(page)
        .and_then(|p| p.remote.pending_commits.get(op).copied());
    let Some(revision) = accepted else {
        return Ok(false);
    };
    // The UI already accepted this packet. A failed/lost durable receipt leaves
    // its FIFO record queued; retry persistence, never advance the UI twice.
    let loaded = ws.durable.load(page.into()).await?;
    if loaded.revision < revision {
        return Err("同步草稿尚未持久化".into());
    }
    let mut papers = ws.papers.lock().map_err(err)?;
    let p = papers.get_mut(page).ok_or("missing page")?;
    p.remote.pending_commits.remove(op);
    if loaded.revision >= p.durable_revision {
        p.durable_revision = loaded.revision;
        p.raw = loaded.raw_markdown;
    }
    Ok(true)
}
/// Called under the lifecycle gate. While marked text owns the frozen source
/// map, incoming packets stay on disk; do not copy the accumulated inbox blobs
/// into memory merely to discover composition inside the processing loop.
async fn pending_remote_for_drain(ws: &Workspace, page: &str) -> Result<Vec<durability::RecordedIncoming>> {
    {
        let papers = ws.papers.lock().map_err(err)?;
        let paper = papers.get(page).ok_or("missing page")?;
        if paper.owner.as_ref().is_some_and(|owner| owner.composing) {
            return Ok(Vec::new());
        }
    }
    // Composition can start after the small check above. The per-record check
    // and the main-thread native transaction still guard that race.
    ws.durable.pending_inbox(page.into()).await
}
async fn drain_remote_locked<R: Runtime>(
    app: &tauri::AppHandle<R>,
    ws: &Arc<Workspace>,
    page: &str,
) -> Result<()> {
    ws.writable()?;
    for recorded in pending_remote_for_drain(ws, page).await? {
        if retry_accepted_remote(ws, page, &recorded.update.op_id).await? {
            continue;
        }
        loop {
            let (seed, journal, acks, background, base, owned) = {
                let mut papers = ws.papers.lock().map_err(err)?;
                let p = papers.get_mut(page).ok_or("missing page")?;
                if p.entry.deleted || p.entry.generation != recorded.generation {
                    return Err("旧生命周期的同步草稿已隔离".into());
                }
                if p.owner.as_ref().is_some_and(|o| o.composing) {
                    return Ok(());
                }
                let mirrored = p.remote.base.load(Ordering::Acquire);
                let missing = mirrored == u64::MAX
                    || (mirrored < p.doc.revision()
                        && p.remote
                            .journal
                            .front()
                            .is_none_or(|(r, _)| *r > mirrored.saturating_add(1)));
                let seed = missing.then(|| {
                    (
                        p.entry.epoch,
                        p.doc.client_id(),
                        p.doc.encode_full(),
                        p.doc.revision(),
                    )
                });
                (
                    seed,
                    p.remote.journal.clone(),
                    std::mem::take(&mut p.remote.acknowledgements),
                    p.remote.background.clone(),
                    p.remote.base.clone(),
                    p.owner.clone(),
                )
            };
            let id = page.to_owned();
            let bytes = recorded.update.update.clone();
            let op = recorded.update.op_id.clone();
            let (prepared, view) = tauri::async_runtime::spawn_blocking(move || -> Result<_> {
                let mut background = background.lock().map_err(err)?;
                let prepared = (|| -> Result<_> {
                    if let Some((epoch, writer, full, revision)) = seed {
                        background.session = Some(
                            write_core::CandidateSession::new(&id, epoch, writer, &full, revision)
                                .map_err(err)?,
                        );
                        background.pending_op = None;
                    } else {
                        let candidate = background
                            .session
                            .as_mut()
                            .ok_or("missing remote candidate")?;
                        for token in acks {
                            candidate.ack_committed(token).map_err(err)?;
                        }
                        if !candidate.has_pending() {
                            background.pending_op = None;
                        }
                    }
                    let already_received = background.pending_op.as_deref() == Some(op.as_str());
                    let candidate = background
                        .session
                        .as_mut()
                        .ok_or("missing remote candidate")?;
                    for (revision, update) in journal {
                        if revision > candidate.base_revision() {
                            candidate.advance_local(revision, &update).map_err(err)?;
                        }
                    }
                    if !already_received {
                        candidate.receive_remote(&bytes).map_err(err)?;
                    }
                    let prepared = candidate
                        .prepare_current()
                        .map_err(err)?
                        .ok_or("missing pending remote")?;
                    base.store(candidate.base_revision(), Ordering::Release);
                    background.pending_op = Some(op);
                    Ok(prepared)
                })();
                match prepared {
                    Ok(prepared) => {
                        let view =
                            SourceMap::new(&prepared.snapshot().body, prepared.snapshot().revision);
                        Ok((prepared, view))
                    }
                    Err(error) => {
                        background.session = None;
                        background.pending_op = None;
                        base.store(u64::MAX, Ordering::Release);
                        Err(error)
                    }
                }
            })
            .await
            .map_err(err)??;
            let commit_ws = ws.clone();
            let id = page.to_owned();
            let incoming = recorded.update.clone();
            let generation = recorded.generation;
            let commit = move |state: Option<&native::SurfaceState>| -> Result<_> {
                let mut papers = commit_ws.papers.lock().map_err(err)?;
                commit_ws.writable()?;
                let p = papers.get_mut(&id).ok_or("missing page")?;
                if p.entry.deleted || p.entry.generation != generation {
                    return Err("旧生命周期的同步草稿已隔离".into());
                }
                if p.doc.revision() != prepared.base_revision() {
                    return Err("SUMI_RETRY_REVISION".into());
                }
                if let Some(state) = state {
                    if !p
                        .owner
                        .as_ref()
                        .and_then(|o| o.surface.as_ref())
                        .is_some_and(|s| {
                            s.surface_id == state.surface_id && s.generation == state.generation
                        })
                        || state.revision != p.doc.revision()
                    {
                        return Err("SUMI_RETRY_REVISION".into());
                    }
                    if let Some(o) = p.owner.as_mut() {
                        o.selection = state.selection.clone();
                    }
                }
                let anchor = p.owner.as_ref().and_then(|o| {
                    p.view
                        .anchor_selection(
                            &p.doc,
                            &write_core::render::TextRange {
                                start: o.selection.start,
                                length: o.selection.length,
                            },
                        )
                        .ok()
                });
                let permit=commit_ws.durable.try_reserve_edit()?;
                let token = prepared.commit_token();
                p.doc.commit_prepared(prepared).map_err(|e| {
                    if matches!(e, write_core::Error::StaleRevision) {
                        "SUMI_RETRY_REVISION".into()
                    } else {
                        err(e)
                    }
                })?;
                p.cleanup_snapshot = None;
                p.view = view;
                p.remote.record(p.doc.revision(), &incoming.update);
                if let Some(token) = token {
                    p.remote.acknowledgements.push(token);
                }
                if let Some(anchor) = anchor {
                    if let Ok(range) = p.view.resolve_selection(&p.doc, &anchor) {
                        if let Some(o) = p.owner.as_mut() {
                            o.selection = native::TextRange {
                                start: range.start,
                                length: range.length,
                            };
                        }
                    }
                }
                p.remote
                    .pending_commits
                    .insert(incoming.op_id.clone(), p.doc.revision());
                let receipt = permit.enqueue_remote(incoming, generation, p.doc.revision());
                if let Err(error) = &receipt {
                    p.error = Some(error.clone());
                }
                let projection = state.map(|_| reply(p));
                Ok((receipt, projection))
            };
            let result = if let Some(o) = owned.filter(|o| o.surface.is_some()) {
                let window = app.get_webview_window(&o.window).ok_or("编辑窗口已关闭")?;
                let surface = o.surface.unwrap();
                native::transaction(
                    &window,
                    surface.surface_id,
                    surface.generation,
                    move |state| commit(Some(state)),
                )
                .await
            } else {
                commit(None).map(|(receipt, _)| receipt)
            };
            let receipt = match result {
                Err(error) if error == "SUMI_RETRY_REVISION" => continue,
                Err(error) if error == "composition active" => return Ok(()),
                other => other??,
            };
            let loaded = receipt.await.map_err(err)??;
            {
                let mut papers = ws.papers.lock().map_err(err)?;
                if let Some(p) = papers.get_mut(page) {
                    p.remote.pending_commits.remove(&recorded.update.op_id);
                    if loaded.revision >= p.durable_revision {
                        p.durable_revision = loaded.revision;
                        p.raw = loaded.raw_markdown;
                    }
                }
            }
            break;
        }
    }
    Ok(())
}
async fn drain_after_composition<R: Runtime>(
    app: &tauri::AppHandle<R>,
    ws: &Arc<Workspace>,
    page: &str,
) {
    let pending = ws.pending_directory.lock().ok().and_then(|mut p| p.take());
    let result = if let Some(entries) = pending {
        directory_changed(app, ws, entries).await
    } else {
        Ok(())
    };
    let result = match result {
        Ok(()) => {
            let _lease = ws.lifecycle.lock().await;
            drain_remote_locked(app, ws, page).await
        }
        Err(error) => Err(error),
    };
    let result = match result {
        Ok(()) => apply_appearance(app, ws, Some(page)).await,
        Err(error) => Err(error),
    };
    if let Err(error) = result {
        if let Ok(mut papers) = ws.papers.lock() {
            if let Some(p) = papers.get_mut(page) {
                p.error = Some(error.clone());
            }
        }
        let _ = app.emit(
            "sumi-state",
            json!({"page_id":page,"durable":false,"error":error}),
        );
    }
}
// Filename allocation may also relocate a different, already-open local page.
fn renamed_pages(before: &[Entry], applied: &[Entry]) -> Vec<(String, String)> {
    applied.iter().filter(|entry| before.iter().any(|old| old.id == entry.id
        && old.epoch == entry.epoch && old.filename() != entry.filename()))
        .filter_map(|entry| before.iter().find(|old| old.id == entry.id)?.filename().map(|old| (entry.id.clone(), old))).collect()
}
fn check_open_identity(papers: &HashMap<String, Paper>, window: &str, tab: &str, page: &str, expected: Option<&str>) -> Result<()> {
    if expected.is_some_and(|id| id != page) {
        return Err("写作文件身份已变化；已保留原页和草稿，请刷新目录路径后重试".into());
    }
    if papers.iter().any(|(id, p)| id != page && p.owner.as_ref().is_some_and(|o| o.window == window && o.tab == tab)) {
        return Err("此标签页仍持有另一纸页；已保留原页和草稿".into());
    }
    Ok(())
}

pub(super) async fn directory_changed<R: Runtime>(
    app: &tauri::AppHandle<R>,
    ws: &Arc<Workspace>,
    entries: Vec<Entry>,
) -> Result<()> {
    current(app, ws)?;
    let _lease = ws.lifecycle.lock().await;
    ws.writable()?;
    let active = {
        let papers = ws.papers.lock().map_err(err)?;
        entries
            .iter()
            .filter_map(|entry| {
                papers
                    .get(&entry.id)
                    .filter(|p| {
                        entry.generation != p.entry.generation
                            || entry.epoch != p.entry.epoch
                            || entry.deleted != p.entry.deleted
                    })
                    .and_then(|p| p.owner.clone().filter(|o| o.surface.is_some()))
                    .map(|o| (entry.id.clone(), o))
            })
            .collect::<Vec<_>>()
    };
    let mut hidden: Vec<(WebviewWindow<R>, Surface)> = Vec::new();
    for (id, o) in &active {
        let window = app.get_webview_window(&o.window).ok_or("编辑窗口已关闭")?;
        let surface = o.surface.as_ref().unwrap();
        if let Err(error) = native::command(
            &window,
            surface.surface_id.clone(),
            surface.generation,
            native::SurfaceCommand::SetVisible { visible: false },
        )
        .await
        {
            for (window, surface) in hidden {
                let _ = native::command(
                    &window,
                    surface.surface_id,
                    surface.generation,
                    native::SurfaceCommand::SetVisible { visible: true },
                )
                .await;
            }
            *ws.pending_directory.lock().map_err(err)? = Some(entries);
            return Err(error);
        }
        hidden.push((window, surface.clone()));
        let _ = id;
    }
    let result = async {
        for entry in entries {
            let before = ws.durable.list().await?;
            let applied = ws.durable.apply_directory(entry).await?;
            let renamed = renamed_pages(&before, &applied);
            let mut notices = Vec::new();
            let mut papers = ws.papers.lock().map_err(err)?;
            for entry in applied {
                if let Some(p) = papers.get_mut(&entry.id) {
                    let changed = p.entry.generation != entry.generation
                        || p.entry.epoch != entry.epoch
                        || p.entry.deleted != entry.deleted;
                    p.cleanup_snapshot = None;
                    p.entry = entry;
                    if changed {
                        p.error = Some(
                            "远端页面生命周期已变化，草稿已保留；请关闭旧编辑面后重新打开".into(),
                        );
                        if let Some(owner) = &p.owner {
                            notices.push((
                                owner.window.clone(),
                                json!({
                                    "page_id": p.entry.id,
                                    "tab_id": owner.tab,
                                    "durable": false,
                                    "error": p.error,
                                }),
                            ));
                        }
                    }
                }
            }
            drop(papers);
            current(app, ws)?;
            for (page_id, old_filename) in renamed {
                let (old_path, _) = write_core::projection::paths(&ws.root, &old_filename).map_err(err)?;
                let _ = app.emit_to("main", "sumi-path-changed", json!({"page_id":page_id,"old_path":old_path}));
            }
            for (window, payload) in notices {
                let _ = app.emit_to(&window, "sumi-state", payload);
            }
        }
        Ok::<_, String>(())
    }
    .await;
    if result.is_err() {
        for (window, surface) in hidden {
            let _ = native::command(
                &window,
                surface.surface_id,
                surface.generation,
                native::SurfaceCommand::SetVisible { visible: true },
            )
            .await;
        }
    }
    if let Ok(state) = state_value(ws).await {
        push(app, &json!({"type":"sumi-state","state":state}));
    }
    result
}
async fn load_preferences(durable: &Durability) -> Result<Preferences> {
    let stored = durable.preferences("appearance".into()).await?;
    let missing_caret_motion = stored.as_ref().is_some_and(|value| value.get("caretMotion").is_none());
    let mut preferences: Preferences = stored
        .and_then(|value| serde_json::from_value(value).ok()).unwrap_or_default();
    // Add the new default and migrate only retired fonts, preserving other fields.
    if preferences.normalize_stored_font() || missing_caret_motion {
        durable.set_preferences("appearance".into(), serde_json::to_value(&preferences).map_err(err)?).await?;
    }
    Ok(preferences)
}
fn current_ui_locale<R: Runtime>(app: &tauri::AppHandle<R>) -> String {
    let explicit = UI_LOCALE.lock().ok().and_then(|locale| locale.clone());
    native::normalize_locale(&explicit.unwrap_or_else(|| crate::read_saved_locale(app))).into()
}

/// Refresh only existing native labels; never opens a workspace or touches its text.
pub fn refresh_locale<R: Runtime>(app: &tauri::AppHandle<R>, locale: &str) {
    if let Ok(mut current) = UI_LOCALE.lock() { *current = Some(native::normalize_locale(locale).into()); }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let workspaces = WORKSPACES.lock().await.values().cloned().collect::<Vec<_>>();
        for ws in workspaces {
            let _appearance = ws.appearance_changes.lock().await;
            let owners = match ws.papers.lock() {
                Ok(papers) => papers.values().filter_map(|paper| paper.owner.clone().filter(|owner| owner.surface.is_some())).collect::<Vec<_>>(),
                Err(_) => continue,
            };
            for owner in owners {
                let Some(window) = app.get_webview_window(&owner.window) else { continue; };
                let surface = owner.surface.unwrap();
                let _ = native::command(&window, surface.surface_id, surface.generation,
                    native::SurfaceCommand::SetLocale { locale: current_ui_locale(&app) }).await;
            }
        }
    });
}

// Runtime fallback is not a sixth font choice and never triggers network I/O.
async fn ensure_font<R: Runtime>(
    app: &tauri::AppHandle<R>,
    window: &WebviewWindow<R>,
    appearance: &native::Appearance,
) -> Result<native::Appearance> {
    if !fonts::known_font(&appearance.font_family) { return Err("无效的写作字体组合".into()); }
    let manager = font_manager(app)?;
    let Some(files) = manager.files(&appearance.font_family).await.unwrap_or(None) else {
        let mut fallback = appearance.clone();
        fallback.font_family = "Sumi System".into();
        fallback.locale = current_ui_locale(app);
        return Ok(fallback);
    };
    for font in &files {
        native::register_font(window, font.path.clone(), font.postscript.clone()).await
            .map_err(|e| format!("无法加载 Sumi 统一字体：{e}"))?;
    }
    native::register_font_cascade(window, appearance.font_family.clone(),
        files.into_iter().map(|font| font.postscript).collect()).await
        .map_err(|e| format!("无法加载 Sumi 打字机组合字体：{e}"))?;
    let mut prepared = appearance.clone();
    prepared.locale = current_ui_locale(app);
    Ok(prepared)
}

async fn font_status(ws: &Workspace, manager: &fonts::Manager) -> Result<Value> {
    let fonts = manager.statuses().await?;
    let selected = ws.preferences.lock().map_err(err)?.font_family.clone();
    let pending = ws.font_selection.lock().map_err(err)?.pending.clone();
    Ok(json!({"fonts": fonts, "selectedFont": selected, "pendingFont": pending}))
}

async fn begin_font_selection(ws: &Workspace, family: &str) -> Result<Option<u64>> {
    if !fonts::known_font(family) { return Err("无效的写作字体组合".into()); }
    let _appearance = ws.appearance_changes.lock().await;
    ws.writable()?;
    let mut selection = ws.font_selection.lock().map_err(err)?;
    if selection.pending.as_deref() == Some(family) { return Ok(None); }
    selection.generation += 1;
    selection.pending = Some(family.into());
    Ok(Some(selection.generation))
}

async fn complete_font_selection(ws: &Workspace, generation: u64, family: &str) -> Result<bool> {
    let _appearance = ws.appearance_changes.lock().await;
    ws.writable()?;
    {
        let selection = ws.font_selection.lock().map_err(err)?;
        if selection.generation != generation || selection.pending.as_deref() != Some(family) { return Ok(false); }
    }
    let mut preferences = ws.preferences.lock().map_err(err)?.clone();
    preferences.font_family = family.into();
    preferences.validate()?;
    ws.durable.set_preferences("appearance".into(), serde_json::to_value(&preferences).map_err(err)?).await?;
    *ws.preferences.lock().map_err(err)? = preferences;
    ws.font_selection.lock().map_err(err)?.pending = None;
    Ok(true)
}

async fn save_appearance(ws: &Workspace, mut preferences: Preferences, preserve_font: bool) -> Result<()> {
    let _appearance = ws.appearance_changes.lock().await;
    ws.writable()?;
    let current_font = ws.preferences.lock().map_err(err)?.font_family.clone();
    if preserve_font { preferences.font_family = current_font.clone(); }
    preferences.validate()?;
    let replace_font = !preserve_font && preferences.font_family != current_font;
    ws.durable.set_preferences("appearance".into(), serde_json::to_value(&preferences).map_err(err)?).await?;
    *ws.preferences.lock().map_err(err)? = preferences;
    if replace_font {
        let mut selection = ws.font_selection.lock().map_err(err)?;
        selection.generation += 1;
        selection.pending = None;
    }
    Ok(())
}

async fn select_font<R: Runtime>(app: &tauri::AppHandle<R>, ws: &Arc<Workspace>, family: &str) -> Result<Value> {
    let manager = font_manager(app)?;
    if let Some(generation) = begin_font_selection(ws, family).await? {
        let app = app.clone();
        let ws = ws.clone();
        let family = family.to_owned();
        let worker = manager.clone();
        tauri::async_runtime::spawn(async move {
            let result = async {
                worker.download(&family).await?;
                current(&app, &ws)?;
                // Register on the UI thread before persisting the new selection.
                let window = app.get_webview_window(&crate::plugin_runtime::windows::window_label(PLUGIN, "main"))
                    .or_else(|| app.get_webview_window("main")).ok_or("编辑窗口已关闭")?;
                let mut appearance = ws.preferences.lock().map_err(err)?.appearance();
                appearance.font_family = family.clone();
                let prepared = ensure_font(&app, &window, &appearance).await?;
                if prepared.font_family != family { return Err("字体缓存不可用，请重试下载".into()); }
                current(&app, &ws)?;
                if complete_font_selection(&ws, generation, &family).await? {
                    current(&app, &ws)?;
                    apply_appearance(&app, &ws, None).await?;
                    if let Ok(state) = state_value(&ws).await { push(&app, &json!({"type":"sumi-state","state":state})); }
                }
                Ok::<_, String>(())
            }.await;
            if let Err(error) = result {
                let report = ws.font_selection.lock().map(|mut selection| {
                    if selection.generation != generation { return false; }
                    selection.pending = None;
                    true
                }).unwrap_or(false);
                if report && current(&app, &ws).is_ok() {
                    push(&app, &json!({"type":"sumi-error","message":format!("字体下载或应用失败，可在外观设置中重试：{error}")}));
                }
            }
        });
    }
    font_status(ws, &manager).await
}

/// Read-only decision under lifecycle: a reloaded WebView may recover only its
/// exact live owner. Other editors receive no native surface capability.
fn existing_mount_decision(ws: &Workspace, page: &str, window: &str, tab: &str) -> Result<Option<EditorEntry<Surface>>> {
    ws.writable()?;
    authorize(PLUGIN)?;
    if is_plugin_window(window) && ws.active.lock().map_err(err)?.as_deref() != Some(page) {
        return Err("同步期间纸页已切换，已保留原稿；请重新选择目标页".into());
    }
    let papers = ws.papers.lock().map_err(err)?;
    let paper = papers.get(page).ok_or("写作页面不存在")?;
    if paper.entry.deleted { return Err("此页已在废纸篓中".into()); }
    let Some(owner) = paper.owner.as_ref() else { return Ok(None); };
    focus_owner_identity(paper, None)?;
    if owner.window != window || owner.tab != tab { return Ok(Some(existing_editor(page))); }
    let owner = focus_owner_identity(paper, Some((window, tab)))?;
    Ok(owner.surface.map(EditorEntry::Opened))
}

async fn mount<R: Runtime>(
    app: &tauri::AppHandle<R>,
    ws: &Arc<Workspace>,
    window: &WebviewWindow<R>,
    page_id: &str,
    tab_id: &str,
    bounds: native::Bounds,
) -> Result<EditorEntry<Surface>> {
    if !native::is_supported() {
        return Err("Sumi 原生编辑需要 macOS 13 或更新版本".into());
    }
    current(app, ws)?;
    require_visible_native_window(window)?;
    prepare_page(ws, page_id).await?;
    let _lease = ws.lifecycle.lock().await;
    current(app, ws)?;
    require_visible_native_window(window)?;
    ensure(ws, page_id).await?;
    current(app, ws)?;
    if let Some(existing) = existing_mount_decision(ws, page_id, window.label(), tab_id)? {
        return match existing {
            EditorEntry::Opened(surface) => {
                // Rebind only the JS handle and geometry; never remount, flush,
                // replace text, restore old selection or finish marked text.
                native::command(window, surface.surface_id.clone(), surface.generation,
                    native::SurfaceCommand::SetBounds { bounds }).await?;
                current(app, ws)?;
                require_visible_native_window(window)?;
                match existing_mount_decision(ws, page_id, window.label(), tab_id)? {
                    Some(EditorEntry::Opened(rechecked)) if rechecked == surface => { sound::start(app, ws).await; Ok(EditorEntry::Opened(surface)) },
                    _ => Err("编辑面已改变，请重新选择此页".into()),
                }
            }
            other => Ok(other),
        };
    }
    reconcile_known_files(ws, page_id).await?;
    current(app, ws)?;
    drain_remote_locked(app, ws, page_id).await?;
    load_position(ws, page_id).await?;
    let _appearance = ws.appearance_changes.lock().await;
    let appearance = ws.preferences.lock().map_err(err)?.appearance();
    let appearance = ensure_font(app, window, &appearance).await?;
    let surface = Surface {
        surface_id: Uuid::new_v4().to_string(),
        generation: 1,
    };
    current(app, ws)?;
    require_visible_native_window(window)?;
    let config = {
        let mut papers = ws.papers.lock().map_err(err)?;
        let p = papers.get_mut(page_id).unwrap();
        if p.entry.deleted {
            return Err("此页已在废纸篓中".into());
        }
        if let Some(o) = &p.owner {
            if o.window != window.label() || o.tab != tab_id || o.surface.is_some() {
                return Ok(existing_editor(page_id));
            }
        }
        let restored = resolve_reading_position(p);
        p.position_resolved = p.position.is_none() || restored.is_ok();
        let (selection, viewport) = restored.unwrap_or_default();
        p.cleanup_snapshot = None;
        p.owner = Some(Owner {
            window: window.label().into(),
            tab: tab_id.into(),
            surface: Some(surface.clone()),
            composing: false,
            selection: selection.clone(),
            viewport: viewport.clone(),
            suspended: false,
            generation: p.entry.generation,
            source_baseline: None,
            typing_style: None,
        });
        native::SurfaceConfig {
            surface_id: surface.surface_id.clone(),
            generation: surface.generation,
            revision: p.doc.revision(),
            bounds,
            appearance,
            document: native_document(&p.view),
            selection,
            viewport,
        }
    };
    let cb_app = app.clone();
    let cb_ws = ws.clone();
    let page = page_id.to_string();
    if let Err(error) = native::mount(
        window,
        config,
        Arc::new(move |event| {
            let result = handle_native(&cb_app, &cb_ws, &page, event);
            if let Err(error) = &result {
                let target = cb_ws.papers.lock().ok().and_then(|p| {
                    p.get(&page)
                        .and_then(|p| p.owner.as_ref().map(|o| (o.window.clone(), o.tab.clone())))
                });
                if let Some((window, tab)) = target {
                    let _ = cb_app.emit_to(
                        &window,
                        "sumi-state",
                        json!({"page_id":page,"tab_id":tab,"durable":false,"error":error}),
                    );
                    if window != "main" {
                        push(&cb_app, &json!({"type":"sumi-error","message":error}));
                    }
                }
            }
            result
        }),
    )
    .await
    {
        if let Some(p) = ws.papers.lock().map_err(err)?.get_mut(page_id) {
            p.owner = None;
        }
        return Err(error);
    }
    sound::start(app, ws).await;
    Ok(EditorEntry::Opened(surface))
}
fn frozen_cleanup(p: &Paper, window: &str, tab: &str, binding: Option<(&str,u64)>) -> Result<Option<Opened>> {
    let Some(saved) = &p.cleanup_snapshot else { return Ok(None); };
    let o=p.owner.as_ref().ok_or("写作会话已关闭")?;
    if saved.window != window || saved.tab != tab || o.window != window || o.tab != tab
        || o.generation != saved.owner_generation || p.doc.revision() != saved.snapshot.revision
        || p.durable_revision != saved.snapshot.revision {
        return Err("停用快照身份或版本已变化".into());
    }
    if let Some((id,generation))=binding {
        if !saved.surface.as_ref().is_some_and(|surface|surface.surface_id==id && surface.generation==generation)
            || o.surface.as_ref().is_some_and(|surface|surface.surface_id!=id || surface.generation!=generation) {
            return Err("原生编辑面已过期".into());
        }
    }
    Ok(Some(saved.snapshot.clone()))
}

async fn flush(
    ws: &Workspace,
    window: &str,
    tab: &str,
    page: &str,
    binding: Option<(&str, u64)>,
) -> Result<Opened> {
    {
        let mut papers = ws.papers.lock().map_err(err)?;
        let p = papers.get_mut(page).ok_or("missing page")?;
        if let Some(snapshot)=frozen_cleanup(p,window,tab,binding)? { return Ok(snapshot); }
        if ws.phase.load(Ordering::Acquire)==QUIESCED { return Err("缺少已确认的停用快照".into()); }
        if owner(p, window, tab, binding)?.composing {
            return Err("composition active".into());
        }
    }
    // load drains accepted edits to SQLite. Projection may remain blocked by an
    // external file edit; that must not prevent Source handoff/import recovery.
    let loaded = ws.durable.load(page.into()).await?;
    flush_positions(ws, Some(page)).await?;
    let baseline = ws.durable.read_baseline(page.into()).await?;
    let projected = loaded.entry.filename().is_none()
        || baseline.as_ref().is_some_and(|b| {
            b.revision == loaded.revision && b.pair.markdown == loaded.raw_markdown
        });
    let mut papers = ws.papers.lock().map_err(err)?;
    let p = papers.get_mut(page).ok_or("missing page")?;
    if owner(p, window, tab, binding)?.composing {
        return Err("composition active".into());
    }
    if loaded.revision != p.doc.revision() {
        return Err("保存版本正在变化，请重试".into());
    }
    p.raw = loaded.raw_markdown;
    p.durable_revision = loaded.revision;
    if projected { p.projection_error = None; }
    else { p.projection_error.get_or_insert_with(|| "正文已保存在本机，Markdown 与时间文件仍待写出".into()); }
    p.projection_identity = if projected {
        p.entry
            .filename()
            .map(|filename| {
                write_core::projection::paths(&ws.root, &filename).map(|(path, _)| {
                    durability::ProjectionIdentity {
                        path: path.to_string_lossy().into_owned(),
                        sha256: storage::sha256(p.raw.as_bytes()),
                    }
                })
            })
            .transpose()
            .map_err(err)?
    } else {
        None
    };
    let mut opened = p.opened();
    opened.projected = projected;
    Ok(opened)
}
fn finish_frozen_detach(ws: &Workspace, page: &str, window: &str, tab: &str, surface: &str, generation: u64) -> Result<Opened> {
    let mut papers=ws.papers.lock().map_err(err)?;
    let p=papers.get_mut(page).ok_or("missing page")?;
    let snapshot=frozen_cleanup(p,window,tab,Some((surface,generation)))?.ok_or("缺少已确认的停用快照")?;
    let o=owner(p,window,tab,None)?;
    o.surface=None; o.source_baseline=Some(snapshot.revision);
    Ok(snapshot)
}
async fn close_owner(ws: &Workspace, window: &str, tab: &str, page: &str) -> Result<()> {
    let _lease=ws.lifecycle.lock().await;
    flush(ws,window,tab,page,None).await?;
    let mut papers=ws.papers.lock().map_err(err)?;
    let p=papers.get_mut(page).ok_or("missing page")?;
    if owner(p,window,tab,None)?.surface.is_some() { return Err("请先关闭原生编辑面".into()); }
    p.owner=None;
    p.cleanup_snapshot=None;
    Ok(())
}

async fn detach<R: Runtime>(
    window: &WebviewWindow<R>,
    ws: &Workspace,
    page: &str,
    tab: &str,
    surface: &str,
    generation: u64,
) -> Result<Opened> {
    let _lease = ws.lifecycle.lock().await;
    detach_locked(window, ws, page, tab, surface, generation).await
}
async fn detach_locked<R: Runtime>(
    window: &WebviewWindow<R>,
    ws: &Workspace,
    page: &str,
    tab: &str,
    surface: &str,
    generation: u64,
) -> Result<Opened> {
    let frozen = {
        let papers=ws.papers.lock().map_err(err)?;
        let p=papers.get(page).ok_or("missing page")?;
        frozen_cleanup(p,window.label(),tab,Some((surface,generation)))?
    };
    if frozen.is_some() {
        let attached=ws.papers.lock().map_err(err)?.get(page).and_then(|p|p.owner.as_ref()).is_some_and(|o|o.surface.is_some());
        if attached { native::detach(window,surface.to_owned(),generation).await?; }
        return finish_frozen_detach(ws,page,window.label(),tab,surface,generation);
    }
    if ws.phase.load(Ordering::Acquire)==QUIESCED { return Err("缺少已确认的停用快照".into()); }
    {
        let mut papers = ws.papers.lock().map_err(err)?;
        owner(
            papers.get_mut(page).ok_or("missing page")?,
            window.label(),
            tab,
            Some((surface, generation)),
        )?;
    }
    // Resigning/hiding is one main-thread operation. It rejects marked text and
    // stops new input before the final durable snapshot is chosen.
    native::command(
        window,
        surface.into(),
        generation,
        native::SurfaceCommand::SetVisible { visible: false },
    )
    .await?;
    let saved = async {
        capture_native_position(window, ws, page, tab, surface, generation).await?;
        flush(ws, window.label(), tab, page, Some((surface, generation))).await
    }.await;
    let snapshot = match saved {
        Ok(snapshot) => snapshot,
        Err(error) => {
            let _ = native::command(
                window,
                surface.into(),
                generation,
                native::SurfaceCommand::SetVisible { visible: true },
            )
            .await;
            return Err(error);
        }
    };
    native::detach(window, surface.to_owned(), generation).await?;
    if let Some(p) = ws.papers.lock().map_err(err)?.get_mut(page) {
        let o = owner(p, window.label(), tab, Some((surface, generation)))?;
        o.surface = None;
        o.source_baseline = Some(snapshot.revision);
    }
    Ok(snapshot)
}
fn parse_header(raw: &str, page: &str, epoch: u32) -> Result<(serde_yaml::Mapping, String)> {
    let rest = raw
        .strip_prefix("---\n")
        .ok_or("写作身份头已移除，请保留草稿后明确选择转换为普通 Markdown")?;
    let split = rest.find("\n---\n").ok_or("写作身份头不完整")?;
    if split > 128 * 1024 {
        return Err("写作身份头超出容量限制".into());
    }
    let header: serde_yaml::Mapping = serde_yaml::from_str(&rest[..split]).map_err(err)?;
    let get = |k: &str| header.get(serde_yaml::Value::String(k.into()));
    if get("type").and_then(|v| v.as_str()) != Some("Writing Page")
        || get("page_id").and_then(|v| v.as_str()) != Some(page)
        || get("write_epoch").and_then(|v| v.as_u64()) != Some(epoch as u64)
        || get("write_schema").and_then(|v| v.as_u64()) != Some(1)
        || get("write_metadata").and_then(|v| v.as_str()) != Some("sidecar-v1")
    {
        return Err("写作身份、类型或协议已改变；同步已暂停，草稿保留".into());
    }
    Ok((header, rest[split + 5..].to_owned()))
}
async fn source_save(
    ws: &Workspace,
    window: &str,
    tab: &str,
    page: &str,
    base_revision: u64,
    raw: &str,
) -> Result<Opened> {
    let _lease = ws.lifecycle.lock().await;
    ws.writable()?;
    {
        let mut papers = ws.papers.lock().map_err(err)?;
        let p = papers.get_mut(page).ok_or("missing page")?;
        let o = owner(p, window, tab, None)?;
        if o.surface.is_some() {
            return Err("原生编辑面仍拥有此页".into());
        }
        if o.generation != p.entry.generation || p.entry.deleted {
            return Err("页面生命周期已变化，Source草稿已保留，请重新打开".into());
        }
        let (_, body) = parse_header(raw, page, p.entry.epoch)?;
        let base = p
            .baselines
            .get(&base_revision)
            .ok_or("Source 基线已失效；草稿保留")?
            .clone();
        let permit=ws.durable.try_reserve_edit()?;
        p.owner.as_mut().unwrap().source_baseline = Some(base_revision);
        match write_core::import::import_source(&mut p.doc, &base, &body, now()).map_err(err)? {
            write_core::import::ImportOutcome::Unchanged => {}
            write_core::import::ImportOutcome::Applied { update } => {
                p.view = SourceMap::new(&p.doc.body(), p.doc.revision());
                if let Err(error) = queue_reserved(p, update, permit) {
                    p.error = Some(error.clone());
                    return Err(error);
                }
            }
            write_core::import::ImportOutcome::Conflict { reason, .. } => {
                return Err(format!("Source 与并发编辑冲突，草稿保留：{reason}"))
            }
        }
    }
    ws.durable.load(page.into()).await?;
    let (header, revision) = {
        let papers = ws.papers.lock().map_err(err)?;
        let p = papers.get(page).ok_or("missing page")?;
        (parse_header(raw, page, p.entry.epoch)?.0, p.doc.revision())
    };
    ws.durable
        .save_header(page.into(), revision, header)
        .await?;
    flush(ws, window, tab, page, None).await
}

/// Caller holds lifecycle and has detached this page's native surface. Both
/// files are observed before any live CRDT mutation, including metadata-only edits.
async fn reconcile_known_files(ws: &Workspace, page: &str) -> Result<()> {
    ws.writable()?;
    let result = reconcile_known_files_inner(ws, page).await;
    if result.is_ok() {
        if let Some(p) = ws.papers.lock().map_err(err)?.get_mut(page) { p.projection_error = None; }
    }
    if let Err(error) = &result {
        let durable_revision = ws.durable.load(page.into()).await.ok().map(|loaded| loaded.revision);
        if let Some(p) = ws.papers.lock().map_err(err)?.get_mut(page) {
            if let Some(revision) = durable_revision { p.durable_revision = p.durable_revision.max(revision); }
            if p.durable_revision < p.doc.revision() { p.error = Some(error.clone()); }
            else { p.projection_error = Some(error.clone()); }
        }
    }
    result
}
async fn reconcile_known_files_inner(ws: &Workspace, page: &str) -> Result<()> {
    ws.writable()?;
    let loaded = ws.durable.load(page.into()).await?;
    let Some(filename) = loaded.entry.filename() else {
        return Ok(());
    };
    let mut baseline = ws.durable.read_baseline(page.into()).await?;
    if baseline.is_none() {
        ws.durable.flush().await?;
        baseline = ws.durable.read_baseline(page.into()).await?;
    }
    let baseline = baseline.ok_or("缺少可验证的文件基线；请使用恢复入口")?;
    let (md, meta) = write_core::projection::paths(&ws.root, &filename).map_err(err)?;
    let observed = external::Observed::read(&md, &meta)?.pair()?;
    if observed.markdown == baseline.pair.markdown && observed.metadata == baseline.pair.metadata {
        return Ok(());
    }
    let body = external::validate(&observed, &baseline.pair, page, loaded.entry.epoch)?;
    let permit=ws.durable.try_reserve_edit()?;
    let (edit, revision, generation) = {
        let mut papers = ws.papers.lock().map_err(err)?;
        let p = papers.get_mut(page).ok_or("写作会话已关闭")?;
        if p.owner.as_ref().is_some_and(|o| o.surface.is_some()) {
            return Err("请先关闭原生编辑面再导入外部修改".into());
        }
        if loaded.revision != p.doc.revision() {
            return Err("本机持久化版本尚未追平，请重试；外部稿已保留".into());
        }
        if loaded.entry.deleted || loaded.entry.generation != p.entry.generation {
            return Err("页面生命周期已变化；外部稿已保留".into());
        }
        let edit = match write_core::import::import_external(
            &mut p.doc,
            &baseline.full_state,
            &body,
            now(),
        )
        .map_err(err)?
        {
            write_core::import::ImportOutcome::Applied { update } => {
                p.view = SourceMap::new(&p.doc.body(), p.doc.revision());
                p.cleanup_snapshot = None;
                p.remote.record(p.doc.revision(), &update);
                Some(LocalEdit {
                    page_id: page.into(),
                    epoch: p.entry.epoch,
                    generation: p.entry.generation,
                    revision: p.doc.revision(),
                    op_id: Uuid::new_v4().to_string(),
                    update,
                    first_write_date: Some(date()),
                })
            }
            write_core::import::ImportOutcome::Unchanged => None,
            write_core::import::ImportOutcome::Conflict { reason, .. } => {
                return Err(format!("外部正文与本机编辑冲突，两份内容均保留：{reason}"))
            }
        };
        (edit, p.doc.revision(), p.entry.generation)
    };
    let loaded = if let Some(edit) = edit {
        permit.enqueue_import(edit, observed)?.await.map_err(|_| "Sumi导入后台已停止")??
    } else {
        ws.durable
            .import_projection_extensions(page.into(), generation, revision, observed)
            .await?
    };
    let mut papers = ws.papers.lock().map_err(err)?;
    let p = papers.get_mut(page).ok_or("写作会话已关闭")?;
    p.raw = loaded.raw_markdown;
    p.durable_revision = loaded.revision;
    p.error = None;
    p.projection_error = None;
    Ok(())
}

async fn open_path<R: Runtime>(
    app: &tauri::AppHandle<R>,
    window: &WebviewWindow<R>,
    path: &str,
    tab: &str,
    expected_page_id: Option<&str>,
) -> Result<EditorEntry<Opened>> {
    let ws = workspace(app).await?;
    let _lease = ws.lifecycle.lock().await;
    ws.writable()?;
    let path = std::fs::canonicalize(path).map_err(err)?;
    if !path.starts_with(&ws.root) || path.extension().and_then(|s| s.to_str()) != Some("md") {
        return Err("写作文件不在当前 Vault 中".into());
    }
    let raw = std::fs::read_to_string(&path).map_err(err)?;
    let header = raw
        .strip_prefix("---\n")
        .and_then(|s| s.split_once("\n---\n"))
        .ok_or("不是写作页面")?
        .0;
    let header: serde_yaml::Mapping = serde_yaml::from_str(header).map_err(err)?;
    let page = header
        .get(serde_yaml::Value::String("page_id".into()))
        .and_then(|v| v.as_str())
        .ok_or("缺少写作页面身份")?
        .to_owned();
    check_open_identity(&*ws.papers.lock().map_err(err)?, window.label(), tab, &page, expected_page_id)?;
    let entries = ws.durable.list().await?;
    let entry=entries.iter().find(|e|e.id==page).ok_or("本机尚无此页的完整写作状态。请先连接同步服务恢复；仅有 Markdown/时间快照需要显式恢复，不能冒充原 CRDT 历史")?;
    let expected = entry.filename().ok_or("空白页尚未生成文件")?;
    let (expected_path, _) = write_core::projection::paths(&ws.root, &expected).map_err(err)?;
    if path != expected_path {
        return Err("写作页面路径与目录记录不一致；请先完成文件及伴随元数据的移动恢复".into());
    }
    ensure(&ws, &page).await?;
    {
        let papers = ws.papers.lock().map_err(err)?;
        let p = papers.get(&page).unwrap();
        if p.entry.deleted {
            return Err("此页已在废纸篓中".into());
        }
        if let Some(o) = &p.owner {
            if o.window != window.label() || o.tab != tab || o.surface.is_some() {
                return Ok(existing_editor(&page));
            }
        }
    }
    {
        let mut papers = ws.papers.lock().map_err(err)?;
        let p = papers.get_mut(&page).unwrap();
        if let Some(o) = p.owner.as_mut() {
            o.source_baseline = p.baselines.keys().max().copied();
        }
    }
    drain_remote_locked(app, &ws, &page).await?;
    reconcile_known_files(&ws, &page).await?;
    current(app, &ws)?;
    let mut papers = ws.papers.lock().map_err(err)?;
    let p = papers.get_mut(&page).unwrap();
    if let Some(o) = &mut p.owner {
        if o.window != window.label() || o.tab != tab {
            return Ok(existing_editor(&page));
        }
        o.generation = p.entry.generation;
    } else {
        p.cleanup_snapshot = None;
        p.owner = Some(Owner {
            window: window.label().into(),
            tab: tab.into(),
            surface: None,
            composing: false,
            selection: Default::default(),
            viewport: Default::default(),
            suspended: false,
            generation: p.entry.generation,
            source_baseline: None,
            typing_style: None,
        });
    }
    Ok(EditorEntry::Opened(p.opened()))
}
async fn restore_projection<R: Runtime>(
    app: &tauri::AppHandle<R>,
    window: &WebviewWindow<R>,
    ws: &Arc<Workspace>,
    page: &str,
    tab: Option<&str>,
) -> Result<Value> {
    let _lease = ws.lifecycle.lock().await;
    ws.writable()?;
    current(app, ws)?;
    ensure(ws, page).await?;
    let generation = {
        let papers = ws.papers.lock().map_err(err)?;
        let p = papers.get(page).ok_or("写作会话已关闭")?;
        if let Some(owner) = &p.owner {
            if owner.window != window.label()
                || tab != Some(owner.tab.as_str())
                || owner.surface.is_some()
                || owner.composing
            {
                return Err("请先保存并关闭此页的编辑面，再修复本机文件；草稿不会丢弃".into());
            }
        }
        p.entry.generation
    };
    let (loaded, recovery) = ws
        .durable
        .restore_projection(page.into(), generation)
        .await?;
    current(app, ws)?;
    let mut papers = ws.papers.lock().map_err(err)?;
    let p = papers.get_mut(page).ok_or("写作会话已关闭")?;
    p.raw = loaded.raw_markdown;
    p.durable_revision = loaded.revision;
    p.error = None;
    p.projection_error = None;
    p.projection_identity = None;
    Ok(json!({"page_id":page,"raw":p.raw,"revision":p.doc.revision(),"recovery_path":recovery}))
}
#[tauri::command(rename_all = "snake_case")]
pub async fn sumi_restore_projection(
    app: tauri::AppHandle,
    window: WebviewWindow,
    plugin_id: String,
    page_id: String,
    tab_id: Option<String>,
) -> Result<Value> {
    host_window(&window)?;
    authorize(&plugin_id)?;
    restore_projection(
        &app,
        &window,
        &workspace(&app).await?,
        &page_id,
        tab_id.as_deref(),
    )
    .await
}
#[tauri::command(rename_all = "snake_case")]
pub async fn sumi_state(
    app: tauri::AppHandle,
    window: WebviewWindow,
    plugin_id: String,
) -> Result<Value> {
    host_window(&window)?;
    authorize(&plugin_id)?;
    state_value(workspace(&app).await?.as_ref()).await
}
#[tauri::command(rename_all = "snake_case")]
pub async fn sumi_recovery_probe(
    app: tauri::AppHandle,
    window: WebviewWindow,
    plugin_id: String,
    path: String,
) -> Result<recovery::Probe> {
    host_window(&window)?;
    authorize(&plugin_id)?;
    let ws = workspace(&app).await?;
    let root = ws.root.clone();
    let mut probe = tauri::async_runtime::spawn_blocking(move || {
        recovery::probe(&root, std::path::Path::new(&path))
    })
    .await
    .map_err(err)??;
    probe.known_page = ws
        .durable
        .list()
        .await?
        .iter()
        .any(|entry| probe.source_page_id.as_deref() == Some(entry.id.as_str()));
    current(&app, &ws)?;
    Ok(probe)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn sumi_recover_new(
    app: tauri::AppHandle,
    window: WebviewWindow,
    plugin_id: String,
    request_id: String,
    evidence: recovery::Evidence,
    normalize_crlf: bool,
) -> Result<Value> {
    host_window(&window)?;
    authorize(&plugin_id)?;
    let ws = workspace(&app).await?;
    let _lease = ws.lifecycle.lock().await;
    current(&app, &ws)?;
    evidence.verify_vault(&ws.root)?;
    let id = Uuid::parse_str(&request_id).map_err(err)?.to_string();
    let entries = ws.durable.list().await?;
    let loaded = if entries.iter().any(|entry| entry.id == id) {
        let loaded = ws.durable.load(id.clone()).await?;
        if !recovery::same_operation(&loaded.frontmatter, &id, &evidence) {
            return Err("恢复操作标识已用于另一张纸或另一份源文件，请重新检查".into());
        }
        if loaded.entry.deleted {
            return Err("这次恢复已完成，但新纸页已在废纸篓；请从废纸篓恢复".into());
        }
        loaded
    } else {
        let root = ws.root.clone();
        let source = evidence.clone();
        let new_id = id.clone();
        let prepared = tauri::async_runtime::spawn_blocking(move || {
            recovery::prepare(&root, &source, &new_id, normalize_crlf)
        })
        .await
        .map_err(err)??;
        current(&app, &ws)?;
        let first_write_date = (!prepared.document.body().is_empty()).then(date);
        let after_id = ws.active.lock().map_err(err)?.clone()
            .filter(|active| entries.iter().any(|entry| &entry.id == active));
        ws.durable
            .create(durability::Create {
                page_id: id.clone(),
                epoch: 1,
                full_state: prepared.document.encode_full(),
                revision: prepared.document.revision(),
                after_id,
                first_write_date,
                frontmatter: None,
                preserved_pair: Some(prepared.pair),
            })
            .await?
    };
    current(&app, &ws)?;
    let baseline = ws.durable.read_baseline(id.clone()).await?;
    let filename = loaded.entry.filename();
    let projected = baseline.as_ref().is_some_and(|baseline| {
        baseline.revision == loaded.revision
            && baseline.pair.markdown == loaded.raw_markdown
            && filename.as_deref() == Some(baseline.filename.as_str())
    });
    let path = if projected {
        filename
            .as_deref()
            .map(|filename| write_core::projection::paths(&ws.root, filename))
            .transpose()
            .map_err(err)?
            .map(|(path, _)| path.to_string_lossy().into_owned())
    } else {
        None
    };
    let flag = |key: &str| {
        loaded
            .frontmatter
            .get(serde_yaml::Value::String(key.into()))
            .and_then(|value| value.as_bool())
            .unwrap_or(false)
    };
    let response = json!({
        "page_id": id, "path": path, "raw": loaded.raw_markdown,
        "revision": loaded.revision, "projected": projected,
        "preserved_line_times": flag("_sumi_recovery_preserved_line_times"),
        "normalized_crlf": flag("_sumi_recovery_normalized_crlf"),
        "source_path": evidence.path,
    });
    // A retried request must never replace a live editor with its older durable snapshot.
    if !ws.papers.lock().map_err(err)?.contains_key(&id) {
        let paper = Paper::from_loaded(loaded)?;
        ws.papers
            .lock()
            .map_err(err)?
            .entry(id.clone())
            .or_insert(paper);
    }
    // Recovery was requested by the main file tab. Opening its returned path
    // must not navigate a live (or hidden) independent writing window first.
    current(&app, &ws)?;
    push(&app, &json!({"type":"sumi-state","state":state_value(&ws).await?}));
    Ok(response)
}

fn focus_owner_identity(p: &Paper, window: Option<(&str,&str)>) -> Result<Owner> {
    let owner=p.owner.clone().ok_or("已有编辑面已关闭，请重新打开此页")?;
    if p.entry.deleted || p.entry.generation!=owner.generation {
        return Err("纸页生命周期已变化，请重新打开".into());
    }
    if window.is_some_and(|(label,tab)|owner.window!=label || owner.tab!=tab) {
        return Err("编辑面已改变，请重新选择此页".into());
    }
    Ok(owner)
}
async fn focus_existing<R:Runtime>(app:&tauri::AppHandle<R>,ws:&Workspace,page:&str)->Result<()> {
    current(app,ws)?;
    let _lease=ws.lifecycle.lock().await;
    current(app,ws)?;
    let owner={let papers=ws.papers.lock().map_err(err)?;focus_owner_identity(papers.get(page).ok_or("写作页面不存在")?,None)?};
    // No caller-provided window/surface capability crosses this boundary.
    if owner.window=="main" {
        app.emit_to("main","sumi-focus-owner",json!({"page_id":page,"tab_id":owner.tab})).map_err(err)?;
    } else if is_plugin_window(&owner.window) {
        let window=app.get_webview_window(&owner.window).ok_or("已有编辑窗口已关闭")?;
        require_visible_native_window(&window)?;
        window.show().map_err(err)?;window.unminimize().map_err(err)?;window.set_focus().map_err(err)?;
        push(app,&json!({"type":"sumi-focus-owner","pageId":page}));
    } else {return Err("未知的写作编辑面".into());}
    Ok(())
}
#[tauri::command(rename_all = "snake_case")]
pub async fn sumi_focus_existing(app:tauri::AppHandle,window:WebviewWindow,plugin_id:String,page_id:String)->Result<()> {
    host_window(&window)?;authorize(&plugin_id)?;
    focus_existing(&app,workspace(&app).await?.as_ref(),&page_id).await
}
#[tauri::command(rename_all = "snake_case")]
pub async fn sumi_focus_owner(app:tauri::AppHandle,window:WebviewWindow,plugin_id:String,page_id:String,tab_id:String)->Result<()> {
    host_window(&window)?;authorize(&plugin_id)?;
    let ws=workspace(&app).await?;
    let _lease=ws.lifecycle.lock().await;
    current(&app,&ws)?;
    let owner={let papers=ws.papers.lock().map_err(err)?;focus_owner_identity(papers.get(&page_id).ok_or("写作页面不存在")?,Some((window.label(),&tab_id)))?};
    window.show().map_err(err)?;window.unminimize().map_err(err)?;window.set_focus().map_err(err)?;
    if let Some(surface)=owner.surface {
        if owner.suspended {
            native::command(&window,surface.surface_id.clone(),surface.generation,native::SurfaceCommand::SetVisible{visible:true}).await?;
            if let Some(owner)=ws.papers.lock().map_err(err)?.get_mut(&page_id).and_then(|p|p.owner.as_mut()) {owner.suspended=false;}
        }
        native::command(&window,surface.surface_id,surface.generation,native::SurfaceCommand::Focus).await?;
    }
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn sumi_open_path(
    app: tauri::AppHandle,
    window: WebviewWindow,
    plugin_id: String,
    path: String,
    tab_id: String,
    expected_page_id: Option<String>,
) -> Result<EditorEntry<Opened>> {
    host_window(&window)?;
    authorize(&plugin_id)?;
    open_path(&app, &window, &path, &tab_id, expected_page_id.as_deref()).await
}
/// Resolve a known identity without acquiring an editor or reading another page's file.
#[tauri::command(rename_all = "snake_case")]
pub async fn sumi_page_path(app: tauri::AppHandle, window: WebviewWindow, plugin_id: String, page_id: String) -> Result<Value> {
    host_window(&window)?;
    authorize(&plugin_id)?;
    let ws = workspace(&app).await?;
    let _lease = ws.lifecycle.lock().await;
    let entries = ws.durable.list().await?;
    current(&app, &ws)?;
    let entry = entries.iter().find(|e| e.id == page_id).ok_or("纸页不在当前 Vault 目录中")?;
    let filename = entry.filename().ok_or("空白页尚未生成文件")?;
    let (path, _) = write_core::projection::paths(&ws.root, &filename).map_err(err)?;
    Ok(json!({"page_id":entry.id,"epoch":entry.epoch,"path":path,"vault_root":ws.root}))
}
#[tauri::command(rename_all = "snake_case")]
pub async fn sumi_mount(
    app: tauri::AppHandle,
    window: WebviewWindow,
    plugin_id: String,
    page_id: String,
    tab_id: String,
    bounds: native::Bounds,
) -> Result<EditorEntry<Surface>> {
    host_window(&window)?;
    authorize(&plugin_id)?;
    mount(
        &app,
        &workspace(&app).await?,
        &window,
        &page_id,
        &tab_id,
        bounds,
    )
    .await
}
#[tauri::command(rename_all = "snake_case")]
pub async fn sumi_flush(
    app: tauri::AppHandle,
    window: WebviewWindow,
    plugin_id: String,
    page_id: String,
    tab_id: String,
    surface_id: Option<String>,
    generation: Option<u64>,
) -> Result<Opened> {
    let _ = app;
    let ws = owned_workspace(&window, &plugin_id, &page_id, &tab_id).await?;
    if surface_id.is_some() != generation.is_some() {
        return Err("invalid surface binding".into());
    }
    flush(
        &ws,
        window.label(),
        &tab_id,
        &page_id,
        surface_id.as_deref().zip(generation),
    )
    .await
}
#[tauri::command(rename_all = "snake_case")]
pub async fn sumi_detach(
    app: tauri::AppHandle,
    window: WebviewWindow,
    plugin_id: String,
    page_id: String,
    tab_id: String,
    surface_id: String,
    generation: u64,
) -> Result<Opened> {
    let _ = app;
    let ws = owned_workspace(&window, &plugin_id, &page_id, &tab_id).await?;
    detach(&window, &ws, &page_id, &tab_id, &surface_id, generation).await
}
#[tauri::command(rename_all = "snake_case")]
pub async fn sumi_close(
    app: tauri::AppHandle,
    window: WebviewWindow,
    plugin_id: String,
    page_id: String,
    tab_id: String,
) -> Result<()> {
    let _ = app;
    let ws = owned_workspace(&window, &plugin_id, &page_id, &tab_id).await?;
    close_owner(&ws,window.label(),&tab_id,&page_id).await
}
#[tauri::command(rename_all = "snake_case")]
pub async fn sumi_source_save(
    app: tauri::AppHandle,
    window: WebviewWindow,
    plugin_id: String,
    page_id: String,
    tab_id: String,
    base_revision: u64,
    raw: String,
) -> Result<Opened> {
    host_window(&window)?;
    authorize(&plugin_id)?;
    source_save(
        workspace(&app).await?.as_ref(),
        window.label(),
        &tab_id,
        &page_id,
        base_revision,
        &raw,
    )
    .await
}
#[tauri::command(rename_all = "snake_case")]
pub async fn sumi_rebase_draft(
    window: WebviewWindow,
    plugin_id: String,
    page_id: String,
    tab_id: String,
    submitted: String,
    accepted: String,
    draft: String,
) -> Result<write_core::import::DraftRebase> {
    let ws = owned_workspace(&window, &plugin_id, &page_id, &tab_id).await?;
    {
        let mut papers = ws.papers.lock().map_err(err)?;
        let p = papers.get_mut(&page_id).ok_or("missing page")?;
        if owner(p, window.label(), &tab_id, None)?.surface.is_some() {
            return Err("原生编辑面仍拥有此页".into());
        }
    }
    if [submitted.len(), accepted.len(), draft.len()]
        .into_iter()
        .any(|n| n > 8 * 1024 * 1024)
    {
        return Err("写作草稿过大".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        write_core::import::rebase_draft(&submitted, &accepted, &draft)
    })
    .await
    .map_err(err)
}
async fn surface_command<R: Runtime>(
    window: &WebviewWindow<R>,
    ws: &Workspace,
    page: &str,
    tab: &str,
    id: &str,
    generation: u64,
    command: native::SurfaceCommand,
) -> Result<()> {
    ws.writable()?;
    {
        let mut papers = ws.papers.lock().map_err(err)?;
        ws.writable()?;
        let p = papers.get_mut(page).ok_or("missing page")?;
        owner(p, window.label(), tab, Some((id, generation)))?;
    }
    native::command(window, id.to_owned(), generation, command).await
}
#[tauri::command(rename_all = "snake_case")]
pub async fn sumi_bounds(
    app: tauri::AppHandle,
    window: WebviewWindow,
    plugin_id: String,
    page_id: String,
    tab_id: String,
    surface_id: String,
    generation: u64,
    bounds: native::Bounds,
) -> Result<()> {
    host_window(&window)?;
    authorize(&plugin_id)?;
    surface_command(
        &window,
        workspace(&app).await?.as_ref(),
        &page_id,
        &tab_id,
        &surface_id,
        generation,
        native::SurfaceCommand::SetBounds { bounds },
    )
    .await
}
#[tauri::command(rename_all = "snake_case")]
pub async fn sumi_visible(
    app: tauri::AppHandle,
    window: WebviewWindow,
    plugin_id: String,
    page_id: String,
    tab_id: String,
    surface_id: String,
    generation: u64,
    visible: bool,
) -> Result<()> {
    host_window(&window)?;
    authorize(&plugin_id)?;
    surface_command(
        &window,
        workspace(&app).await?.as_ref(),
        &page_id,
        &tab_id,
        &surface_id,
        generation,
        native::SurfaceCommand::SetVisible { visible },
    )
    .await
}
#[tauri::command(rename_all = "snake_case")]
pub async fn sumi_focus(
    app: tauri::AppHandle,
    window: WebviewWindow,
    plugin_id: String,
    page_id: String,
    tab_id: String,
    surface_id: String,
    generation: u64,
) -> Result<()> {
    host_window(&window)?;
    authorize(&plugin_id)?;
    surface_command(
        &window,
        workspace(&app).await?.as_ref(),
        &page_id,
        &tab_id,
        &surface_id,
        generation,
        native::SurfaceCommand::Focus,
    )
    .await
}

/// Conservative synchronous exit gate: a contended session is still active.
pub fn has_sessions() -> bool {
    let Ok(workspaces) = WORKSPACES.try_lock() else {
        return true;
    };
    // A hidden/closed writing window may still have background synchronization
    // or accepted edits. It needs the same exit barrier as a visible surface.
    !workspaces.is_empty()
}

/// Main tabs keep their surface when hidden; the independent singleton releases
/// its writer after a successful flush so another entry can open that paper.
/// This admits no new text and is allowed after plugin/Vault revocation.
pub async fn before_close<R: Runtime>(app: &tauri::AppHandle<R>, label: &str) -> Result<()> {
    let plugin = is_plugin_window(label);
    if plugin {PLUGIN_WINDOW_HIDDEN.store(true, Ordering::Release);}
    let result = before_close_inner(app, label, plugin).await;
    if plugin {
        if result.is_ok() {push(app, &json!({"type":"sumi-window-state","visible":false,"detached":true}));}
        else {plugin_window_shown(app,label);}
    }
    result
}
async fn before_close_inner<R: Runtime>(app: &tauri::AppHandle<R>, label: &str, release: bool) -> Result<()> {
    let workspaces = WORKSPACES
        .lock()
        .await
        .values()
        .cloned()
        .collect::<Vec<_>>();
    for ws in workspaces {
        let _lease = ws.lifecycle.lock().await;
        if ws.phase.load(Ordering::Acquire)==QUIESCED { continue; }
        let owners = {
            let papers = ws.papers.lock().map_err(err)?;
            papers
                .iter()
                .filter_map(|(id, p)| {
                    p.owner
                        .clone()
                        .filter(|o| o.window == label)
                        .map(|o| (id.clone(), o))
                })
                .collect::<Vec<_>>()
        };
        for (page, o) in owners {
            if let Some(surface) = &o.surface {
                let window = app.get_webview_window(label).ok_or("编辑窗口已关闭")?;
                if release {
                    detach_locked(&window, &ws, &page, &o.tab, &surface.surface_id, surface.generation).await?;
                    if let Some(p)=ws.papers.lock().map_err(err)?.get_mut(&page) {p.owner=None;}
                    continue;
                }
                native::command(
                    &window,
                    surface.surface_id.clone(),
                    surface.generation,
                    native::SurfaceCommand::SetVisible { visible: false },
                )
                .await?;
                if let Err(error) = capture_native_position(&window, &ws, &page, &o.tab, &surface.surface_id, surface.generation).await {
                    let _ = native::command(&window, surface.surface_id.clone(), surface.generation, native::SurfaceCommand::SetVisible { visible: true }).await;
                    let _ = native::command(&window, surface.surface_id.clone(), surface.generation, native::SurfaceCommand::Focus).await;
                    return Err(error);
                }
                if let Some(p) = ws.papers.lock().map_err(err)?.get_mut(&page) {
                    if let Some(o) = p.owner.as_mut() {
                        o.composing = false;
                        o.suspended = true;
                    }
                }
                if let Err(error) = flush(
                    &ws,
                    label,
                    &o.tab,
                    &page,
                    Some((&surface.surface_id, surface.generation)),
                )
                .await
                {
                    if let Some(p) = ws.papers.lock().map_err(err)?.get_mut(&page) {
                        if let Some(o) = p.owner.as_mut() {
                            o.suspended = false;
                        }
                    }
                    let _ = native::command(
                        &window,
                        surface.surface_id.clone(),
                        surface.generation,
                        native::SurfaceCommand::SetVisible { visible: true },
                    )
                    .await;
                    let _ = native::command(
                        &window,
                        surface.surface_id.clone(),
                        surface.generation,
                        native::SurfaceCommand::Focus,
                    )
                    .await;
                    return Err(error);
                }
            } else {
                flush(&ws, label, &o.tab, &page, None).await?;
                if release {if let Some(p)=ws.papers.lock().map_err(err)?.get_mut(&page) {p.owner=None;}}
            }
        }
    }
    Ok(())
}
pub async fn resume_window<R: Runtime>(app: &tauri::AppHandle<R>, label: &str) -> Result<()> {
    let workspaces = WORKSPACES
        .lock()
        .await
        .values()
        .cloned()
        .collect::<Vec<_>>();
    for ws in workspaces {
        if current(app, &ws).is_err() {
            continue;
        }
        let _lease = ws.lifecycle.lock().await;
        let owners = {
            let papers = ws.papers.lock().map_err(err)?;
            papers
                .iter()
                .filter_map(|(id, p)| {
                    p.owner
                        .clone()
                        .filter(|o| {
                            o.window == label
                                && o.suspended
                                && !p.entry.deleted
                                && o.generation == p.entry.generation
                        })
                        .map(|o| (id.clone(), o))
                })
                .collect::<Vec<_>>()
        };
        for (page, o) in owners {
            if let Some(surface) = o.surface {
                let window = app.get_webview_window(label).ok_or("编辑窗口已关闭")?;
                native::command(
                    &window,
                    surface.surface_id,
                    surface.generation,
                    native::SurfaceCommand::SetVisible { visible: true },
                )
                .await?;
                if let Some(p) = ws.papers.lock().map_err(err)?.get_mut(&page) {
                    if let Some(o) = p.owner.as_mut() {
                        o.suspended = false;
                    }
                }
            }
        }
        sound::start(app, &ws).await;
    }
    Ok(())
}
async fn freeze_workspace(ws: &Workspace) -> Result<()> {
    if ws.phase.load(Ordering::Acquire)==QUIESCED { return Ok(()); }
    let _appearance=ws.appearance_changes.lock().await;
    flush_positions(ws,None).await?;
    // File projection may be blocked by an external edit. Its error is not a
    // failed SQLite commit: independently drain/load every persisted page before
    // accepting the handoff, and keep projected=false in the frozen snapshot.
    let projection_error=ws.durable.flush().await.err();
    if let Some(error)=projection_error {
        let entries=ws.durable.list().await?;
        if entries.is_empty() { return Err(error); }
        for entry in entries {
            let loaded=ws.durable.load(entry.id.clone()).await?;
            if let Some(p)=ws.papers.lock().map_err(err)?.get(&entry.id) {
                if loaded.revision!=p.doc.revision() { return Err("正文尚未完成持久化，不能停用".into()); }
            }
        }
    }
    let owners=ws.papers.lock().map_err(err)?.iter().filter_map(|(id,p)|p.owner.clone().map(|o|(id.clone(),o))).collect::<Vec<_>>();
    let mut snapshots=Vec::new();
    for (page,o) in owners {
        let snapshot=flush(ws,&o.window,&o.tab,&page,o.surface.as_ref().map(|s|(s.surface_id.as_str(),s.generation))).await?;
        snapshots.push((page,CleanupSnapshot{window:o.window,tab:o.tab,surface:o.surface,owner_generation:o.generation,snapshot}));
    }
    let mut papers=ws.papers.lock().map_err(err)?;
    for (page,snapshot) in snapshots { papers.get_mut(&page).ok_or("missing page")?.cleanup_snapshot=Some(snapshot); }
    ws.phase.store(QUIESCED,Ordering::Release);
    Ok(())
}

pub async fn before_exit<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<()> {
    let workspaces={
        let workspaces=WORKSPACES.lock().await;
        PLUGIN_QUIESCING.store(true,Ordering::Release);
        workspaces.values().cloned().collect::<Vec<_>>()
    };
    let active=workspaces.iter().filter(|ws|ws.phase.load(Ordering::Acquire)!=QUIESCED).cloned().collect::<Vec<_>>();
    if active.is_empty() { return Ok(()); }
    let mut labels=std::collections::HashSet::new();
    for ws in &active {
        let papers=ws.papers.lock().map_err(err)?;
        ws.phase.store(QUIESCING,Ordering::Release);
        for p in papers.values() { if let Some(o)=&p.owner { labels.insert(o.window.clone()); } }
    }
    for ws in &active { sound::stop(app, ws).await; }
    let result: Result<()> = async {
        for label in &labels { before_close(app,label).await?; }
        // Do not hold the lifecycle lease while callbacks/requests are joined.
        for ws in &active { if let Some(network)=ws.network.get() { network.stop().await?; } }
        for ws in &active {
            let _lease=ws.lifecycle.lock().await;
            freeze_workspace(ws).await?;
        }
        Ok(())
    }.await;
    if let Err(error)=result {
        PLUGIN_QUIESCING.store(false,Ordering::Release);
        for ws in &active {
            let mut papers=ws.papers.lock().map_err(err)?;
            for p in papers.values_mut() { p.cleanup_snapshot=None; }
            ws.phase.store(ACTIVE,Ordering::Release);
        }
        for ws in &active { if let Some(network)=ws.network.get() { let _=network.resume().await; } }
        for label in &labels { plugin_window_shown(app,label); let _=resume_window(app,label).await; }
        return Err(error);
    }
    Ok(())
}

/// Called only after replacement discovery has installed the new permission map.
/// No existing workspace means no plugin process is started.
async fn resume_workspace(ws: &Workspace) -> Result<Vec<String>> {
    let labels={
        let _lease=ws.lifecycle.lock().await;
        if ws.phase.load(Ordering::Acquire)!=QUIESCED { return Ok(Vec::new()); }
        let identities=ws.papers.lock().map_err(err)?.iter().map(|(id,p)|(id.clone(),p.entry.epoch,p.entry.generation,p.doc.revision())).collect::<Vec<_>>();
        for (id,epoch,generation,revision) in identities {
            let loaded=ws.durable.load(id).await?;
            if loaded.entry.epoch!=epoch || loaded.entry.generation!=generation || loaded.revision!=revision {
                return Err("Sumi 后台恢复状态与停用快照不一致，草稿已保留".into());
            }
        }
        let labels=ws.papers.lock().map_err(err)?.values().filter_map(|p|p.owner.as_ref().map(|o|o.window.clone())).collect::<Vec<_>>();
        ws.phase.store(ACTIVE,Ordering::Release);
        labels
    };
    if let Some(network)=ws.network.get() {
        if let Err(error)=network.resume().await {
            // Failure stays retryable without exposing a writable stopped editor.
            ws.phase.store(QUIESCED,Ordering::Release);
            return Err(error);
        }
    }
    Ok(labels)
}
pub async fn resume_plugin<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<()> {
    if authorize(PLUGIN).is_err() { return Ok(()); }
    let workspaces=WORKSPACES.lock().await.values().cloned().collect::<Vec<_>>();
    let mut labels=std::collections::HashSet::new();
    for ws in &workspaces { labels.extend(resume_workspace(ws).await?); }
    for label in labels { resume_window(app,&label).await?; }
    PLUGIN_QUIESCING.store(false,Ordering::Release);
    for ws in workspaces { if current(app, &ws).is_ok() { sound::start(app, &ws).await; } }
    Ok(())
}
/// Disable/uninstall must call this before changing plugin permission state.
/// Main-file tabs finish their own accepted-snapshot handoff through cleanup-only
/// commands; plugin windows are detached here before they can be destroyed.
pub async fn cleanup_plugin<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<()> {
    before_exit(app).await?;
    let result: Result<()> = async {
    let workspaces = WORKSPACES
        .lock()
        .await
        .values()
        .cloned()
        .collect::<Vec<_>>();
    for ws in workspaces {
        let _lease = ws.lifecycle.lock().await;
        let owners = {
            let papers = ws.papers.lock().map_err(err)?;
            papers
                .iter()
                .filter_map(|(id, p)| {
                    p.owner
                        .clone()
                        .filter(|o| o.window != "main")
                        .map(|o| (id.clone(), o))
                })
                .collect::<Vec<_>>()
        };
        for (page, o) in owners {
            if let Some(surface) = o.surface {
                if let Some(window) = app.get_webview_window(&o.window) {
                    detach_locked(
                        &window,
                        &ws,
                        &page,
                        &o.tab,
                        &surface.surface_id,
                        surface.generation,
                    )
                    .await?;
                }
            }
            if let Some(p) = ws.papers.lock().map_err(err)?.get_mut(&page) {
                p.owner = None;
            }
        }
    }
    Ok(())
    }.await;
    if let Err(original)=result {
        // No installation state has changed yet. A failed native detach must
        // restore the still-authorized editor instead of leaving it quiesced.
        return match resume_plugin(app).await {
            Ok(())=>Err(original),
            Err(restore)=>Err(format!("{original}；Sumi恢复仍未完成：{restore}")),
        };
    }
    Ok(())
}
async fn apply_appearance<R: Runtime>(
    app: &tauri::AppHandle<R>,
    ws: &Workspace,
    page: Option<&str>,
) -> Result<()> {
    // Serialize the snapshot, asynchronous font preparation and native apply.
    // A slower old request must never repaint over a later selected font/theme.
    let _appearance = ws.appearance_changes.lock().await;
    let appearance = ws.preferences.lock().map_err(err)?.appearance();
    let owners = {
        let papers = ws.papers.lock().map_err(err)?;
        papers
            .iter()
            .filter(|(id, _)| page.is_none_or(|page| page == id.as_str()))
            .filter_map(|(_, p)| p.owner.clone().filter(|o| o.surface.is_some()))
            .collect::<Vec<_>>()
    };
    for o in owners {
        let window = app.get_webview_window(&o.window).ok_or("编辑窗口已关闭")?;
        let appearance = ensure_font(app, &window, &appearance).await?;
        let surface = o.surface.unwrap();
        if let Err(error) = native::command(
            &window,
            surface.surface_id,
            surface.generation,
            native::SurfaceCommand::SetAppearance {
                appearance: appearance.clone(),
            },
        )
        .await
        {
            if error != "composition active" {
                return Err(error);
            }
        }
    }
    Ok(())
}

fn pairing_request(params: &Value) -> Result<(String, sync::Invitation)> {
    let server = params["serviceUrl"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or("缺少同步服务地址")?;
    let encoded = params["invitation"].as_str().ok_or("缺少设备配对码")?;
    let invitation = serde_json::from_str(encoded.trim())
        .map_err(|_| "设备配对码格式无效，请完整复制配对码".to_owned())?;
    Ok((server.trim().to_owned(), invitation))
}

fn invitation_response(invitation: &sync::Invitation) -> Result<Value> {
    Ok(json!({"invitation": serde_json::to_string(invitation).map_err(err)?}))
}

async fn document_command<R: Runtime>(app: &tauri::AppHandle<R>, ws: &Arc<Workspace>, page: &str, window: &str, tab: &str, action: &str) -> Result<()> {
    authorize(PLUGIN)?;
    let _lease=ws.lifecycle.lock().await;
    current(app,ws)?;
    let surface={
        let papers=ws.papers.lock().map_err(err)?;
        let p=papers.get(page).ok_or("纸页已关闭")?;
        let owner=p.owner.as_ref().filter(|o|o.window==window && o.tab==tab).ok_or("编辑面已切换")?;
        if owner.composing{return Err("请先完成输入法组合".into());}
        owner.surface.clone()
    };
    if action=="save" {
        flush(ws,window,tab,page,surface.as_ref().map(|s|(s.surface_id.as_str(),s.generation))).await?;
    } else {
        let _appearance = ws.appearance_changes.lock().await;
        let mut prefs=ws.preferences.lock().map_err(err)?.clone();
        prefs.font_size=match action {"zoom_in"=>(prefs.font_size+2.).min(96.),"zoom_out"=>(prefs.font_size-2.).max(8.),"zoom_reset"=>Preferences::default().font_size,_=>return Err("不支持的写作命令".into())};
        prefs.validate()?;
        ws.durable.set_preferences("appearance".into(),serde_json::to_value(&prefs).map_err(err)?).await?;
        *ws.preferences.lock().map_err(err)?=prefs;
        drop(_appearance);
        apply_appearance(app,ws,None).await?;
    }
    if let Ok(state)=state_value(ws).await {push(app,&json!({"type":"sumi-state","state":state}));}
    Ok(())
}
fn menu_action(id: &str) -> Option<&'static str> {
    Some(match id {
        "new"=>"new_page", "open"=>"menu", "save"=>"save", "save-as"=>"export", "close-tab"=>"close",
        "preferences"=>"settings", "find"=>"find", "find-replace"=>"replace", "open-smart-search"=>"link",
        "zoom-in"=>"zoom_in", "zoom-out"=>"zoom_out", "zoom-reset"=>"zoom_reset", "select-all"=>"select_all",
        "file-undo"=>"undo", "file-redo"=>"redo", _=>return None,
    })
}
/// Called synchronously from the native menu event on the main thread. AppKit
/// first responder is the authority, never a stale DOM "last focused" flag.
pub fn handle_menu_event<R: Runtime>(app: &tauri::AppHandle<R>, id: &str) -> bool {
    let Some(action)=menu_action(id) else{return false;};
    if native::menu_command(action){return true;}
    let label=crate::plugin_runtime::windows::window_label(PLUGIN,"main");
    let Some(_window)=app.get_webview_window(&label).filter(|w|w.is_focused().unwrap_or(false)) else{return false;};
    // With the native surface hidden, ordinary controls retain their text-edit
    // responders. Document menu commands still belong to this writing window.
    if matches!(action,"new_page"|"menu"|"save"|"export"|"close"|"settings"|"zoom_in"|"zoom_out"|"zoom_reset") {
        push(app,&json!({"type":"sumi-action","action":action}));
    } else if matches!(action,"select_all"|"undo"|"redo") {
        native::menu_command(&format!("input:{action}"));
    }
    // Other host-only commands (such as Smart Search) cannot target the main
    // document while the Sumi window owns focus.
    true
}

pub async fn dispatch<R: Runtime>(
    app: &tauri::AppHandle<R>,
    plugin: &str,
    method: &str,
    params: &Value,
) -> Result<Value> {
    authorize(plugin)?;
    if method == "host.sumi.state" && !native::is_supported() {
        return Ok(
            json!({"available":false,"reason":"Sumi 原生编辑需要 macOS 13 或更新版本","pages":[],"activePageId":null,"preferences":Preferences::default(),"sync":{"connected":false,"pending":0},"saveState":"saved"}),
        );
    }
    let ws = workspace(app).await?;
    let window = app
        .get_webview_window(&crate::plugin_runtime::windows::window_label(
            PLUGIN, "main",
        ))
        .ok_or("Sumi 窗口未打开")?;
    let tab = "sumi-focus";
    let text = |name: &str| {
        params
            .get(name)
            .and_then(Value::as_str)
            .ok_or_else(|| format!("缺少参数 {name}"))
    };
    let page = || text("pageId");
    match method {
        "host.sumi.sound_state" | "host.sumi.sound_set" | "host.sumi.sound_request_permission" => sound::dispatch(app, &ws, method, params).await,
        "host.sumi.state" => state_value(&ws).await,
        "host.sumi.fonts" => font_status(&ws, &font_manager(app)?).await,
        "host.sumi.font_select" => select_font(app, &ws, text("fontFamily")?).await,
        "host.sumi.command" => {
            let action=text("action")?;
            if action=="close" {
                before_close(app,window.label()).await?;
                window.hide().map_err(err)?;
            } else {
                let page=ws.active.lock().map_err(err)?.clone().ok_or("没有当前纸页")?;
                document_command(app,&ws,&page,window.label(),tab,action).await?;
            }
            Ok(Value::Null)
        }
        "host.sumi.page" => {
            let action = text("action")?;
            // Download the likely surviving page before accepting an active
            // deletion. Offline failure must leave the current page undeleted.
            if action == "delete" {
                let active = ws.active.lock().map_err(err)?.clone();
                let target = page()?;
                if active.as_deref() == Some(target) {
                    let entries = ws.durable.list().await?;
                    if let Some(next) = adjacent_after_delete(&entries, target) {
                        prepare_page(&ws, &next).await?;
                    }
                }
            }
            let _lease = ws.lifecycle.lock().await;
            ws.writable()?;
            let old = ws.active.lock().map_err(err)?.clone();
            // Client must finish its existing surface before navigation mutates
            // catalog or active-page state. IME refusal leaves both unchanged.
            if ws.papers.lock().map_err(err)?.values().any(|p| p.owner.as_ref().is_some_and(|o| o.window == window.label() && (o.surface.is_some() || o.composing))) {
                return Err("请先完成当前输入并保存纸页，再切换".into());
            }
            let request_id = if matches!(action,"create"|"next"|"delete") { Some(text("requestId")?) } else { None };
            let requested_after = params.get("fromPageId").and_then(Value::as_str).map(str::to_owned);
            if let Some(request_id) = request_id {
                let after = if action == "delete" { Some(page()?.to_owned()) } else { requested_after.clone() };
                if let Some(loaded) = existing_creation(&ws,request_id,&after,action).await? {
                    let id=loaded.entry.id.clone();
                    ws.papers.lock().map_err(err)?.entry(id.clone()).or_insert(Paper::from_loaded(loaded)?);
                    activate_page(&ws,&id).await?;
                    return state_value(&ws).await;
                }
            }
            if let Some(expected) = params.get("fromPageId") {
                if expected.as_str() != old.as_deref() { return Err("纸页已在其他操作中切换，请刷新后继续".into()); }
            }
            let id = match action {
                "create" => create_paper(app, &ws, request_id.unwrap(), old.clone(), action).await?,
                "open" => {
                    let id = page()?.to_owned();
                    if !ws.durable.list().await?.iter().any(|e| e.id == id && !e.deleted) { return Err("纸页不存在或已在废纸篓".into()); }
                    id
                }
                "next" | "previous" => {
                    let pages = ws.durable.list().await?.into_iter().filter(|p| !p.deleted).collect::<Vec<_>>();
                    let position = pages.iter().position(|p| Some(&p.id) == old.as_ref());
                    let next = position.and_then(|i| if action == "next" { pages.get(i+1) } else { i.checked_sub(1).and_then(|i| pages.get(i)) });
                    match next { Some(e) => e.id.clone(), None if action == "next" => create_paper(app, &ws, request_id.unwrap(), old.clone(), action).await?, None => old.clone().ok_or("没有上一页")? }
                }
                "delete" | "restore" => {
                    let target = page()?.to_owned();
                    let entries = ws.durable.list().await?;
                    let existing = entries.iter().find(|e| e.id == target).ok_or("纸页不存在")?;
                    if ws.papers.lock().map_err(err)?.get(&target).is_some_and(|p| p.owner.is_some()) { return Err("请先关闭此页的其他编辑面，草稿不会被自动丢弃".into()); }
                    // Retried delete/restore does not advance generation twice.
                    let deleted = action == "delete";
                    if existing.deleted != deleted {
                        let entry = ws.durable.set_deleted(target.clone(), deleted).await?;
                        if let Some(p) = ws.papers.lock().map_err(err)?.get_mut(&target) { p.entry = entry; }
                    }
                    if !deleted { target }
                    else if old.as_deref() != Some(target.as_str()) {
                        old.clone().ok_or("没有当前纸页")?
                    } else if let Some(next) = adjacent_after_delete(&entries, &target) { next }
                    else {
                        // A previous attempt may already have made a blank page
                        // before its response was lost; reuse it on retry.
                        let available = ws.durable.list().await?.into_iter().find(|e| !e.deleted);
                        match available { Some(entry) => entry.id, None => create_paper(app, &ws, request_id.unwrap(), Some(target), action).await? }
                    }
                }
                _ => return Err("未知纸页操作".into()),
            };
            let target = ws.durable.list().await?.into_iter().find(|p| p.id == id && !p.deleted).ok_or("纸页不存在或已删除")?;
            drop(_lease);
            prepare_page(&ws, &id).await?;
            let _lease = ws.lifecycle.lock().await;
            current(app, &ws)?;
            if *ws.active.lock().map_err(err)? != old { return Err("同步期间纸页已切换，已保留原稿；请重新选择目标页".into()); }
            let latest = ws.durable.list().await?.into_iter().find(|p| p.id == id && !p.deleted).ok_or("同步期间目标纸页已删除")?;
            if latest.epoch != target.epoch || latest.generation != target.generation { return Err("同步期间页面生命周期已变化，请重新打开".into()); }
            ensure(&ws, &id).await?;
            activate_page(&ws, &id).await?;
            state_value(&ws).await
        }
        "host.sumi.restore_projection" => {
            restore_projection(app, &window, &ws, page()?, Some(tab)).await
        }
        "host.sumi.focus_existing" => {
            focus_existing(app, &ws, page()?).await?;
            Ok(json!({"requested":true}))
        }
        "host.sumi.mount" => {
            let bounds = serde_json::from_value(params["bounds"].clone()).map_err(err)?;
            match mount(app, &ws, &window, page()?, tab, bounds).await? {
                EditorEntry::Opened(s)=>Ok(json!({"id":s.surface_id,"generation":s.generation})),
                existing=>serde_json::to_value(existing).map_err(err),
            }
        }
        "host.sumi.detach" | "host.sumi.bounds" | "host.sumi.visible" | "host.sumi.focus" => {
            let id = params["surface"]["id"].as_str().ok_or("缺少编辑面身份")?;
            let generation = params["surface"]["generation"]
                .as_u64()
                .ok_or("缺少编辑面版本")?;
            let page = {
                let papers = ws.papers.lock().map_err(err)?;
                papers
                    .iter()
                    .find(|(_, p)| {
                        p.owner
                            .as_ref()
                            .and_then(|o| o.surface.as_ref())
                            .is_some_and(|s| s.surface_id == id && s.generation == generation)
                    })
                    .map(|(id, _)| id.clone())
                    .ok_or("编辑面已过期")?
            };
            if method == "host.sumi.detach" {
                detach(&window, &ws, &page, tab, id, generation).await?;
                ws.papers.lock().map_err(err)?.get_mut(&page).unwrap().owner = None;
            } else {
                let command = match method {
                    "host.sumi.bounds" => native::SurfaceCommand::SetBounds {
                        bounds: serde_json::from_value(params["bounds"].clone()).map_err(err)?,
                    },
                    "host.sumi.visible" => {
                        let visible = params["visible"].as_bool().ok_or("缺少可见性")?;
                        if !visible && params["preparePanel"].as_bool() == Some(true) {
                            native::SurfaceCommand::PreparePanel
                        } else {
                            native::SurfaceCommand::SetVisible { visible }
                        }
                    },
                    _ => native::SurfaceCommand::Focus,
                };
                surface_command(&window, &ws, &page, tab, id, generation, command).await?;
            }
            Ok(Value::Null)
        }
        "host.sumi.preferences" => {
            let prefs: Preferences = serde_json::from_value(params["preferences"].clone()).map_err(err)?;
            save_appearance(&ws, prefs, params["preserveFont"].as_bool() == Some(true)).await?;
            apply_appearance(app, &ws, None).await?;
            state_value(&ws).await
        }
        "host.sumi.fullscreen" => {
            let current = window.is_fullscreen().map_err(err)?;
            if params["queryOnly"].as_bool() == Some(true) {
                Ok(json!({"fullscreen": current}))
            } else {
                window.set_fullscreen(!current).map_err(err)?;
                Ok(json!({"fullscreen": !current}))
            }
        }
        "host.sumi.pair" => {
            let (server, invitation) = pairing_request(params)?;
            ws.network
                .get()
                .ok_or("同步连接正在初始化")?
                .pair(server, invitation)
                .await?;
            state_value(&ws).await
        }
        "host.sumi.invite" => invitation_response(
            &ws.network
                .get()
                .ok_or("同步连接正在初始化")?
                .invite()
                .await?,
        ),
        "host.sumi.export" => {
            let page = page()?.to_owned();
            let format = text("format")?.to_owned();
            {
                let _lease = ws.lifecycle.lock().await;
                let owned = ws
                    .papers
                    .lock()
                    .map_err(err)?
                    .get(&page)
                    .and_then(|p| p.owner.clone());
                if let Some(owner) = owned {
                    if owner.window != window.label() || owner.tab != tab {
                        return Err("请先在当前编辑面保存此页，再从 Sumi 导出".into());
                    }
                    flush(
                        &ws,
                        window.label(),
                        tab,
                        &page,
                        owner
                            .surface
                            .as_ref()
                            .map(|s| (s.surface_id.as_str(), s.generation)),
                    )
                    .await?;
                }
            }
            let loaded = ws.durable.load(page).await?;
            Ok(json!({"saved": export::save(app, loaded, format).await?}))
        }
        _ => Err("METHOD_NOT_FOUND".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn writing_menu_mapping_and_editor_actions_are_explicit() {
        for (id,action) in [("new","new_page"),("open","menu"),("preferences","settings"),("close-tab","close"),("save","save"),("save-as","export"),("find-replace","replace"),("open-smart-search","link"),("zoom-in","zoom_in")] {
            assert_eq!(menu_action(id),Some(action));
        }
        assert_eq!(menu_action("tray-quit"),None);
        for action in ["heading1","heading6","paragraph","quote","bullet_list","ordered_list","indent","outdent","hard_break","link_begin","link_set:https://example.com"] {assert!(is_editor_action(action));}
        assert!(!is_editor_action("new_page"));
    }
    #[tokio::test]
    async fn keyboard_formats_and_link_sheet_keep_canonical_identity() {
        let (_temp,ws,page)=fixture().await;
        let mut papers=ws.papers.lock().unwrap();let p=papers.get_mut(&page).unwrap();
        p.doc.replace(0,0,0,"word\nother",1).unwrap();p.view=SourceMap::new(&p.doc.body(),p.doc.revision());
        apply_action(p,"heading2",native::TextRange{start:0,length:0},2).unwrap();
        assert!(p.doc.body().starts_with("## word"));
        apply_action(p,"link_begin",native::TextRange{start:0,length:4},3).unwrap();
        // A remote-equivalent insertion before the captured selection must not
        // make the later dialog response link the wrong UTF-16 range.
        p.doc.replace(p.doc.revision(),0,0,"prefix\n",4).unwrap();p.view=SourceMap::new(&p.doc.body(),p.doc.revision());
        apply_action(p,"link_set:https://example.com",native::TextRange{start:0,length:0},5).unwrap();
        assert!(p.doc.body().contains("[word](<https://example.com>)"));
        assert!(p.pending_link.is_none());
        assert!(apply_action(p,"link_set:https://wrong.example",native::TextRange::default(),6).is_err());
        let visible=p.view.document.text.encode_utf16().count() as u32;
        apply_action(p,"hard_break",native::TextRange{start:visible,length:0},7).unwrap();
        assert!(p.doc.body().ends_with("  \n"));
        assert_eq!(p.owner.as_ref().unwrap().selection.start,p.view.document.text.encode_utf16().count() as u32);
        let caret=p.owner.as_ref().unwrap().selection.start;
        apply_input(p,&write_core::render::TextRange{start:caret,length:0},"next",false,8).unwrap();
        assert!(p.doc.body().ends_with("  \nnext"));
    }
    #[tokio::test]
    async fn retired_fonts_migrate_durably_without_resetting_other_preferences() {
        let (_temp, ws, _page) = fixture().await;
        assert_eq!(Preferences::default().appearance().font_family, "Sumi Plex");
        assert_eq!(load_preferences(&ws.durable).await.unwrap().font_family, "Sumi Plex");
        for (font, expected_font) in [
            ("Sumi Typewriter", "Sumi Plex"), ("Source Han Serif SC", "Sumi Plex"),
            ("Helvetica", "Sumi Plex"), ("", "Sumi Plex"), ("Sumi Elite", "Sumi Plex"),
            ("Sumi Plex", "Sumi Plex"), ("Sumi WenKai", "Sumi WenKai"),
            ("Sumi Zhaohua", "Sumi Zhaohua"), ("Sumi Youcha", "Sumi Youcha"),
            ("Sumi Fangsong", "Sumi Fangsong"),
        ] {
            let saved = json!({"theme":"sepia","fontFamily":font,"fontSize":50.,"lineHeight":1.6,"maxColumns":80,"bottomInset":0.});
            let original: Preferences = serde_json::from_value(saved.clone()).unwrap();
            let retired = font != expected_font;
            assert_eq!(original.validate().is_err(), retired);
            ws.durable.set_preferences("appearance".into(), saved.clone()).await.unwrap();
            let preferences = load_preferences(&ws.durable).await.unwrap();
            preferences.validate().unwrap();
            let mut expected = saved;
            expected["fontFamily"] = json!(expected_font);
            expected["caretMotion"] = json!("breathing");
            assert_eq!(serde_json::to_value(preferences).unwrap(), expected);
            assert_eq!(ws.durable.preferences("appearance".into()).await.unwrap(), Some(expected.clone()));
            assert_eq!(serde_json::to_value(load_preferences(&ws.durable).await.unwrap()).unwrap(), expected);
        }
    }
    #[tokio::test]
    async fn caret_motion_defaults_and_survives_reopening_without_resetting_appearance() {
        let (temp, ws, _page) = fixture().await;
        let legacy = json!({"theme":"sepia","fontFamily":"Sumi Fangsong","fontSize":50.,"lineHeight":1.6,"maxColumns":80,"bottomInset":17.});
        ws.durable.set_preferences("appearance".into(), legacy.clone()).await.unwrap();
        let migrated = load_preferences(&ws.durable).await.unwrap();
        migrated.validate().unwrap();
        assert!(matches!(migrated.appearance().caret_motion, native::CaretMotion::Breathing));
        let mut expected = legacy;
        expected["caretMotion"] = json!("breathing");
        assert_eq!(serde_json::to_value(&migrated).unwrap(), expected);
        assert_eq!(ws.durable.preferences("appearance".into()).await.unwrap(), Some(expected.clone()));
        for invalid in ["blink", "", "Breathing", "STEADY"] {
            let mut prefs = migrated.clone();
            prefs.caret_motion = invalid.into();
            assert!(prefs.validate().is_err());
        }
        let mut steady = migrated;
        steady.caret_motion = "steady".into();
        steady.theme = "crt-blue".into();
        steady.validate().unwrap();
        expected["caretMotion"] = json!("steady");
        expected["theme"] = json!("crt-blue");
        ws.durable.set_preferences("appearance".into(), serde_json::to_value(&steady).unwrap()).await.unwrap();
        let root=ws.root.clone();
        drop(ws);
        let reopened = Durability::open(root, temp.path().join("sumi.sqlite3"), |_| {}).await.unwrap();
        let restored = load_preferences(&reopened).await.unwrap();
        assert_eq!(serde_json::to_value(&restored).unwrap(), expected);
        assert!(matches!(restored.appearance().caret_motion, native::CaretMotion::Steady));
        assert_eq!(restored.appearance().foreground, "#7fb4ff");
        assert_eq!(restored.appearance().background, "#000000");
        assert_eq!(serde_json::to_value(load_preferences(&reopened).await.unwrap()).unwrap(), expected);
    }
    #[test]
    fn font_catalog_contains_only_selected_presets() {
        let manifest: Value = serde_json::from_str(include_str!("../../../plugins-src/write/resources/sumi/manifest.json")).unwrap();
        for alias in manifest["cascades"].as_object().unwrap().keys() { assert!(fonts::known_font(alias)); }
        assert!(!fonts::known_font("Sumi Elite"));
        assert!(!fonts::known_font("../../other-font"));
    }
    #[test]
    fn pairing_ui_roundtrips_the_complete_invitation_without_exposing_invalid_input() {
        let invitation = sync::Invitation {
            space_id: Uuid::new_v4().to_string(),
            code: "test-only-invitation".into(),
            expires_at: 123456,
        };
        let response = invitation_response(&invitation).unwrap();
        let (url, decoded) = pairing_request(&json!({
            "serviceUrl": " https://sumi.example.test ",
            "invitation": response["invitation"],
        }))
        .unwrap();
        assert_eq!(url, "https://sumi.example.test");
        assert_eq!(decoded.space_id, invitation.space_id);
        assert_eq!(decoded.code, invitation.code);
        assert_eq!(decoded.expires_at, invitation.expires_at);
        let error =
            pairing_request(&json!({"serviceUrl": url, "invitation": "secret-in-malformed-json"}))
                .unwrap_err();
        assert!(!error.contains("secret-in-malformed-json"));
        assert!(pairing_request(&json!({"server": url, "invitation": invitation})).is_err());
    }
    #[test]
    fn deleting_current_page_selects_next_then_previous_and_never_deleted_page() {
        let entry = |id: &str, deleted| Entry { id: id.into(), epoch: 1, generation: 0, deleted, local_date: None, sequence: None, after_id: None, registered: false };
        let pages = vec![entry("a",false),entry("b",false),entry("trash",true),entry("c",false)];
        assert_eq!(adjacent_after_delete(&pages,"b").as_deref(),Some("c"));
        assert_eq!(adjacent_after_delete(&pages,"c").as_deref(),Some("b"));
        assert_eq!(adjacent_after_delete(&[entry("only",false)],"only"),None);
    }
    #[tokio::test]
    async fn filename_reallocation_names_all_relocated_pages_and_cannot_rebind_the_old_tab() {
        let (_temp, ws, original) = fixture().await;
        let id = Uuid::new_v4().to_string();
        let mut local = Document::new(&id, 1, 77).unwrap();
        local.replace(0, 0, 0, "recovered draft 中文", 100).unwrap();
        let loaded = ws.durable.create(durability::Create {
            page_id: id.clone(), epoch: 1, full_state: local.encode_full(), revision: local.revision(),
            after_id: None, first_write_date: Some("2026-11-08".into()), frontmatter: None, preserved_pair: None,
        }).await.unwrap();
        let old = loaded.entry.clone();
        let before = ws.durable.list().await.unwrap();
        let remote = Entry {id:Uuid::new_v4().to_string(),epoch:1,generation:0,deleted:false,
            local_date:old.local_date.clone(),sequence:old.sequence,after_id:None,registered:true};
        let changed = ws.durable.apply_directory(remote.clone()).await.unwrap();
        assert_eq!(renamed_pages(&before,&changed),vec![(id.clone(),old.filename().unwrap())]);
        let reallocated = changed.iter().find(|entry|entry.id==id).unwrap();
        assert_ne!(reallocated.filename(),old.filename());
        let (path,_) = write_core::projection::paths(&ws.root,&reallocated.filename().unwrap()).unwrap();
        assert!(std::fs::read_to_string(path).unwrap().ends_with("recovered draft 中文"));
        let papers=ws.papers.lock().unwrap();
        let owner=papers[&original].owner.as_ref().unwrap();
        assert!(check_open_identity(&papers,"main","test",&remote.id,Some(&original)).is_err());
        assert!(check_open_identity(&papers,"main","test",&remote.id,None).is_err());
        assert!(check_open_identity(&papers,"main","other",&remote.id,Some(&original)).is_err());
        assert!(check_open_identity(&papers,"main","test",&original,Some(&original)).is_ok());
        assert_eq!(papers.len(),1);assert_eq!(owner.tab,"test");assert!(owner.surface.is_none());
    }
    #[tokio::test]
    async fn focus_owner_rechecks_bound_identity_without_changing_document_or_selection() {
        let (_temp,ws,id)=fixture().await;
        let mut papers=ws.papers.lock().unwrap();
        let p=papers.get_mut(&id).unwrap();
        p.owner.as_mut().unwrap().selection=native::TextRange{start:0,length:0};
        let revision=p.doc.revision();let body=p.doc.body();
        let owner=focus_owner_identity(p,Some(("main","test"))).unwrap();
        assert_eq!(owner.tab,"test");assert_eq!(p.doc.revision(),revision);assert_eq!(p.doc.body(),body);
        assert!(focus_owner_identity(p,Some(("other-window","test"))).is_err());
        assert!(focus_owner_identity(p,Some(("main","other-tab"))).is_err());
        p.owner.as_mut().unwrap().composing=true;
        assert!(focus_owner_identity(p,Some(("main","test"))).unwrap().composing,"focusing the existing IME must not commit or cancel it");
        p.entry.generation+=1;assert!(focus_owner_identity(p,None).is_err());
        p.entry.generation-=1;p.entry.deleted=true;assert!(focus_owner_identity(p,None).is_err());
        assert_eq!(crate::plugin_runtime::host_api::method_capability("host.sumi.focus_existing"),Some("editor.native"));
        let wire=serde_json::to_value(existing_editor::<Surface>(&id)).unwrap();
        assert_eq!(wire,json!({"kind":"existing_owner","page_id":id}));
        assert!(wire.get("surface_id").is_none());assert!(wire.get("window").is_none());
    }
    #[tokio::test]
    async fn reloaded_mount_recovers_only_the_same_live_authorized_owner() {
        let (_temp, ws, id) = fixture().await;
        let _registry = crate::plugin_runtime::lifecycle::REGISTRY_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        struct RestoreRegistry(Option<(plugin_protocol::ManifestV2, PathBuf)>);
        impl Drop for RestoreRegistry {
            fn drop(&mut self) {
                let mut state = crate::plugin_runtime::STATE.write().unwrap();
                state.plugins.remove(PLUGIN);
                if let Some(previous) = self.0.take() { state.plugins.insert(PLUGIN.into(), previous); }
            }
        }
        let manifest = serde_json::from_value(json!({
            "manifest_version":2,"id":PLUGIN,"name":"Sumi reload fixture","version":"0.1.0",
            "kind":"native","engines":{"notemd":">=0.0.0"},"activation":{"events":["onCommand:open"]},
            "capabilities":["editor.native","editor.write","vault.read","vault.write"]
        })).unwrap();
        let _restore = RestoreRegistry(crate::plugin_runtime::STATE.write().unwrap().plugins.insert(PLUGIN.into(), (manifest, PathBuf::from("/tmp/sumi-reload-fixture"))));
        let surface = Surface { surface_id: "existing-native-owner".into(), generation: 7 };
        let baseline = {
            let mut papers = ws.papers.lock().unwrap(); let p = papers.get_mut(&id).unwrap();
            let owner = p.owner.as_mut().unwrap();owner.surface = Some(surface.clone());owner.composing = true;
            owner.selection = native::TextRange { start:0,length:0 };owner.viewport = native::Viewport { start:0,offset:17. };
            (p.doc.encode_full(), p.doc.revision())
        };
        for _ in 0..2 {
            let Some(EditorEntry::Opened(recovered)) = existing_mount_decision(&ws,&id,"main","test").unwrap() else { panic!("same owner was not recovered"); };
            assert!(recovered == surface);
        }
        for (window,tab) in [("another-window","test"),("main","another-tab")] {
            let result = existing_mount_decision(&ws,&id,window,tab).unwrap().unwrap();
            assert_eq!(serde_json::to_value(result).unwrap(),json!({"kind":"existing_owner","page_id":id}));
        }
        {
            let papers=ws.papers.lock().unwrap();let p=&papers[&id];let owner=p.owner.as_ref().unwrap();
            assert_eq!(p.doc.encode_full(),baseline.0);assert_eq!(p.doc.revision(),baseline.1);
            assert!(owner.composing);assert_eq!(owner.selection.start,0);assert_eq!(owner.selection.length,0);assert_eq!(owner.viewport.offset,17.);
        }
        {
            let mut papers=ws.papers.lock().unwrap();let p=papers.get_mut(&id).unwrap();p.entry.generation+=1;
        }
        assert!(existing_mount_decision(&ws,&id,"main","test").is_err());
        {let mut papers=ws.papers.lock().unwrap();let p=papers.get_mut(&id).unwrap();p.entry.generation-=1;p.entry.deleted=true;}
        assert!(existing_mount_decision(&ws,&id,"main","test").is_err());
        ws.papers.lock().unwrap().get_mut(&id).unwrap().entry.deleted=false;
        for phase in [QUIESCING,QUIESCED] {ws.phase.store(phase,Ordering::Release);assert!(existing_mount_decision(&ws,&id,"main","test").is_err());}
        ws.phase.store(ACTIVE,Ordering::Release);
        let plugin_window=crate::plugin_runtime::windows::window_label(PLUGIN,"main");
        ws.papers.lock().unwrap().get_mut(&id).unwrap().owner.as_mut().unwrap().window=plugin_window.clone();
        assert!(matches!(existing_mount_decision(&ws,&id,&plugin_window,"test").unwrap(),Some(EditorEntry::Opened(_))));
        *ws.active.lock().unwrap()=Some("another-page".into());
        assert!(existing_mount_decision(&ws,&id,&plugin_window,"test").is_err());
        *ws.active.lock().unwrap()=Some(id.clone());
        crate::plugin_runtime::STATE.write().unwrap().plugins.get_mut(PLUGIN).unwrap().0.capabilities.retain(|cap|cap!="editor.native");
        assert!(existing_mount_decision(&ws,&id,&plugin_window,"test").is_err());
        crate::plugin_runtime::STATE.write().unwrap().plugins.remove(PLUGIN);
        assert!(existing_mount_decision(&ws,&id,&plugin_window,"test").is_err());
    }
    #[tokio::test]
    async fn navigation_versions_change_only_after_durable_active_page_changes() {
        let (_temp,ws,id)=fixture().await;
        ws.papers.lock().unwrap().get_mut(&id).unwrap().owner.as_mut().unwrap().typing_style=Some(write_core::render::TypingStyle{bold:true,..Default::default()});
        activate_page(&ws,&id).await.unwrap();assert_eq!(ws.navigation_version.load(Ordering::Acquire),1);
        assert!(ws.papers.lock().unwrap()[&id].owner.as_ref().unwrap().typing_style.is_some(),"same-page refresh preserves input intent");
        activate_page(&ws,"other").await.unwrap();assert_eq!(ws.navigation_version.load(Ordering::Acquire),2);
        assert!(ws.papers.lock().unwrap()[&id].owner.as_ref().unwrap().typing_style.is_none(),"switching away clears a retained tab owner");
        assert_eq!(ws.durable.preferences("activePage".into()).await.unwrap(),Some(json!("other")));
        activate_page(&ws,"other").await.unwrap();assert_eq!(ws.navigation_version.load(Ordering::Acquire),2);
    }
    #[tokio::test]
    async fn typing_style_is_ephemeral_and_preserved_through_ime_commit() {
        let (_temp, ws, id) = fixture().await;
        let mut papers = ws.papers.lock().unwrap(); let paper = papers.get_mut(&id).unwrap();
        let before = paper.doc.snapshot().unwrap(); let revision = paper.doc.revision();
        assert!(apply_action(paper, "bold", native::TextRange::default(), 2).unwrap().is_none());
        assert!(apply_action(paper, "italic", native::TextRange::default(), 3).unwrap().is_none());
        assert_eq!(paper.doc.snapshot().unwrap(), before); assert_eq!(paper.doc.revision(), revision);
        paper.owner.as_mut().unwrap().composing = true;
        update_input_selection(paper, native::TextRange { start: 0, length: 0 });
        assert!(paper.owner.as_ref().unwrap().typing_style.unwrap().bold);
        apply_input(paper, &write_core::render::TextRange::default(), "中文😀", false, 4).unwrap();
        assert_eq!(paper.doc.revision(), revision + 1); assert_eq!(paper.view.document.text, "中文😀");
        assert!(paper.view.document.runs.iter().any(|r| r.bold && r.italic));
        paper.owner.as_mut().unwrap().composing = false;
        let selection = paper.owner.as_ref().unwrap().selection.clone(); update_input_selection(paper, selection.clone());
        assert!(paper.owner.as_ref().unwrap().typing_style.is_some(), "post-commit selection echo keeps input intent");
        apply_action(paper, "undo", selection, 5).unwrap(); assert_eq!(paper.doc.body(), "");
        assert!(paper.owner.as_ref().unwrap().typing_style.is_none());
    }
    #[tokio::test]
    async fn typing_style_clears_on_navigation_and_lf_and_styles_paste_once() {
        let (_temp, ws, id) = fixture().await;
        let mut papers = ws.papers.lock().unwrap(); let paper = papers.get_mut(&id).unwrap();
        apply_action(paper, "bold", native::TextRange::default(), 2).unwrap();
        apply_input(paper, &write_core::render::TextRange::default(), "*paste*", true, 3).unwrap();
        assert_eq!(paper.view.document.text, "paste"); assert!(paper.view.document.runs.iter().any(|r| r.bold && r.italic));
        let selection = paper.owner.as_ref().unwrap().selection.clone();
        apply_action(paper, "bold", selection.clone(), 4).unwrap();
        apply_input(paper, &write_core::render::TextRange { start: selection.start, length: 0 }, "plain", false, 5).unwrap();
        assert!(!paper.view.document.runs.iter().any(|r| r.bold && r.range.start + r.range.length > 5));
        update_input_selection(paper, native::TextRange { start: 0, length: 0 });
        assert!(paper.owner.as_ref().unwrap().typing_style.is_none());
        apply_action(paper, "strike", native::TextRange::default(), 6).unwrap();
        apply_input(paper, &write_core::render::TextRange::default(), "first\nnext", false, 7).unwrap();
        assert!(paper.owner.as_ref().unwrap().typing_style.is_none());
        assert!(paper.view.document.runs.iter().any(|r| r.strike && r.range.start == 0));
        assert!(!paper.view.document.runs.iter().any(|r| r.strike && r.range.start + r.range.length > 5));
    }
    pub(super) async fn fixture() -> (tempfile::TempDir, Arc<Workspace>, String) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        std::fs::create_dir(&root).unwrap();
        let durable = Durability::open(root.clone(), temp.path().join("sumi.sqlite3"), |_| {})
            .await
            .unwrap();
        let id = Uuid::new_v4().to_string();
        let doc = Document::new(&id, 1, 1).unwrap();
        let loaded = durable
            .create(durability::Create {
                page_id: id.clone(),
                epoch: 1,
                full_state: doc.encode_full(),
                revision: 0,
                after_id: None,
                first_write_date: None,
                frontmatter: None,
                preserved_pair: None,
            })
            .await
            .unwrap();
        let mut paper = Paper::from_loaded(loaded).unwrap();
        paper.owner = Some(Owner {
            window: "main".into(),
            tab: "test".into(),
            surface: None,
            composing: false,
            selection: Default::default(),
            viewport: Default::default(),
            suspended: false,
            generation: 0,
            source_baseline: None,
            typing_style: None,
        });
        paper.opened();
        let ws = Arc::new(Workspace {
            phase: AtomicU8::new(ACTIVE),
            root: root.clone(),
            selected_root: root,
            durable,
            sound_backend: None,
            sound: sound::Controller::default(),
            papers: Mutex::new(HashMap::from([(id.clone(), paper)])),
            preferences: Mutex::new(Preferences::default()),
            appearance_changes: tokio::sync::Mutex::new(()),
            font_selection: Mutex::new(FontSelection::default()),
            active: Mutex::new(Some(id.clone())),
            navigation_version: AtomicU64::new(1),
        position_writes: tokio::sync::Mutex::new(()),
            lifecycle: tokio::sync::Mutex::new(()),
            network: OnceLock::new(),
            pending_directory: Mutex::new(None),
        });
        (temp, ws, id)
    }
    #[tokio::test]
    async fn font_download_completion_only_applies_the_last_explicit_selection() {
        let (_temp, ws, id) = fixture().await;
        let before = ws.papers.lock().unwrap()[&id].doc.encode_full();
        let first = begin_font_selection(&ws, "Sumi WenKai").await.unwrap().unwrap();
        assert_eq!(begin_font_selection(&ws, "Sumi WenKai").await.unwrap(), None);
        let second = begin_font_selection(&ws, "Sumi Youcha").await.unwrap().unwrap();
        assert!(!complete_font_selection(&ws, first, "Sumi WenKai").await.unwrap());
        assert_eq!(ws.font_selection.lock().unwrap().pending.as_deref(), Some("Sumi Youcha"));
        assert!(complete_font_selection(&ws, second, "Sumi Youcha").await.unwrap());
        assert!(!complete_font_selection(&ws, first, "Sumi WenKai").await.unwrap());
        assert_eq!(ws.preferences.lock().unwrap().font_family, "Sumi Youcha");
        assert_eq!(load_preferences(&ws.durable).await.unwrap().font_family, "Sumi Youcha");
        assert_eq!(ws.papers.lock().unwrap()[&id].doc.encode_full(), before);
    }

    #[tokio::test]
    async fn background_font_completion_and_appearance_form_preserve_each_others_fields() {
        let (_temp, ws, id) = fixture().await;
        let before = ws.papers.lock().unwrap()[&id].doc.encode_full();
        let generation = begin_font_selection(&ws, "Sumi WenKai").await.unwrap().unwrap();
        let mut form = Preferences::default();
        form.font_size = 50.; form.theme = "sepia".into(); form.bottom_inset = 80.;
        save_appearance(&ws, form.clone(), true).await.unwrap();
        assert!(complete_font_selection(&ws, generation, "Sumi WenKai").await.unwrap());
        // A form created before completion must not restore its old Plex value.
        form.line_height = 2.;
        save_appearance(&ws, form, true).await.unwrap();
        let restored = load_preferences(&ws.durable).await.unwrap();
        assert_eq!(restored.font_family, "Sumi WenKai");
        assert_eq!((restored.font_size, restored.line_height, restored.bottom_inset), (50., 2., 80.));
        assert_eq!(restored.theme, "sepia");
        assert_eq!(ws.papers.lock().unwrap()[&id].doc.encode_full(), before);
    }

    #[tokio::test]
    async fn invalid_appearance_does_not_cancel_pending_font_and_explicit_old_client_change_does() {
        let (_temp, ws, _) = fixture().await;
        let generation = begin_font_selection(&ws, "Sumi Youcha").await.unwrap().unwrap();
        let mut invalid = Preferences::default(); invalid.font_size = 0.;
        assert!(save_appearance(&ws, invalid, false).await.is_err());
        assert_eq!(ws.font_selection.lock().unwrap().pending.as_deref(), Some("Sumi Youcha"));
        let mut selected = Preferences::default(); selected.font_family = "Sumi Fangsong".into();
        save_appearance(&ws, selected, false).await.unwrap();
        assert!(!complete_font_selection(&ws, generation, "Sumi Youcha").await.unwrap());
        assert_eq!(load_preferences(&ws.durable).await.unwrap().font_family, "Sumi Fangsong");
        assert!(begin_font_selection(&ws, "https://arbitrary.example/font.ttf").await.is_err());
    }

    #[tokio::test]
    async fn composition_defers_inbox_blob_reads_until_commit_and_keeps_fifo() {
        let (temp, ws, id) = fixture().await;
        let mut peer = {
            let papers = ws.papers.lock().unwrap();
            Document::load(&id, 1, 2, &papers[&id].doc.encode_full()).unwrap()
        };
        let mut operations = Vec::new();
        for (offset, text) in [(0, "远端"), (2, "继续")] {
            let update = peer.replace(peer.revision(), offset, 0, text, 123).unwrap();
            let incoming = storage::PendingUpdate {op_id: Uuid::new_v4().to_string(), page_id: id.clone(), epoch: 1, update};
            ws.durable.record_inbox(incoming.clone(), 0).await.unwrap();
            operations.push(incoming);
        }
        ws.papers.lock().unwrap().get_mut(&id).unwrap().owner.as_mut().unwrap().composing = true;
        // A real SQLite read fault is a tripwire, not a mock of the helper:
        // touching pending payloads must fail, while IME deferral must not read.
        let db = rusqlite::Connection::open(temp.path().join("sumi.sqlite3")).unwrap();
        db.execute("UPDATE inbox SET update_blob=1234 WHERE page_id=?1", [&id]).unwrap();
        for _ in 0..3 {
            assert!(pending_remote_for_drain(&ws, &id).await.unwrap().is_empty());
        }
        assert_eq!(ws.papers.lock().unwrap()[&id].doc.revision(), 0);
        ws.papers.lock().unwrap().get_mut(&id).unwrap().owner.as_mut().unwrap().composing = false;
        assert!(pending_remote_for_drain(&ws, &id).await.is_err(), "fixture tripwire must detect any actual payload read");
        for op in &operations {
            db.execute("UPDATE inbox SET update_blob=?1 WHERE op_id=?2", rusqlite::params![op.update, op.op_id]).unwrap();
        }
        let pending = pending_remote_for_drain(&ws, &id).await.unwrap();
        assert_eq!(pending.iter().map(|p|p.update.op_id.as_str()).collect::<Vec<_>>(), operations.iter().map(|p|p.op_id.as_str()).collect::<Vec<_>>());
        assert_eq!(pending.iter().map(|p|&p.update.update).collect::<Vec<_>>(), operations.iter().map(|p|&p.update).collect::<Vec<_>>());
        assert!(pending.iter().all(|p|p.generation==0));
        assert_eq!(ws.papers.lock().unwrap()[&id].doc.revision(), 0);
    }
    #[tokio::test]
    async fn creating_page_retry_reuses_its_committed_operation_after_active_page_has_changed() {
        let (temp,ws,origin)=fixture().await;
        let request=Uuid::new_v4().to_string();
        let first=create_paper_durable(&ws,&request,Some(origin.clone()),"next","test".into()).await.unwrap();
        activate_page(&ws,&first).await.unwrap();
        // A lost reply still carries the old origin. Resolve its committed
        // operation before rejecting a stale active-page precondition.
        assert!(existing_creation(&ws,&request,&Some(origin.clone()),"next").await.unwrap().is_some());
        let second=create_paper_durable(&ws,&request,Some(origin.clone()),"next","test".into()).await.unwrap();
        assert_eq!(first,second);assert_eq!(ws.durable.list().await.unwrap().len(),2);
        assert!(create_paper_durable(&ws,&request,Some(origin.clone()),"create","test".into()).await.is_err());
        assert!(create_paper_durable(&ws,&origin,None,"create","test".into()).await.unwrap_err().contains("另一页"));
        let root=ws.root.clone();
        drop(ws);
        let reopened=Durability::open(root,temp.path().join("sumi.sqlite3"),|_|{}).await.unwrap();
        let page=reopened.load(request.clone()).await.unwrap();
        assert_eq!(serde_json::to_value(page.frontmatter.get(serde_yaml::Value::String("sumi_creation".into())).unwrap()).unwrap(),creation_marker(&request,&Some(origin),"next"));
        assert_eq!(page.revision,0);assert!(page.entry.filename().is_none());
    }
    #[tokio::test]
    async fn pending_projection_and_failed_local_durability_have_distinct_ui_states() {
        let (_temp,ws,id)=fixture().await;
        ws.papers.lock().unwrap().get_mut(&id).unwrap().projection_error=Some("external file conflict".into());
        assert_eq!(state_value(&ws).await.unwrap()["saveState"],"projection-pending");
        ws.papers.lock().unwrap().get_mut(&id).unwrap().error=Some("SQLite full".into());
        assert_eq!(state_value(&ws).await.unwrap()["saveState"],"error");
        ws.papers.lock().unwrap().get_mut(&id).unwrap().error=None;
        assert_eq!(state_value(&ws).await.unwrap()["saveState"],"projection-pending");
    }
    #[tokio::test]
    async fn small_reading_preferences_survive_reload_and_remote_insert_without_changing_text_history() {
        let (_temp,ws,id)=fixture().await;
        let raw=format!("{}first\n😀 second\nthird",ws.papers.lock().unwrap()[&id].raw);
        source_save(&ws,"main","test",&id,0,&raw).await.unwrap();
        let pending=ws.durable.outbox_count().await.unwrap();
        {
            let mut papers=ws.papers.lock().unwrap();let p=papers.get_mut(&id).unwrap();
            let owner=p.owner.as_mut().unwrap();owner.selection=native::TextRange{start:6,length:2};owner.viewport=native::Viewport{start:6,offset:3.};position_changed(p);
        }
        flush_positions(&ws,Some(&id)).await.unwrap();
        let stored=ws.durable.preferences(format!("readingPosition:{id}")).await.unwrap().unwrap();
        assert!(serde_json::to_vec(&stored).unwrap().len()<2048);
        assert_eq!(ws.durable.outbox_count().await.unwrap(),pending);
        let loaded=ws.durable.load(id.clone()).await.unwrap();assert_eq!(loaded.revision,1);
        let mut remote=Document::restore(&id,1,999,&loaded.full_state,loaded.revision).unwrap();
        let update=remote.replace(1,0,0,"prefix\n",123).unwrap();
        ws.durable.receive_remote(storage::PendingUpdate{op_id:Uuid::new_v4().to_string(),page_id:id.clone(),epoch:1,update},0).await.unwrap();
        let mut owned=Arc::try_unwrap(ws).unwrap_or_else(|_|panic!("fixture owner leaked"));
        drop(owned.durable);
        owned.durable=Durability::open(owned.root.clone(),_temp.path().join("sumi.sqlite3"),|_|{}).await.unwrap();
        let ws=Arc::new(owned);
        let reopened=ws.durable.clone();
        assert_eq!(reopened.preferences(format!("readingPosition:{id}")).await.unwrap(),Some(stored));
        let loaded=reopened.load(id.clone()).await.unwrap();
        ws.papers.lock().unwrap().insert(id.clone(),Paper::from_loaded(loaded).unwrap());
        load_position(&ws,&id).await.unwrap();
        let papers=ws.papers.lock().unwrap();let p=&papers[&id];let (selection,viewport)=resolve_reading_position(p).unwrap_or_default();
        assert_eq!((selection.start,selection.length),(13,2));assert_eq!(viewport.start,13);assert_eq!(viewport.offset,3.);
        assert_eq!(p.doc.body(),"prefix\nfirst\n😀 second\nthird");
    }
    #[tokio::test]
    async fn unresolved_foreign_reading_anchors_are_retained_without_moving_the_caret() {
        let (_temp,ws,id)=fixture().await;
        let other=Document::new(&Uuid::new_v4().to_string(),1,999).unwrap();
        let encoded=other.serialize_selection(&other.anchor_selection(0,0).unwrap()).unwrap();
        let position=ReadingPosition{selection:encoded.clone(),viewport:encoded,offset:7.};
        ws.durable.set_preferences(format!("readingPosition:{id}"),serde_json::to_value(&position).unwrap()).await.unwrap();
        load_position(&ws,&id).await.unwrap();
        let papers=ws.papers.lock().unwrap();let p=&papers[&id];let (selection,viewport)=resolve_reading_position(p).unwrap_or_default();
        assert_eq!(selection.start,0);assert_eq!(viewport.start,0);assert_eq!(viewport.offset,0.);
        assert_eq!(p.position.as_ref().unwrap().selection,position.selection);
    }
    #[tokio::test]
    async fn known_external_header_and_metadata_extensions_preserve_body_history() {
        let (_temp, ws, id) = fixture().await;
        let raw = format!("{}base", ws.papers.lock().unwrap()[&id].raw);
        source_save(&ws, "main", "test", &id, 0, &raw)
            .await
            .unwrap();
        let baseline = ws.durable.read_baseline(id.clone()).await.unwrap().unwrap();
        let (md, meta) = write_core::projection::paths(&ws.root, &baseline.filename).unwrap();
        std::fs::write(
            &md,
            baseline
                .pair
                .markdown
                .replacen("type:", "custom: preserved\ntype:", 1),
        )
        .unwrap();
        reconcile_known_files(&ws, &id).await.unwrap();
        assert_eq!(ws.papers.lock().unwrap()[&id].doc.revision(), 1);
        assert!(ws.papers.lock().unwrap()[&id]
            .raw
            .contains("custom: preserved"));
        let prior = storage::parse_pair(&baseline.pair.markdown, &baseline.pair.metadata).unwrap();
        let mut side: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&meta).unwrap()).unwrap();
        side["custom"] = json!({"preserved":42});
        side["lines"][0]["custom_line"] = json!(true);
        std::fs::write(&meta, side.to_string()).unwrap();
        reconcile_known_files(&ws, &id).await.unwrap();
        let result = storage::parse_pair(
            &std::fs::read_to_string(&md).unwrap(),
            &std::fs::read_to_string(&meta).unwrap(),
        )
        .unwrap();
        assert_eq!(result.body, "base");
        assert_eq!(result.sidecar.extra["custom"]["preserved"], 42);
        assert_eq!(result.sidecar.lines[0].extra["custom_line"], true);
        assert_eq!(
            result.sidecar.lines[0].first_written_at,
            prior.sidecar.lines[0].first_written_at
        );
        assert_eq!(
            result.sidecar.lines[0].last_written_at,
            prior.sidecar.lines[0].last_written_at
        );
    }
    #[tokio::test]
    async fn broken_or_late_meta_never_mutates_known_text_and_explicit_repair_preserves_originals()
    {
        let (_temp, ws, id) = fixture().await;
        let raw = format!("{}base", ws.papers.lock().unwrap()[&id].raw);
        source_save(&ws, "main", "test", &id, 0, &raw)
            .await
            .unwrap();
        let baseline = ws.durable.read_baseline(id.clone()).await.unwrap().unwrap();
        let (md, meta) = write_core::projection::paths(&ws.root, &baseline.filename).unwrap();
        let outside = baseline.pair.markdown.replace("base", "external retained");
        std::fs::write(&md, &outside).unwrap();
        std::fs::write(&meta, b"broken metadata").unwrap();
        assert!(reconcile_known_files(&ws, &id)
            .await
            .unwrap_err()
            .contains("原文件保留"));
        assert_eq!(ws.papers.lock().unwrap()[&id].doc.body(), "base");
        let (loaded, backup) = ws.durable.restore_projection(id.clone(), 0).await.unwrap();
        assert_eq!(
            std::fs::read_to_string(backup.join(&baseline.filename)).unwrap(),
            outside
        );
        let backup_meta = backup.join(meta.file_name().unwrap());
        assert_eq!(std::fs::read(backup_meta).unwrap(), b"broken metadata");
        let repaired = storage::parse_pair(
            &std::fs::read_to_string(&md).unwrap(),
            &std::fs::read_to_string(&meta).unwrap(),
        )
        .unwrap();
        assert_eq!(repaired.body, "base");
        assert_eq!(loaded.revision, 1);
        let original =
            storage::parse_pair(&baseline.pair.markdown, &baseline.pair.metadata).unwrap();
        assert_eq!(
            repaired.sidecar.lines[0].first_written_at,
            original.sidecar.lines[0].first_written_at
        );
        std::fs::remove_file(&meta).unwrap();
        assert!(reconcile_known_files(&ws, &id)
            .await
            .unwrap_err()
            .contains("时间文件缺失"));
        assert_eq!(std::fs::read_to_string(&md).unwrap(), loaded.raw_markdown);
        ws.durable.restore_projection(id.clone(), 0).await.unwrap();
        let mut late: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&meta).unwrap()).unwrap();
        late["lines"][0]["last_written_at"] = json!("1970-01-01T00:00:00Z");
        std::fs::write(&meta, late.to_string()).unwrap();
        assert!(reconcile_known_files(&ws, &id)
            .await
            .unwrap_err()
            .contains("不会回滚"));
        assert_eq!(ws.papers.lock().unwrap()[&id].doc.body(), "base");
        std::fs::remove_file(&md).unwrap();
        assert!(reconcile_known_files(&ws, &id)
            .await
            .unwrap_err()
            .contains("正文文件已被外部移除"));
        assert!(!ws.durable.list().await.unwrap()[0].deleted);
        ws.durable.restore_projection(id.clone(), 0).await.unwrap();
        assert!(md.exists());
        assert!(!ws.durable.list().await.unwrap()[0].deleted);
    }
    #[tokio::test]
    async fn empty_undo_does_not_poison_the_durable_queue_and_real_undo_maps_the_caret() {
        let (_temp, ws, id) = fixture().await;
        let raw = {
            let mut papers = ws.papers.lock().unwrap();
            let p = papers.get_mut(&id).unwrap();
            assert!(apply_action(p, "undo", Default::default(), 1)
                .unwrap()
                .is_none());
            assert!(apply_action(p, "redo", Default::default(), 2)
                .unwrap()
                .is_none());
            assert_eq!(p.doc.revision(), 0);
            format!("{}😀", p.raw)
        };
        let saved = source_save(&ws, "main", "test", &id, 0, &raw)
            .await
            .unwrap();
        assert_eq!(saved.revision, 1);
        {
            let mut papers = ws.papers.lock().unwrap();
            let p = papers.get_mut(&id).unwrap();
            let update = apply_action(
                p,
                "undo",
                native::TextRange {
                    start: 2,
                    length: 0,
                },
                3,
            )
            .unwrap()
            .unwrap();
            queue(&ws, p, update).unwrap();
            let result = reply(p);
            let projection = result.projection.unwrap();
            assert!(projection.document.text.is_empty());
            assert_eq!(projection.selection.start, 0);
            assert_eq!(result.revision, 2);
        }
        let final_state = flush(&ws, "main", "test", &id, None).await.unwrap();
        assert_eq!(final_state.revision, 2);
        assert!(parse_header(&final_state.raw, &id, 1).unwrap().1.is_empty());
    }
    #[tokio::test]
    async fn successive_source_saves_pin_the_baseline_of_the_latest_submission() {
        let (_temp, ws, id) = fixture().await;
        let raw = ws.papers.lock().unwrap()[&id].raw.clone();
        let first = source_save(&ws, "main", "test", &id, 0, &format!("{raw}A"))
            .await
            .unwrap();
        let second = source_save(
            &ws,
            "main",
            "test",
            &id,
            first.revision,
            &format!("{}B", first.raw),
        )
        .await
        .unwrap();
        let papers = ws.papers.lock().unwrap();
        let p = &papers[&id];
        assert_eq!(
            p.owner.as_ref().unwrap().source_baseline,
            Some(first.revision)
        );
        assert!(p.baselines.contains_key(&first.revision));
        assert!(p.baselines.contains_key(&second.revision));
        assert!(!p.baselines.contains_key(&0));
    }
    #[tokio::test]
    async fn deleted_generation_rejects_source_without_changing_its_draft_or_queue() {
        let (_temp, ws, id) = fixture().await;
        let raw = {
            let mut papers = ws.papers.lock().unwrap();
            let p = papers.get_mut(&id).unwrap();
            p.entry.generation = 1;
            format!("{}retained", p.raw)
        };
        let error = source_save(&ws, "main", "test", &id, 0, &raw)
            .await
            .err()
            .unwrap();
        assert!(error.contains("生命周期"));
        assert_eq!(ws.papers.lock().unwrap()[&id].doc.revision(), 0);
        assert_eq!(ws.durable.load(id).await.unwrap().revision, 0);
    }
    #[tokio::test]
    async fn lost_remote_receipt_retries_durability_without_reapplying_the_ui_packet() {
        let (_temp, ws, id) = fixture().await;
        let mut remote = {
            let papers = ws.papers.lock().unwrap();
            let p = &papers[&id];
            Document::restore(&id, 1, 900, &p.doc.encode_full(), 0).unwrap()
        };
        let update = remote.replace(0, 0, 0, "remote", 1).unwrap();
        let incoming = storage::PendingUpdate {
            page_id: id.clone(),
            epoch: 1,
            op_id: Uuid::new_v4().to_string(),
            update,
        };
        ws.durable.record_inbox(incoming.clone(), 0).await.unwrap();
        let revision = {
            let mut papers = ws.papers.lock().unwrap();
            let p = papers.get_mut(&id).unwrap();
            p.doc.apply_remote(&incoming.update).unwrap();
            p.remote
                .pending_commits
                .insert(incoming.op_id.clone(), p.doc.revision());
            p.doc.revision()
        };
        drop(
            ws.durable
                .enqueue_remote(incoming.clone(), 0, revision)
                .unwrap(),
        );
        assert!(retry_accepted_remote(&ws, &id, &incoming.op_id)
            .await
            .unwrap());
        let loaded = ws.durable.load(id.clone()).await.unwrap();
        assert_eq!(loaded.revision, revision);
        assert_eq!(ws.papers.lock().unwrap()[&id].doc.revision(), revision);
        assert_eq!(ws.papers.lock().unwrap()[&id].doc.body(), "remote");
        assert!(!retry_accepted_remote(&ws, &id, &incoming.op_id)
            .await
            .unwrap());
    }
    #[test]
    fn selection_clamping_never_splits_a_surrogate_pair() {
        assert_eq!(
            bounded_selection(
                "a😀b",
                native::TextRange {
                    start: 2,
                    length: 0
                }
            )
            .start,
            1
        );
        let range = bounded_selection(
            "😀",
            native::TextRange {
                start: 9,
                length: 100,
            },
        );
        assert_eq!(range.start, 2);
        assert_eq!(range.length, 0);
    }
}

/// Private stdio process callback; deliberately absent from UI RPC routing.
pub(crate) async fn service_callback<R: Runtime>(app:&tauri::AppHandle<R>,plugin:&str,value:Value)->Result<Value>{service::callback(app,plugin,value).await}

#[cfg(test)]
mod lifecycle_tests;
