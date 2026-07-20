//! exlibris v2 plugin: the whole import pipeline (calibre subprocess, atomic fs
//! copy/rename, sha256 hashing, sotvault/rawvault listing, rules I/O, shared
//! config) moved off Tauri onto notemd-plugin-sdk. Pure request-response: the
//! UI window drives every operation via `ui.request`; there is NO streaming
//! (the frontend tracks import progress in local state).
//!
//! Every command body is ported VERBATIM from the v1 `exlibris/src-tauri/src/
//! lib.rs` `#[tauri::command]` functions — they are tauri-free logic (pure fs /
//! subprocess / hashing / yaml). `on_ui_request` parses each method's params
//! out of the JSON envelope and returns a `serde_json::Value`.
//!
//! v1 (`exlibris/`, standalone app) stays until ④c; this crate reads/writes the
//! SAME shared config file at `~/Library/Application Support/
//! com.laobu.mdeditor-shared/config.json` (native binary, full fs), so the two
//! share paths seamlessly.

pub mod calibre;
pub mod fs_ops;
pub mod hash;
pub mod shared_config;

use notemd_plugin_sdk::{self as sdk, plugin_protocol as proto, NotemdPlugin};
use serde::Serialize;
use serde_json::{json, Value};
use std::path::Path;
use std::time::Duration;

// ── SotvaultEntry (ported verbatim from v1 lib.rs) ───────────────────────────

#[derive(Serialize)]
pub struct SotvaultEntry {
    pub rule_dir: String,
    pub book_name: String,
    pub meta_yaml: String,
}

pub struct ExlibrisPlugin;

impl ExlibrisPlugin {
    pub fn new() -> Self {
        Self
    }
}

impl Default for ExlibrisPlugin {
    fn default() -> Self {
        Self::new()
    }
}

impl NotemdPlugin for ExlibrisPlugin {
    fn initialize(&mut self, host: &sdk::Host, _params: &proto::InitializeParams) {
        host.log_info("exlibris v2 initialized");
    }

    fn activate(&mut self, host: &sdk::Host, _p: &proto::ActivateParams) -> Result<(), String> {
        host.log_info("exlibris v2 activated");
        Ok(())
    }

    fn deactivate(&mut self, _host: &sdk::Host) {}

    /// exlibris has no menu/CLI command — the window drives everything via
    /// `ui.request`. This satisfies the trait but is never reached for exlibris.
    fn execute_command(
        &mut self,
        _host: &sdk::Host,
        params: &proto::ExecuteCommandParams,
    ) -> Result<Value, String> {
        Err(format!(
            "exlibris has no command '{}'; use the ExLibris window",
            params.command
        ))
    }

    fn on_ui_request(&mut self, _host: &sdk::Host, method: &str, params: Value) -> Result<Value, String> {
        // The two calibre operations are async; run the whole dispatch on the
        // current multi-thread runtime so we can block_on them (mirrors
        // openclaw). Everything else is synchronous fs/hash/yaml.
        tokio::task::block_in_place(move || {
            tokio::runtime::Handle::current().block_on(async move { dispatch(method, params).await })
        })
    }
}

// ── param helpers ────────────────────────────────────────────────────────────

fn str_param(params: &Value, key: &str) -> Result<String, String> {
    params
        .get(key)
        .and_then(|v| v.as_str())
        .map(String::from)
        .ok_or_else(|| format!("missing param: {key}"))
}

fn u64_param(params: &Value, key: &str) -> Result<u64, String> {
    params
        .get(key)
        .and_then(|v| v.as_u64())
        .ok_or_else(|| format!("missing param: {key}"))
}

