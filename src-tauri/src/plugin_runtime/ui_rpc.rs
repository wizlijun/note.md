//! UI→host RPC dispatch (子项目② Task 3). A plugin window is granted ZERO
//! Tauri IPC; the `plugin://<id>/__rpc__` fetch endpoint (protocol.rs) is the
//! only bridge, and it authenticates the caller by request Origin. This module
//! is the handler behind that endpoint: it enforces the SAME capability table
//! as the process-side host_api (`method_capability`), then executes the method.
//!
//! # Testability shape (deviation note)
//!
//! `dispatch` takes `services: &dyn HostServices` instead of an `AppHandle`.
//! Every host effect that would need a real Tauri runtime — file dialogs,
//! vault-root resolution, wiki/daily dirs, clipboard writes — is behind that
//! trait. Production wraps a live `AppHandle` in [`TauriServices`]; unit tests
//! inject stubs, so dispatch is exercised end-to-end with NO real dialogs and
//! NO AppHandle. Vault filesystem ops (read/write/exists/list/mkdir) are done
//! directly against `services.vault_root()` — they need no injection because a
//! tempdir root fully substitutes for a real vault.
//!
//! # fs.read:dialog authorization
//!
//! `host.fs.read_text` may ONLY read a path that a prior `host.dialog.open` /
//! `host.dialog.save` returned in this session. `HostServices` owns a
//! per-plugin allow-set; dialog results are inserted, `read_text` checks
//! membership. This stops a UI from reading arbitrary disk paths through the
//! `fs.read:dialog` capability.

use std::path::{Path, PathBuf};

use plugin_protocol as proto;

use super::host_api::{handle_common, method_capability, ToastEmitter};

// ── Injectable host services ────────────────────────────────────────────

/// A file filter for the native dialogs: a label plus its extensions.
#[derive(Debug, Clone)]
pub struct DialogFilter {
    pub name: String,
    pub extensions: Vec<String>,
}

/// Options for `host.dialog.open`.
#[derive(Debug, Clone, Default)]
pub struct OpenOptions {
    pub title: Option<String>,
    pub filters: Vec<DialogFilter>,
    pub directory: bool,
}

/// Options for `host.dialog.save`.
#[derive(Debug, Clone, Default)]
pub struct SaveOptions {
    pub title: Option<String>,
    pub default_filename: Option<String>,
    pub filters: Vec<DialogFilter>,
}

/// Every host effect dispatch needs. Production wraps a live `AppHandle`
/// ([`TauriServices`]); tests inject stubs. Impls must be `Send + Sync` so the
/// trait object can cross the async boundary.
///
/// The allow-set for `fs.read:dialog` is owned by the impl and keyed per
/// plugin: `remember_dialog_path` records a path a dialog returned;
/// `is_dialog_path` checks membership before `host.fs.read_text` reads it.
pub trait HostServices: Send + Sync {
    /// Show an open dialog. `None` = user cancelled. Paths are also remembered
    /// in the fs.read:dialog allow-set for `plugin_id`.
    fn pick_files(&self, plugin_id: &str, opts: &OpenOptions) -> Result<Option<Vec<String>>, String>;
    /// Show a save dialog. `None` = user cancelled. The chosen path is
    /// remembered in the allow-set for `plugin_id`.
    fn pick_save(&self, plugin_id: &str, opts: &SaveOptions) -> Result<Option<String>, String>;
    /// The configured vault root, or `None` when no vault is configured.
    fn vault_root(&self) -> Option<PathBuf>;
    /// `(wiki_dir, daily_dir)` vault-relative names, each `None` when unset.
    fn wiki_daily_dirs(&self) -> (Option<String>, Option<String>);
    /// Write UTF-8 text to the OS clipboard.
    fn clipboard_write(&self, text: &str) -> Result<(), String>;
    /// True when `path` was returned by a dialog for `plugin_id` this session.
    fn is_dialog_path(&self, plugin_id: &str, path: &str) -> bool;
}

