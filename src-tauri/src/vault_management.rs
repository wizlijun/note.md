//! Desktop Vault selection is a single serialized operation. Local storage,
//! Git initialization, and network sync deliberately have separate approvals.
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_store::StoreExt;
use crate::vault_sync::{git_ops, service, SyncState, VaultSyncManager};

pub(crate) static OPERATIONS: Mutex<()> = Mutex::new(());
const AUTH_KEY: &str = "vaultSyncAuthorizationsV1";
const ONBOARDING_KEY: &str = "vaultOnboardingV1";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitInfo {
    pub state: String,
    pub branch: Option<String>,
    pub remote: Option<String>,
    pub has_commits: bool,
    pub author_configured: bool,
    pub error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultInfo {
    pub root: Option<String>,
    pub home_dir: Option<String>,
    pub documents_dir: Option<String>,
    pub accessible: bool,
    pub error: Option<String>,
    pub git: GitInfo,
    pub sync_enabled: bool,
    pub onboarding: Option<String>,
}

fn current_root(app: &AppHandle) -> Option<String> {
    app.state::<Arc<VaultSyncManager>>().repo_path.lock().unwrap().clone()
}

fn checked_root(app: &AppHandle, expected: Option<&str>) -> Result<Option<String>, String> {
    let current = current_root(app);
    if current.as_deref() != expected { return Err("Vault changed. Refresh and try again.".into()); }
    Ok(current)
}

fn normalized(path: &Path) -> PathBuf { path.canonicalize().unwrap_or_else(|_| path.to_path_buf()) }

/// Only init may migrate the pre-existing root. Missing or malformed per-root
/// authorization never grants permission to run a new sync task.
pub fn sync_enabled(app: &AppHandle, root: &str) -> Result<bool, String> {
    let store = app.store("settings.json").map_err(|e| e.to_string())?;
    authorization_value(store.get(AUTH_KEY).as_ref(), &normalized(Path::new(root)).to_string_lossy())
}

fn authorization_value(value: Option<&Value>, root: &str) -> Result<bool, String> {
    let Some(value) = value else { return Ok(false); };
    let object = value.as_object().ok_or("Invalid Vault sync preferences")?;
    match object.get(root) {
        None => Ok(false),
        Some(Value::Bool(enabled)) => Ok(*enabled),
        _ => Err("Invalid Vault sync authorization".into()),
    }
}

pub(crate) fn migrate_legacy_sync(app: &AppHandle, root: &str) -> Result<(), String> {
    let store = app.store("settings.json").map_err(|e| e.to_string())?;
    if store.get(AUTH_KEY).is_none() {
        // The old startup service could run only with local .git metadata. A
        // legacy plain folder must not acquire authorization when Git is later
        // initialized from Settings.
        authorization(app, root, Path::new(root).join(".git").exists())?;
    }
    Ok(())
}

pub(crate) fn require_main(label: &str) -> Result<(), String> {
    if label != "main" { return Err("Vault management is only available in the main window".into()); }
    Ok(())
}

pub(crate) fn authorization(app: &AppHandle, root: &str, enabled: bool) -> Result<(), String> {
    let store = app.store("settings.json").map_err(|e| e.to_string())?;
    let previous = store.get(AUTH_KEY);
    let mut values = previous.clone().unwrap_or_else(|| json!({}));
    let object = values.as_object_mut().ok_or("Invalid Vault sync preferences")?;
    object.insert(normalized(Path::new(root)).to_string_lossy().into_owned(), json!(enabled));
    store.set(AUTH_KEY, values);
    if let Err(error) = store.save() {
        if let Some(v) = previous { store.set(AUTH_KEY, v); } else { store.delete(AUTH_KEY); }
        return Err(error.to_string());
    }
    Ok(())
}

fn empty_git(state: &str, error: Option<String>) -> GitInfo {
    GitInfo { state: state.into(), branch: None, remote: None, has_commits: false, author_configured: false, error }
}

fn redact_remote(remote: &str) -> String {
    if remote.contains("://") {
        if let Ok(mut url) = url::Url::parse(remote) {
            let _ = url.set_username("");
            let _ = url.set_password(None);
            url.set_query(None);
            url.set_fragment(None);
            return url.to_string();
        }
        return "[invalid remote URL]".into();
    }
    remote.to_string()
}

pub fn inspect_git(root: &Path) -> GitInfo {
    if git_ops::version().is_none() { return empty_git("unavailable", None); }
    match git_ops::run_git(root, &["rev-parse", "--show-toplevel"]) {
        Ok(top) if normalized(Path::new(top.trim())) == normalized(root) => {
            GitInfo {
                state: "ready".into(),
                branch: git_ops::run_git(root, &["symbolic-ref", "--quiet", "--short", "HEAD"]).ok().map(|s| s.trim().into()),
                remote: git_ops::run_git(root, &["remote", "get-url", "origin"]).ok().map(|s| redact_remote(s.trim())),
                has_commits: git_ops::run_git(root, &["rev-parse", "--verify", "HEAD"]).is_ok(),
                author_configured: ["user.name", "user.email"].iter().all(|key| git_ops::run_git(root, &["config", "--get", key]).is_ok_and(|s| !s.trim().is_empty())),
                error: None,
            }
        }
        Ok(_) => empty_git("invalid", Some("This folder belongs to a parent Git repository. Select its root instead.".into())),
        Err(error) => {
            // A failed query is not permission to overwrite a repository. Detect
            // ancestor metadata and bare repos, as well as damaged local .git.
            let marker = root.ancestors().any(|p| p.join(".git").symlink_metadata().is_ok());
            let bare = root.join("HEAD").exists() && root.join("objects").is_dir();
            if marker || bare || !error.contains("not a git repository") {
                empty_git("invalid", Some(error))
            } else { empty_git("none", None) }
        }
    }
}

fn inspect(app: &AppHandle) -> Result<VaultInfo, String> {
    let root = current_root(app);
    let store = app.store("settings.json").map_err(|e| e.to_string())?;
    let error = root.as_ref().and_then(|r| {
        let p = Path::new(r);
        if let Err(reason) = crate::sotvault::root_guard::check(p) { Some(format!("Vault folder is unavailable or unsafe: {reason:?}")) }
        else if p.metadata().is_ok_and(|m| m.permissions().readonly()) { Some("Vault folder is read-only".into()) }
        else { std::fs::read_dir(p).err().map(|e| e.to_string()) }
    });
    let accessible = root.is_some() && error.is_none();
    let git = if accessible { inspect_git(Path::new(root.as_deref().unwrap())) } else { empty_git("none", None) };
    let enabled = root.as_deref().map(|r| sync_enabled(app, r)).transpose()?.unwrap_or(false);
    Ok(VaultInfo {
        root, home_dir: dirs::home_dir().map(|p| p.to_string_lossy().into_owned()),
        documents_dir: dirs::document_dir().map(|p| p.to_string_lossy().into_owned()),
        accessible, error, git, sync_enabled: enabled,
        onboarding: store.get(ONBOARDING_KEY).and_then(|v| v.as_str().map(str::to_owned)),
    })
}

fn validate_candidate(path: &Path, old: Option<&str>) -> Result<PathBuf, String> {
    let path = path.canonicalize().map_err(|e| e.to_string())?;
    crate::sotvault::root_guard::check(&path).map_err(|e| format!("This folder cannot be a Vault: {e:?}"))?;
    if let Some(old) = old {
        let old = normalized(Path::new(old));
        if old != path && (old.starts_with(&path) || path.starts_with(&old)) {
            return Err("Vault folders must not contain one another".into());
        }
    }
    // Probe without touching existing data. The tempfile removes itself even if
    // a later validation fails; merely observing the directory never probes.
    tempfile::Builder::new().prefix(".notemd-write-check-").tempfile_in(&path).map_err(|e| format!("Vault folder is not writable: {e}"))?;
    Ok(path)
}

fn validate_name(name: &str) -> Result<(), String> {
    if name.trim().is_empty() || name != name.trim() || name.contains(['/', '\\'])
        || name.chars().any(|c| c.is_control())
        || !matches!((Path::new(name).components().next(), Path::new(name).components().nth(1)), (Some(Component::Normal(_)), None)) {
        return Err("Choose a valid folder name".into());
    }
    #[cfg(windows)]
    if name.contains(['<', '>', ':', '"', '|', '?', '*']) || name.ends_with('.') {
        return Err("Choose a valid Windows folder name".into());
    }
    Ok(())
}

#[derive(Debug)]
struct ConfigurationError { message: String, rollback_failed: bool }
impl From<String> for ConfigurationError {
    fn from(message: String) -> Self { Self { message, rollback_failed: false } }
}
impl From<&str> for ConfigurationError {
    fn from(message: &str) -> Self { message.to_owned().into() }
}

fn persist_root(app: &AppHandle, new: &str) -> Result<(), ConfigurationError> {
    let shared_path = crate::shared_config::config_path().map_err(|e| e.to_string())?;
    let old_bytes = match std::fs::read(&shared_path) {
        Ok(v) => Some(v), Err(e) if e.kind() == std::io::ErrorKind::NotFound => None, Err(e) => return Err(e.to_string().into()),
    };
    let mut shared: Value = old_bytes.as_deref().map(serde_json::from_slice).transpose().map_err(|e| format!("Invalid shared configuration: {e}"))?.unwrap_or_else(|| json!({"version":1}));
    shared.as_object_mut().ok_or("Invalid shared configuration")?.insert("sotvault".into(), json!(new));
    let store = app.store("settings.json").map_err(|e| e.to_string())?;
    let old_root = store.get("vault_sync.repo_path");
    let old_auth = store.get(AUTH_KEY);
    let old_onboarding = store.get(ONBOARDING_KEY);
    let mut auth = old_auth.clone().unwrap_or_else(|| json!({}));
    let auth_object = auth.as_object_mut().ok_or("Invalid Vault sync preferences")?;
    auth_object.entry(new.to_string()).or_insert(json!(false));
    commit_root_configuration(&shared_path, old_bytes.as_deref(), &serde_json::to_vec_pretty(&shared).map_err(|e| e.to_string())?, |rollback| {
        if rollback {
            for (key, value) in [("vault_sync.repo_path", &old_root), (AUTH_KEY, &old_auth), (ONBOARDING_KEY, &old_onboarding)] {
                if let Some(v) = value { store.set(key, v.clone()); } else { store.delete(key); }
            }
        } else {
            store.set("vault_sync.repo_path", json!(new));
            store.set(AUTH_KEY, auth.clone());
            store.set(ONBOARDING_KEY, json!("completed"));
        }
        store.save().map_err(|e| e.to_string())
    })
}

/// The store callback restores both its in-memory values and its persisted file.
/// Rollback is attempted for both stores even when restoring one of them fails.
fn commit_root_configuration(
    shared_path: &Path, previous: Option<&[u8]>, next: &[u8],
    mut save_settings: impl FnMut(bool) -> Result<(), String>,
) -> Result<(), ConfigurationError> {
    atomic_write(shared_path, next)?;
    if let Err(error) = save_settings(false) {
        let restore = if let Some(bytes) = previous { atomic_write(shared_path, bytes) }
            else { std::fs::remove_file(shared_path).map_err(|e| e.to_string()) };
        let settings_restore = save_settings(true);
        if let Err(rollback) = restore { return Err(ConfigurationError { message: format!("Configuration save failed: {error}; rollback failed: {rollback}. Sync remains paused."), rollback_failed: true }); }
        if let Err(rollback) = settings_restore { return Err(ConfigurationError { message: format!("Configuration save failed: {error}; settings rollback failed: {rollback}. Sync remains paused."), rollback_failed: true }); }
        return Err(format!("Configuration save failed: {error}").into());
    }
    Ok(())
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let parent = path.parent().ok_or("Invalid configuration path")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    file.write_all(bytes).map_err(|e| e.to_string())?;
    file.as_file().sync_all().map_err(|e| e.to_string())?;
    file.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}

fn activate(app: &AppHandle, path: &Path, expected: Option<&str>) -> Result<VaultInfo, String> {
    let old = checked_root(app, expected)?;
    if old.as_ref().is_some_and(|r| normalized(Path::new(r)) == normalized(path)) { return inspect(app); }
    let path = validate_candidate(path, old.as_deref())?;
    let new = path.to_string_lossy().into_owned();
    // Native plugin windows can hold drafts unknown to the main document store.
    if old.is_some() && app.webview_windows().keys().any(|label| label.starts_with("plugin-")) {
        return Err("Close plugin windows before changing the Vault location".into());
    }
    let was_running = app.state::<Arc<VaultSyncManager>>().worker.lock().unwrap().as_ref().is_some_and(|h| !h.is_finished());
    service::stop(app)?;
    crate::agents_sync::stop(app);
    // Keep the current root unchanged until both persistent copies succeed.
    // Restore the old services only if both persistent copies rolled back.
    if let Err(e) = crate::sotvault::vault_id::ensure(&path).map_err(|e| ConfigurationError::from(e.to_string())).and_then(|_| persist_root(app, &new)) {
        if !e.rollback_failed {
            if let Some(ref old) = old {
                crate::agents_sync::restart(app, old);
                if was_running { let _ = service::start(app); }
            }
        }
        return Err(e.message);
    }
    let mgr = app.state::<Arc<VaultSyncManager>>();
    *mgr.repo_path.lock().unwrap() = Some(new.clone());
    *mgr.state.lock().unwrap() = SyncState::Stopped;
    *mgr.last_sync.lock().unwrap() = None;
    *mgr.error_msg.lock().unwrap() = None;
    mgr.skipped_large_files.lock().unwrap().clear();
    crate::agents_sync::restart(app, &new);
    crate::search::open_vault(app, &path);
    if sync_enabled(app, &new)? {
        if let Err(error) = service::start(app) { *mgr.error_msg.lock().unwrap() = Some(error); *mgr.state.lock().unwrap() = SyncState::Error; }
    }
    crate::rebuild_menu(app);
    crate::refresh_tray_status(app);
    let _ = app.emit("vault-root-changed", &new);
    inspect(app)
}

#[tauri::command]
pub async fn vault_inspect(app: AppHandle) -> Result<VaultInfo, String> {
    tauri::async_runtime::spawn_blocking(move || { let _guard = OPERATIONS.lock().unwrap(); inspect(&app) }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn vault_create(app: AppHandle, window: tauri::WebviewWindow, parent: String, name: String, expected_root: Option<String>) -> Result<VaultInfo, String> {
    require_main(window.label())?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = OPERATIONS.lock().unwrap();
        if checked_root(&app, expected_root.as_deref())?.is_some() { return Err("A Vault is already configured".into()); }
        validate_name(&name)?;
        let parent = Path::new(&parent).canonicalize().map_err(|e| e.to_string())?;
        let path = parent.join(name);
        // Reject dangerous parents before creating anything (Home itself is a
        // valid parent, while the candidate is checked again after creation).
        crate::sotvault::root_guard::check_new(&path).map_err(|e| format!("Invalid Vault location: {e:?}"))?;
        std::fs::create_dir(&path).map_err(|e| e.to_string())?;
        activate(&app, &path, None).map_err(|e| format!("Folder created at {} but Vault activation failed: {e}", path.display()))
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn vault_activate(app: AppHandle, window: tauri::WebviewWindow, path: String, expected_root: Option<String>) -> Result<VaultInfo, String> {
    require_main(window.label())?;
    tauri::async_runtime::spawn_blocking(move || { let _guard = OPERATIONS.lock().unwrap(); activate(&app, Path::new(&path), expected_root.as_deref()) }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn vault_init_git(app: AppHandle, window: tauri::WebviewWindow, expected_root: String) -> Result<VaultInfo, String> {
    require_main(window.label())?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = OPERATIONS.lock().unwrap();
        checked_root(&app, Some(&expected_root))?;
        let root = validate_candidate(Path::new(&expected_root), None)?;
        let info = inspect_git(&root);
        match info.state.as_str() {
            "ready" => return inspect(&app),
            "none" => {},
            _ => return Err(info.error.unwrap_or_else(|| "Git is unavailable".into())),
        }
        git_ops::run_git(&root, &["init", "--initial-branch=main"])?;
        inspect(&app)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn vault_set_sync(app: AppHandle, window: tauri::WebviewWindow, expected_root: String, enabled: bool) -> Result<VaultInfo, String> {
    require_main(window.label())?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = OPERATIONS.lock().unwrap();
        checked_root(&app, Some(&expected_root))?;
        if enabled {
            let git = inspect_git(Path::new(&expected_root));
            if git.state != "ready" || git.branch.as_deref() != Some("main") || git.remote.is_none() || !git.has_commits || !git.author_configured {
                return Err("Sync requires an origin remote, main branch, a first commit, and Git author identity".into());
            }
            authorization(&app, &expected_root, true)?;
            if let Err(error) = service::start(&app) { let _ = authorization(&app, &expected_root, false); return Err(error); }
        } else {
            authorization(&app, &expected_root, false)?;
            service::stop(&app)?;
        }
        crate::refresh_tray_status(&app);
        inspect(&app)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn vault_set_onboarding(app: AppHandle, window: tauri::WebviewWindow, value: String) -> Result<(), String> {
    require_main(window.label())?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = OPERATIONS.lock().unwrap();
        if !matches!(value.as_str(), "completed" | "skipped") { return Err("Invalid onboarding state".into()); }
        let store = app.store("settings.json").map_err(|e| e.to_string())?;
        let old = store.get(ONBOARDING_KEY);
        store.set(ONBOARDING_KEY, json!(value));
        if let Err(error) = store.save() {
            if let Some(value) = old { store.set(ONBOARDING_KEY, value); } else { store.delete(ONBOARDING_KEY); }
            return Err(error.to_string());
        }
        Ok(())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn vault_sync_now_for_root(app: AppHandle, window: tauri::WebviewWindow, expected_root: String) -> Result<VaultInfo, String> {
    require_main(window.label())?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = OPERATIONS.lock().unwrap();
        checked_root(&app, Some(&expected_root))?;
        service::sync_once(&app)?;
        inspect(&app)
    }).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn git(root: &Path, args: &[&str]) -> String {
        let output = Command::new("git").current_dir(root).args(args)
            .env("GIT_CONFIG_GLOBAL", "/dev/null").env("GIT_CONFIG_NOSYSTEM", "1")
            .output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        String::from_utf8_lossy(&output.stdout).trim().into()
    }

    #[test]
    fn authorization_never_leaks_to_another_root_or_from_invalid_data() {
        assert!(!authorization_value(None, "/a").unwrap());
        assert!(authorization_value(Some(&json!({"/a":true})), "/a").unwrap());
        assert!(!authorization_value(Some(&json!({"/a":true})), "/b").unwrap());
        assert!(!authorization_value(Some(&json!({"/a":false})), "/a").unwrap());
        for value in [json!(true), json!({"/a":"true"}), json!([])] {
            assert!(authorization_value(Some(&value), "/a").is_err());
        }
    }

    #[test]
    fn only_main_can_manage_vault() {
        assert!(require_main("main").is_ok());
        for label in ["plugin-notemd.sumi-main", "smart-search", "logs", ""] {
            assert!(require_main(label).is_err());
        }
    }

    #[test]
    fn folder_names_cannot_escape_parent() {
        for name in ["", " ", ".", "..", "../vault", "a/b", "a\\b", "a\n", " vault"] {
            assert!(validate_name(name).is_err(), "{name}");
        }
        for name in ["My Vault", "笔记", "notes.md"] { assert!(validate_name(name).is_ok()); }
    }

    #[test]
    fn remote_credentials_are_not_exposed() {
        assert_eq!(redact_remote("https://token@github.com/me/vault.git"), "https://github.com/me/vault.git");
        assert_eq!(redact_remote("https://me:secret@host:443/a.git"), "https://host/a.git");
        assert_eq!(redact_remote("https://host/repo?token=secret#credential"), "https://host/repo");
        assert_eq!(redact_remote("git@github.com:me/a.git"), "git@github.com:me/a.git");
    }

    #[test]
    fn init_preserves_content_and_creates_no_commit_or_remote() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        std::fs::write(root.join("note.md"), "hello").unwrap();
        std::fs::write(root.join(".gitignore"), "private\n").unwrap();
        assert_eq!(inspect_git(&root).state, "none");
        git_ops::run_git(&root, &["init", "--initial-branch=main"]).unwrap();
        let info = inspect_git(&root);
        assert_eq!(info.state, "ready");
        assert_eq!(info.branch.as_deref(), Some("main"));
        assert!(!info.has_commits);
        assert!(info.remote.is_none());
        assert_eq!(std::fs::read_to_string(root.join("note.md")).unwrap(), "hello");
        assert_eq!(std::fs::read_to_string(root.join(".gitignore")).unwrap(), "private\n");
        assert!(git(&root, &["ls-files"]).is_empty());
    }

    #[test]
    fn distinguishes_parent_bare_corrupt_and_worktree_repositories() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let repository = root.join("repo");
        std::fs::create_dir(&repository).unwrap();
        git(&repository, &["init", "-q", "-b", "main"]);
        let child = repository.join("nested");
        std::fs::create_dir(&child).unwrap();
        assert_eq!(inspect_git(&child).state, "invalid");
        git(&repository, &["-c", "user.name=Tester", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "initial"]);
        let worktree = root.join("worktree");
        git(&repository, &["worktree", "add", "-qb", "other", worktree.to_str().unwrap()]);
        assert!(worktree.join(".git").is_file());
        assert_eq!(inspect_git(&worktree).state, "ready");
        assert_eq!(inspect_git(&worktree).branch.as_deref(), Some("other"));
        let bare = root.join("bare");
        git(&root, &["init", "--bare", bare.to_str().unwrap()]);
        assert_eq!(inspect_git(&bare).state, "invalid");
        let corrupt = root.join("corrupt");
        std::fs::create_dir(&corrupt).unwrap();
        std::fs::write(corrupt.join(".git"), "broken metadata").unwrap();
        assert_eq!(inspect_git(&corrupt).state, "invalid");
    }

    #[test]
    fn two_store_failure_restores_exact_old_files_and_reports_rollback_failure() {
        let temp = tempfile::tempdir().unwrap();
        let shared = temp.path().join("shared.json");
        let settings = temp.path().join("settings.json");
        let old_shared = br#"{ "sotvault": "old", "unknown": 42 }"#;
        let old_settings = br#"{"vault_sync.repo_path":"old","theme":"dark"}"#;
        std::fs::write(&shared, old_shared).unwrap();
        std::fs::write(&settings, old_settings).unwrap();
        let mut calls = vec![];
        let error = commit_root_configuration(&shared, Some(old_shared), br#"{"sotvault":"new"}"#, |rollback| {
            calls.push(rollback);
            if rollback { atomic_write(&settings, old_settings) }
            else {
                std::fs::write(&settings, b"partial settings").unwrap();
                Err("injected settings write failure".into())
            }
        }).unwrap_err();
        assert!(!error.rollback_failed);
        assert_eq!(calls, [false, true]);
        assert_eq!(std::fs::read(&shared).unwrap(), old_shared);
        assert_eq!(std::fs::read(&settings).unwrap(), old_settings);
        let error = commit_root_configuration(&shared, Some(old_shared), b"new", |_| Err("disk failure".into())).unwrap_err();
        assert!(error.rollback_failed);
        assert_eq!(std::fs::read(&shared).unwrap(), old_shared);
    }

    #[test]
    fn failed_first_shared_write_never_touches_settings_and_new_file_rolls_back() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("file");
        std::fs::write(&file, b"existing").unwrap();
        let mut called = false;
        assert!(commit_root_configuration(&file.join("invalid"), None, b"new", |_| { called = true; Ok(()) }).is_err());
        assert!(!called);
        let missing = temp.path().join("new-shared.json");
        assert!(commit_root_configuration(&missing, None, b"new", |rollback| if rollback { Ok(()) } else { Err("injected".into()) }).is_err());
        assert!(!missing.exists());
    }

    #[test]
    fn atomic_configuration_write_preserves_old_file_on_failure() {
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("settings.json");
        atomic_write(&target, br#"{"sotvault":"old","unrelated":42}"#).unwrap();
        let impossible = target.join("child");
        assert!(atomic_write(&impossible, b"replacement").is_err());
        assert_eq!(std::fs::read_to_string(target).unwrap(), r#"{"sotvault":"old","unrelated":42}"#);
    }
}