/// Dispatch one of the 15 window operations. Each arm mirrors the corresponding
/// v1 `#[tauri::command]` body, returning a `serde_json::Value`. Method names
/// match the v1 command names exactly, so the UI's `bridge.request('<name>', …)`
/// (with the `plugin.` prefix stripped by the host) reaches the right arm.
async fn dispatch(method: &str, params: Value) -> Result<Value, String> {
    match method {
        "ping" => Ok(json!("pong")),

        "sotvault_list_meta" => {
            let sotvault = str_param(&params, "sotvault")?;
            let out = sotvault_list_meta(sotvault)?;
            serde_json::to_value(out).map_err(|e| e.to_string())
        }

        "fs_atomic_copy" => {
            let src = str_param(&params, "src")?;
            let dst = str_param(&params, "dst")?;
            let p = fs_ops::atomic_copy_with_suffix(Path::new(&src), Path::new(&dst))
                .map_err(|e| e.to_string())?;
            Ok(json!(p.to_string_lossy().to_string()))
        }

        "fs_rename_strict" => {
            let src = str_param(&params, "src")?;
            let dst = str_param(&params, "dst")?;
            fs_ops::rename_strict(Path::new(&src), Path::new(&dst)).map_err(|e| e.to_string())?;
            Ok(json!(null))
        }

        "hash_file_sha256" => {
            let path = str_param(&params, "path")?;
            let h = hash::file_sha256(Path::new(&path)).map_err(|e| e.to_string())?;
            Ok(json!(h))
        }

        "write_text_file" => {
            let path = str_param(&params, "path")?;
            let content = str_param(&params, "content")?;
            write_text_file(path, content)?;
            Ok(json!(null))
        }

        "read_text_file" => {
            let path = str_param(&params, "path")?;
            let s = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
            Ok(json!(s))
        }

        "rules_read" => {
            let sotvault = str_param(&params, "sotvault")?;
            Ok(json!(rules_read(sotvault)?))
        }

        "rules_write" => {
            let sotvault = str_param(&params, "sotvault")?;
            let content = str_param(&params, "content")?;
            rules_write(sotvault, content)?;
            Ok(json!(null))
        }

        "rawvault_list_files" => {
            let rawvault = str_param(&params, "rawvault")?;
            let out = rawvault_list_files(rawvault)?;
            serde_json::to_value(out).map_err(|e| e.to_string())
        }

        "shared_config_read" => {
            let path = shared_config::config_path().map_err(|e| e.to_string())?;
            let cfg = shared_config::read(&path).map_err(|e| e.to_string())?;
            serde_json::to_value(cfg).map_err(|e| e.to_string())
        }

        "shared_config_write" => {
            let cfg: shared_config::SharedConfig =
                serde_json::from_value(params.get("cfg").cloned().unwrap_or(params))
                    .map_err(|e| format!("bad cfg: {e}"))?;
            let path = shared_config::config_path().map_err(|e| e.to_string())?;
            shared_config::write(&path, &cfg).map_err(|e| e.to_string())?;
            Ok(json!(null))
        }

        "calibre_detect" => {
            let user = params
                .get("userConfigured")
                .and_then(|v| v.as_str())
                .map(std::path::PathBuf::from);
            let out = calibre::detect(user.as_deref()).map(|p| p.to_string_lossy().to_string());
            Ok(json!(out))
        }

        "calibre_extract_meta" => {
            let binary_dir = str_param(&params, "binaryDir")?;
            let file = str_param(&params, "file")?;
            let timeout_secs = u64_param(&params, "timeoutSecs")?;
            let meta = calibre::extract_meta(
                Path::new(&binary_dir),
                Path::new(&file),
                Duration::from_secs(timeout_secs),
            )
            .await
            .map_err(|e| e.to_string())?;
            serde_json::to_value(meta).map_err(|e| e.to_string())
        }

        "calibre_convert" => {
            let binary_dir = str_param(&params, "binaryDir")?;
            let src = str_param(&params, "src")?;
            let dst = str_param(&params, "dst")?;
            let timeout_secs = u64_param(&params, "timeoutSecs")?;
            calibre::convert(
                Path::new(&binary_dir),
                Path::new(&src),
                Path::new(&dst),
                Duration::from_secs(timeout_secs),
            )
            .await
            .map_err(|e| e.to_string())?;
            Ok(json!(null))
        }

        other => Err(format!("unknown ui method: {other}")),
    }
}

// ── Command bodies (ported verbatim from v1 lib.rs, tauri attribute removed) ──

fn sotvault_list_meta(sotvault: String) -> Result<Vec<SotvaultEntry>, String> {
    let root = std::path::PathBuf::from(&sotvault);
    let mut out = Vec::new();
    for entry in walkdir::WalkDir::new(&root)
        .max_depth(3)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if entry.file_name() != "meta.yml" {
            continue;
        }
        let p = entry.path();
        // expected layout: <sotvault>/<rule_dir>/<book_name>/meta.yml
        let book_dir = match p.parent() {
            Some(b) => b,
            None => continue,
        };
        let rule_dir_path = match book_dir.parent() {
            Some(r) => r,
            None => continue,
        };
        if rule_dir_path == root {
            continue;
        } // depth 1: skip top-level meta.yml
        if rule_dir_path
            .file_name()
            .map(|s| s.to_string_lossy().starts_with('.'))
            == Some(true)
        {
            continue; // skip .exlibris/
        }
        let book_name = book_dir
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        let rule_dir = rule_dir_path
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        let yaml = std::fs::read_to_string(p).map_err(|e| e.to_string())?;
        out.push(SotvaultEntry {
            rule_dir,
            book_name,
            meta_yaml: yaml,
        });
    }
    Ok(out)
}

fn write_text_file(path: String, content: String) -> Result<(), String> {
    let p = std::path::PathBuf::from(&path);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = p.with_extension(format!(
        "{}.tmp",
        p.extension().and_then(|s| s.to_str()).unwrap_or("")
    ));
    std::fs::write(&tmp, content).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())?;
    Ok(())
}