// ── Dispatch ────────────────────────────────────────────────────────────

fn err(id: Option<u64>, code: i64, message: String) -> proto::RpcResponse {
    proto::RpcResponse {
        jsonrpc: "2.0".into(),
        id: id.unwrap_or(0),
        result: None,
        error: Some(proto::RpcError { code, message }),
    }
}

fn ok(id: Option<u64>, result: serde_json::Value) -> proto::RpcResponse {
    proto::RpcResponse {
        jsonrpc: "2.0".into(),
        id: id.unwrap_or(0),
        result: Some(result),
        error: None,
    }
}

/// Handle one UI→host RPC. Mirrors the process sink's capability gate exactly
/// (unknown method → -32601, unauthorized → -32001), runs `handle_common`
/// (log/toast) first, then the dialog/vault/fs/clipboard methods. All execution
/// failures map to -32000 with a `"<kind>: <detail>"` message.
pub async fn dispatch(
    services: &dyn HostServices,
    plugin_id: &str,
    capabilities: &[String],
    body: proto::RpcRequest,
    log_dir: &Path,
    emitter: &ToastEmitter,
) -> proto::RpcResponse {
    let id = body.id;

    // Capability gate — identical to host_api::make_sink.
    match method_capability(&body.method) {
        Some("__unknown__") => {
            return err(
                id,
                proto::ERR_METHOD_NOT_FOUND,
                format!("unknown method {}", body.method),
            );
        }
        Some(cap) if !capabilities.iter().any(|c| c == cap) => {
            return err(
                id,
                proto::ERR_CAPABILITY_DENIED,
                format!("method {} requires capability '{cap}'", body.method),
            );
        }
        _ => {}
    }

    // Shared log/toast handling.
    if let Some(res) = handle_common(&body.method, body.params.clone(), plugin_id, log_dir, emitter) {
        return match res {
            Ok(v) => ok(id, v),
            Err(detail) => err(id, proto::ERR_INTERNAL, detail),
        };
    }

    let internal = |detail: String| err(id, proto::ERR_INTERNAL, detail);

    match body.method.as_str() {
        "host.dialog.open" => match dialog_open(services, plugin_id, &body.params) {
            Ok(paths) => ok(id, serde_json::json!({ "paths": paths })),
            Err(e) => internal(e),
        },
        "host.dialog.save" => match dialog_save(services, plugin_id, &body.params) {
            Ok(path) => ok(id, serde_json::json!({ "path": path })),
            Err(e) => internal(e),
        },
        "host.fs.read_text" => match fs_read_text(services, plugin_id, &body.params) {
            Ok(text) => ok(id, serde_json::json!({ "text": text })),
            Err(e) => internal(e),
        },
        "host.clipboard.write" => match clipboard_write(services, &body.params) {
            Ok(()) => ok(id, serde_json::json!({ "ok": true })),
            Err(e) => internal(e),
        },
        "host.vault.info" => ok(id, vault_info(services)),
        "host.vault.read" => match vault_read(services, &body.params) {
            Ok(text) => ok(id, serde_json::json!({ "text": text })),
            Err(e) => internal(e),
        },
        "host.vault.write" => match vault_write(services, &body.params) {
            Ok(()) => ok(id, serde_json::json!({ "ok": true })),
            Err(e) => internal(e),
        },
        "host.vault.exists" => match vault_exists(services, &body.params) {
            Ok(exists) => ok(id, serde_json::json!({ "exists": exists })),
            Err(e) => internal(e),
        },
        "host.vault.list" => match vault_list(services, &body.params) {
            Ok(names) => ok(id, serde_json::json!({ "entries": names })),
            Err(e) => internal(e),
        },
        "host.vault.mkdir" => match vault_mkdir(services, &body.params) {
            Ok(()) => ok(id, serde_json::json!({ "ok": true })),
            Err(e) => internal(e),
        },
        // handle_common already handled log/toast; the gate rejected the rest.
        _ => err(
            id,
            proto::ERR_METHOD_NOT_FOUND,
            format!("unhandled method {}", body.method),
        ),
    }
}

// ── Method bodies ────────────────────────────────────────────────────────

fn parse_filters(params: &serde_json::Value) -> Vec<DialogFilter> {
    params
        .get("filters")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|f| {
                    let name = f.get("name")?.as_str()?.to_string();
                    let extensions = f
                        .get("extensions")?
                        .as_array()?
                        .iter()
                        .filter_map(|e| e.as_str().map(str::to_string))
                        .collect();
                    Some(DialogFilter { name, extensions })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn dialog_open(
    services: &dyn HostServices,
    plugin_id: &str,
    params: &serde_json::Value,
) -> Result<Option<Vec<String>>, String> {
    let opts = OpenOptions {
        title: params.get("title").and_then(|v| v.as_str()).map(str::to_string),
        filters: parse_filters(params),
        directory: params.get("directory").and_then(|v| v.as_bool()).unwrap_or(false),
    };
    services
        .pick_files(plugin_id, &opts)
        .map_err(|e| format!("dialog: {e}"))
}

fn dialog_save(
    services: &dyn HostServices,
    plugin_id: &str,
    params: &serde_json::Value,
) -> Result<Option<String>, String> {
    let opts = SaveOptions {
        title: params.get("title").and_then(|v| v.as_str()).map(str::to_string),
        default_filename: params
            .get("default_filename")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        filters: parse_filters(params),
    };
    services
        .pick_save(plugin_id, &opts)
        .map_err(|e| format!("dialog: {e}"))
}

fn fs_read_text(
    services: &dyn HostServices,
    plugin_id: &str,
    params: &serde_json::Value,
) -> Result<String, String> {
    let path = params
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "bad_params: path is required".to_string())?;
    if !services.is_dialog_path(plugin_id, path) {
        return Err("forbidden: path was not returned by a dialog this session".into());
    }
    std::fs::read_to_string(path).map_err(|e| format!("io: {e}"))
}

fn clipboard_write(services: &dyn HostServices, params: &serde_json::Value) -> Result<(), String> {
    let text = params
        .get("text")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "bad_params: text is required".to_string())?;
    services.clipboard_write(text).map_err(|e| format!("clipboard: {e}"))
}

fn vault_info(services: &dyn HostServices) -> serde_json::Value {
    let root = services.vault_root().map(|p| p.to_string_lossy().to_string());
    let (wiki, daily) = services.wiki_daily_dirs();
    serde_json::json!({ "root": root, "wiki_dir": wiki, "daily_dir": daily })
}

/// Resolve a plugin-supplied relative `path` to an absolute path guaranteed to
/// stay within the vault root. Rejects absolute paths and any `..` escape.
/// `Err("vault_required: …")` when no vault is configured.
fn resolve_in_vault(services: &dyn HostServices, params: &serde_json::Value) -> Result<PathBuf, String> {
    let root = services
        .vault_root()
        .ok_or_else(|| "vault_required: no vault is configured".to_string())?;
    let rel = params
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "bad_params: path is required".to_string())?;
    let rel = rel.trim();
    let path = Path::new(rel);
    if path.is_absolute() {
        return Err("forbidden: path must be relative".into());
    }
    let mut resolved = root.clone();
    for comp in path.components() {
        use std::path::Component;
        match comp {
            Component::Normal(seg) => resolved.push(seg),
            Component::CurDir => {}
            Component::ParentDir => {
                return Err("forbidden: path escapes the vault".into());
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err("forbidden: path must be relative".into());
            }
        }
    }
    // Defense in depth: the assembled path must still be under root.
    if !resolved.starts_with(&root) {
        return Err("forbidden: path escapes the vault".into());
    }
    Ok(resolved)
}