fn rules_read(sotvault: String) -> Result<String, String> {
    let p = std::path::PathBuf::from(&sotvault).join(".exlibris/rules.yml");
    match std::fs::read_to_string(&p) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}

fn rules_write(sotvault: String, content: String) -> Result<(), String> {
    let p = std::path::PathBuf::from(&sotvault).join(".exlibris/rules.yml");
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = p.with_extension("yml.tmp");
    std::fs::write(&tmp, content).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())?;
    Ok(())
}

fn rawvault_list_files(rawvault: String) -> Result<Vec<String>, String> {
    let root = std::path::PathBuf::from(&rawvault);
    let books_root = root.join("books");
    if !books_root.is_dir() {
        return Ok(vec![]);
    }
    let mut out = Vec::new();
    for entry in walkdir::WalkDir::new(&books_root)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let rel = entry.path().strip_prefix(&root).map_err(|e| e.to_string())?;
        out.push(rel.to_string_lossy().to_string());
    }
    Ok(out)
}

// ── Unit tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn ping_returns_pong() {
        let out = dispatch("ping", json!({})).await.unwrap();
        assert_eq!(out, json!("pong"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn unknown_method_errors() {
        let err = dispatch("nope", json!({})).await.unwrap_err();
        assert!(err.contains("unknown ui method"), "{err}");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn hash_file_sha256_matches_known_vector() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("hello");
        std::fs::write(&p, "hello").unwrap();
        let out = dispatch("hash_file_sha256", json!({ "path": p.to_string_lossy() }))
            .await
            .unwrap();
        assert_eq!(
            out,
            json!("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824")
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn write_then_read_text_file_round_trip() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("sub/note.md");
        dispatch(
            "write_text_file",
            json!({ "path": p.to_string_lossy(), "content": "hello world" }),
        )
        .await
        .unwrap();
        let out = dispatch("read_text_file", json!({ "path": p.to_string_lossy() }))
            .await
            .unwrap();
        assert_eq!(out, json!("hello world"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn rules_read_missing_returns_empty_string() {
        let tmp = TempDir::new().unwrap();
        let out = dispatch("rules_read", json!({ "sotvault": tmp.path().to_string_lossy() }))
            .await
            .unwrap();
        assert_eq!(out, json!(""));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn rules_write_then_read_round_trip() {
        let tmp = TempDir::new().unwrap();
        let sv = tmp.path().to_string_lossy().to_string();
        dispatch(
            "rules_write",
            json!({ "sotvault": sv, "content": "version: 1\nrules: []\n" }),
        )
        .await
        .unwrap();
        let out = dispatch("rules_read", json!({ "sotvault": sv })).await.unwrap();
        assert_eq!(out, json!("version: 1\nrules: []\n"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn sotvault_list_meta_finds_book_dirs() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        // <sotvault>/tech/MyBook/meta.yml
        let book = root.join("tech/MyBook");
        std::fs::create_dir_all(&book).unwrap();
        std::fs::write(book.join("meta.yml"), "title: MyBook\n").unwrap();
        // a hidden dir must be skipped
        let hidden = root.join(".exlibris/x");
        std::fs::create_dir_all(&hidden).unwrap();
        std::fs::write(hidden.join("meta.yml"), "title: x\n").unwrap();

        let out = dispatch("sotvault_list_meta", json!({ "sotvault": root.to_string_lossy() }))
            .await
            .unwrap();
        let arr = out.as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["rule_dir"], "tech");
        assert_eq!(arr[0]["book_name"], "MyBook");
        assert_eq!(arr[0]["meta_yaml"], "title: MyBook\n");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn rawvault_list_files_returns_relative_paths() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let books = root.join("books/2025/202501");
        std::fs::create_dir_all(&books).unwrap();
        std::fs::write(books.join("A.epub"), "x").unwrap();

        let out = dispatch("rawvault_list_files", json!({ "rawvault": root.to_string_lossy() }))
            .await
            .unwrap();
        assert_eq!(out, json!(["books/2025/202501/A.epub"]));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn fs_atomic_copy_and_rename_strict() {
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("src.txt");
        std::fs::write(&src, "data").unwrap();
        let dst = tmp.path().join("out/dst.txt");
        let out = dispatch(
            "fs_atomic_copy",
            json!({ "src": src.to_string_lossy(), "dst": dst.to_string_lossy() }),
        )
        .await
        .unwrap();
        assert_eq!(out, json!(dst.to_string_lossy()));
        assert_eq!(std::fs::read_to_string(&dst).unwrap(), "data");

        // rename_strict errors when the destination exists.
        let existing = tmp.path().join("existing");
        std::fs::create_dir(&existing).unwrap();
        let err = dispatch(
            "fs_rename_strict",
            json!({ "src": src.to_string_lossy(), "dst": existing.to_string_lossy() }),
        )
        .await
        .unwrap_err();
        assert!(err.contains("already exists"), "{err}");
    }
}