fn vault_read(services: &dyn HostServices, params: &serde_json::Value) -> Result<String, String> {
    let p = resolve_in_vault(services, params)?;
    std::fs::read_to_string(&p).map_err(|e| format!("io: {e}"))
}

fn vault_write(services: &dyn HostServices, params: &serde_json::Value) -> Result<(), String> {
    let p = resolve_in_vault(services, params)?;
    let content = params
        .get("content")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "bad_params: content is required".to_string())?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("io: {e}"))?;
    }
    std::fs::write(&p, content).map_err(|e| format!("io: {e}"))
}

fn vault_exists(services: &dyn HostServices, params: &serde_json::Value) -> Result<bool, String> {
    let p = resolve_in_vault(services, params)?;
    Ok(p.exists())
}

fn vault_list(services: &dyn HostServices, params: &serde_json::Value) -> Result<Vec<String>, String> {
    let p = resolve_in_vault(services, params)?;
    let mut names = Vec::new();
    for entry in std::fs::read_dir(&p).map_err(|e| format!("io: {e}"))? {
        let entry = entry.map_err(|e| format!("io: {e}"))?;
        if let Some(name) = entry.file_name().to_str() {
            names.push(name.to_string());
        }
    }
    names.sort();
    Ok(names)
}

fn vault_mkdir(services: &dyn HostServices, params: &serde_json::Value) -> Result<(), String> {
    let p = resolve_in_vault(services, params)?;
    std::fs::create_dir_all(&p).map_err(|e| format!("io: {e}"))
}

// ── Production HostServices (live AppHandle) ──────────────────────────────

/// Live implementation wired to a Tauri `AppHandle`. Constructed per-dispatch
/// in protocol.rs. The dialog allow-set is a process-global keyed by plugin id
/// (see [`allowlist`]).
pub struct TauriServices<R: tauri::Runtime> {
    app: tauri::AppHandle<R>,
}

impl<R: tauri::Runtime> TauriServices<R> {
    pub fn new(app: tauri::AppHandle<R>) -> Self {
        Self { app }
    }
}

impl<R: tauri::Runtime> HostServices for TauriServices<R> {
    fn pick_files(&self, plugin_id: &str, opts: &OpenOptions) -> Result<Option<Vec<String>>, String> {
        use tauri_plugin_dialog::DialogExt;
        let mut builder = self.app.dialog().file();
        if let Some(t) = &opts.title {
            builder = builder.set_title(t);
        }
        for f in &opts.filters {
            let exts: Vec<&str> = f.extensions.iter().map(String::as_str).collect();
            builder = builder.add_filter(&f.name, &exts);
        }
        let picked: Option<Vec<String>> = if opts.directory {
            builder
                .blocking_pick_folders()
                .map(|v| v.into_iter().map(|p| p.to_string()).collect())
        } else {
            builder
                .blocking_pick_files()
                .map(|v| v.into_iter().map(|p| p.to_string()).collect())
        };
        if let Some(paths) = &picked {
            for p in paths {
                allowlist::remember(plugin_id, p);
            }
        }
        Ok(picked)
    }

    fn pick_save(&self, plugin_id: &str, opts: &SaveOptions) -> Result<Option<String>, String> {
        use tauri_plugin_dialog::DialogExt;
        let mut builder = self.app.dialog().file();
        if let Some(t) = &opts.title {
            builder = builder.set_title(t);
        }
        if let Some(name) = &opts.default_filename {
            builder = builder.set_file_name(name);
        }
        for f in &opts.filters {
            let exts: Vec<&str> = f.extensions.iter().map(String::as_str).collect();
            builder = builder.add_filter(&f.name, &exts);
        }
        let picked = builder.blocking_save_file().map(|p| p.to_string());
        if let Some(p) = &picked {
            allowlist::remember(plugin_id, p);
        }
        Ok(picked)
    }

    fn vault_root(&self) -> Option<PathBuf> {
        crate::sotvault::resolve_vault_root_public(&self.app)
    }

    fn wiki_daily_dirs(&self) -> (Option<String>, Option<String>) {
        let Some(root) = self.vault_root() else {
            return (None, None);
        };
        let settings = crate::sotvault::vault_settings::read(&root);
        (settings.wikipage_dir, settings.dailynote_dir)
    }

    fn clipboard_write(&self, text: &str) -> Result<(), String> {
        use tauri_plugin_clipboard_manager::ClipboardExt;
        self.app.clipboard().write_text(text).map_err(|e| e.to_string())
    }

    fn is_dialog_path(&self, plugin_id: &str, path: &str) -> bool {
        allowlist::contains(plugin_id, path)
    }
}

/// Process-global per-plugin allow-set for the `fs.read:dialog` capability.
/// Only paths a dialog returned this session are readable via `host.fs.read_text`.
mod allowlist {
    use std::collections::{HashMap, HashSet};
    use std::sync::{LazyLock, Mutex};

    static PATHS: LazyLock<Mutex<HashMap<String, HashSet<String>>>> =
        LazyLock::new(|| Mutex::new(HashMap::new()));

    pub fn remember(plugin_id: &str, path: &str) {
        if let Ok(mut m) = PATHS.lock() {
            m.entry(plugin_id.to_string()).or_default().insert(path.to_string());
        }
    }

    pub fn contains(plugin_id: &str, path: &str) -> bool {
        PATHS
            .lock()
            .map(|m| m.get(plugin_id).is_some_and(|s| s.contains(path)))
            .unwrap_or(false)
    }
}

// ── Unit tests ────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::sync::{Arc, Mutex};

    /// Stub services backed by an in-memory tempdir vault + recording hooks.
    #[derive(Default)]
    struct StubServices {
        vault: Option<PathBuf>,
        wiki: Option<String>,
        daily: Option<String>,
        /// paths the next dialog.open returns
        dialog_returns: Vec<String>,
        /// path the next dialog.save returns
        save_returns: Option<String>,
        /// recorded fs.read:dialog allow-set
        allowed: Arc<Mutex<HashSet<String>>>,
        /// recorded clipboard writes
        clipboard: Arc<Mutex<Vec<String>>>,
    }

    impl HostServices for StubServices {
        fn pick_files(&self, _plugin_id: &str, _opts: &OpenOptions) -> Result<Option<Vec<String>>, String> {
            if self.dialog_returns.is_empty() {
                return Ok(None);
            }
            for p in &self.dialog_returns {
                self.allowed.lock().unwrap().insert(p.clone());
            }
            Ok(Some(self.dialog_returns.clone()))
        }
        fn pick_save(&self, _plugin_id: &str, _opts: &SaveOptions) -> Result<Option<String>, String> {
            if let Some(p) = &self.save_returns {
                self.allowed.lock().unwrap().insert(p.clone());
            }
            Ok(self.save_returns.clone())
        }
        fn vault_root(&self) -> Option<PathBuf> {
            self.vault.clone()
        }
        fn wiki_daily_dirs(&self) -> (Option<String>, Option<String>) {
            (self.wiki.clone(), self.daily.clone())
        }
        fn clipboard_write(&self, text: &str) -> Result<(), String> {
            self.clipboard.lock().unwrap().push(text.to_string());
            Ok(())
        }
        fn is_dialog_path(&self, _plugin_id: &str, path: &str) -> bool {
            self.allowed.lock().unwrap().contains(path)
        }
    }

    fn noop_emitter() -> ToastEmitter {
        Arc::new(|_| {})
    }

    fn req(method: &str, params: serde_json::Value) -> proto::RpcRequest {
        proto::RpcRequest {
            jsonrpc: "2.0".into(),
            id: Some(1),
            method: method.into(),
            params,
        }
    }

    async fn run(
        services: &dyn HostServices,
        caps: &[&str],
        method: &str,
        params: serde_json::Value,
    ) -> proto::RpcResponse {
        let dir = tempfile::tempdir().unwrap();
        let caps: Vec<String> = caps.iter().map(|s| s.to_string()).collect();
        dispatch(
            services,
            "test.plugin",
            &caps,
            req(method, params),
            dir.path(),
            &noop_emitter(),
        )
        .await
    }

    // ── capability gate ──────────────────────────────────────────────────

    #[tokio::test]
    async fn unauthorized_method_returns_32001() {
        let s = StubServices::default();
        let r = run(&s, &[], "host.vault.read", serde_json::json!({"path": "a.md"})).await;
        let e = r.error.unwrap();
        assert_eq!(e.code, proto::ERR_CAPABILITY_DENIED);
        assert!(e.message.contains("vault.read"), "{}", e.message);
    }

    #[tokio::test]
    async fn unknown_method_returns_32601() {
        let s = StubServices::default();
        let r = run(&s, &["vault.read"], "host.bogus", serde_json::json!({})).await;
        let e = r.error.unwrap();
        assert_eq!(e.code, proto::ERR_METHOD_NOT_FOUND);
    }

    // ── vault round-trip ─────────────────────────────────────────────────

    #[tokio::test]
    async fn vault_write_read_exists_list_mkdir_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let s = StubServices { vault: Some(dir.path().to_path_buf()), ..Default::default() };

        // mkdir sub/
        let r = run(&s, &["vault.write"], "host.vault.mkdir", serde_json::json!({"path": "sub"})).await;
        assert!(r.error.is_none(), "{:?}", r.error);
        assert!(dir.path().join("sub").is_dir());

        // write sub/a.md (parent already exists; also verify auto-parent for nested)
        let r = run(
            &s,
            &["vault.write"],
            "host.vault.write",
            serde_json::json!({"path": "sub/deep/a.md", "content": "hello"}),
        )
        .await;
        assert!(r.error.is_none(), "{:?}", r.error);
        assert_eq!(
            std::fs::read_to_string(dir.path().join("sub/deep/a.md")).unwrap(),
            "hello"
        );

        // read it back
        let r = run(&s, &["vault.read"], "host.vault.read", serde_json::json!({"path": "sub/deep/a.md"})).await;
        assert_eq!(r.result.unwrap()["text"], "hello");

        // exists true / false
        let r = run(&s, &["vault.read"], "host.vault.exists", serde_json::json!({"path": "sub/deep/a.md"})).await;
        assert_eq!(r.result.unwrap()["exists"], true);
        let r = run(&s, &["vault.read"], "host.vault.exists", serde_json::json!({"path": "nope.md"})).await;
        assert_eq!(r.result.unwrap()["exists"], false);

        // list sub/deep
        let r = run(&s, &["vault.read"], "host.vault.list", serde_json::json!({"path": "sub/deep"})).await;
        let entries = r.result.unwrap()["entries"].clone();
        assert_eq!(entries, serde_json::json!(["a.md"]));
    }

    #[tokio::test]
    async fn path_traversal_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let s = StubServices { vault: Some(dir.path().to_path_buf()), ..Default::default() };
        for bad in ["../escape.md", "sub/../../escape.md", "/etc/passwd"] {
            let r = run(&s, &["vault.read"], "host.vault.read", serde_json::json!({"path": bad})).await;
            let e = r.error.unwrap();
            assert_eq!(e.code, proto::ERR_INTERNAL, "path {bad}");
            assert!(e.message.starts_with("forbidden:"), "path {bad}: {}", e.message);
        }
    }

    #[tokio::test]
    async fn vault_required_when_root_none() {
        let s = StubServices { vault: None, ..Default::default() };
        let r = run(&s, &["vault.read"], "host.vault.read", serde_json::json!({"path": "a.md"})).await;
        let e = r.error.unwrap();
        assert_eq!(e.code, proto::ERR_INTERNAL);
        assert!(e.message.starts_with("vault_required:"), "{}", e.message);
    }

    // ── vault.info ───────────────────────────────────────────────────────

    #[tokio::test]
    async fn vault_info_reports_root_and_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let s = StubServices {
            vault: Some(dir.path().to_path_buf()),
            wiki: Some("wikipage".into()),
            daily: Some("dailynote".into()),
            ..Default::default()
        };
        let r = run(&s, &["vault.read"], "host.vault.info", serde_json::json!({})).await;
        let res = r.result.unwrap();
        assert_eq!(res["root"], dir.path().to_string_lossy().to_string());
        assert_eq!(res["wiki_dir"], "wikipage");
        assert_eq!(res["daily_dir"], "dailynote");

        let s2 = StubServices::default();
        let r = run(&s2, &["vault.read"], "host.vault.info", serde_json::json!({})).await;
        let res = r.result.unwrap();
        assert!(res["root"].is_null());
        assert!(res["wiki_dir"].is_null());
    }

    // ── fs.read:dialog authorization ─────────────────────────────────────

    #[tokio::test]
    async fn fs_read_text_denied_then_allowed_after_dialog() {
        let outside = tempfile::tempdir().unwrap();
        let export = outside.path().join("export.json");
        std::fs::write(&export, r#"{"k":1}"#).unwrap();
        let export_str = export.to_string_lossy().to_string();

        let s = StubServices {
            dialog_returns: vec![export_str.clone()],
            ..Default::default()
        };

        // Before any dialog: denied.
        let r = run(&s, &["fs.read:dialog"], "host.fs.read_text", serde_json::json!({"path": export_str})).await;
        let e = r.error.unwrap();
        assert_eq!(e.code, proto::ERR_INTERNAL);
        assert!(e.message.starts_with("forbidden:"), "{}", e.message);

        // Run dialog.open → allowlists the path.
        let r = run(
            &s,
            &["dialog"],
            "host.dialog.open",
            serde_json::json!({"filters": [{"name": "JSON", "extensions": ["json"]}]}),
        )
        .await;
        let paths = r.result.unwrap()["paths"].clone();
        assert_eq!(paths, serde_json::json!([export_str]));

        // Now read_text succeeds.
        let r = run(&s, &["fs.read:dialog"], "host.fs.read_text", serde_json::json!({"path": export_str})).await;
        assert_eq!(r.result.unwrap()["text"], r#"{"k":1}"#);
    }

    // ── clipboard ────────────────────────────────────────────────────────

    #[tokio::test]
    async fn clipboard_write_calls_service() {
        let s = StubServices::default();
        let clip = s.clipboard.clone();
        let r = run(&s, &["clipboard.write"], "host.clipboard.write", serde_json::json!({"text": "copied"})).await;
        assert_eq!(r.result.unwrap(), serde_json::json!({"ok": true}));
        assert_eq!(*clip.lock().unwrap(), vec!["copied".to_string()]);
    }

    // ── dialog.save ──────────────────────────────────────────────────────

    #[tokio::test]
    async fn dialog_save_returns_stub_path_and_allowlists_it() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("out.pdf").to_string_lossy().to_string();
        let s = StubServices { save_returns: Some(target.clone()), ..Default::default() };
        let r = run(&s, &["dialog"], "host.dialog.save", serde_json::json!({"default_filename": "out.pdf"})).await;
        assert_eq!(r.result.unwrap()["path"], target);
        assert!(s.is_dialog_path("test.plugin", &target));
    }

    #[tokio::test]
    async fn dialog_open_cancelled_returns_null_paths() {
        let s = StubServices::default(); // dialog_returns empty → None
        let r = run(&s, &["dialog"], "host.dialog.open", serde_json::json!({})).await;
        assert!(r.result.unwrap()["paths"].is_null());
    }
}
