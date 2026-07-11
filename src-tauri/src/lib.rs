#[cfg(debug_assertions)]
use std::fs::OpenOptions;
#[cfg(debug_assertions)]
use std::io::Write;
use std::sync::Mutex;
#[cfg(not(target_os = "ios"))]
use tauri::image::Image;
#[cfg(not(target_os = "ios"))]
use tauri::menu::{
    AboutMetadata, Menu, MenuBuilder, MenuItem, MenuItemBuilder, MenuItemKind, PredefinedMenuItem,
    Submenu, SubmenuBuilder,
};
#[cfg(not(target_os = "ios"))]
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, RunEvent, WindowEvent};

pub mod app_dirs;
pub mod openclaw;
pub mod shared_config;

#[cfg(not(target_os = "ios"))]
pub mod cli;
#[cfg(not(target_os = "ios"))]
pub mod plugin_host;
#[cfg(target_os = "ios")]
#[path = "plugin_host_ios.rs"]
pub mod plugin_host;
#[cfg(not(target_os = "ios"))]
pub mod themes;
#[cfg(not(target_os = "ios"))]
pub mod vault_sync;
#[cfg(not(target_os = "ios"))]
pub mod agents_sync;
#[cfg(not(target_os = "ios"))]
pub mod sotvault;

#[cfg(any(target_os = "ios", test))]
pub mod vault_ios;

pub struct PendingFiles(Mutex<Vec<String>>);
#[cfg(not(target_os = "ios"))]
pub struct TrayRepoItem(Mutex<Option<MenuItem<tauri::Wry>>>);
#[cfg(not(target_os = "ios"))]
pub struct RecentMenu(pub Mutex<Option<Submenu<tauri::Wry>>>);

#[tauri::command]
fn drain_pending_files(state: tauri::State<'_, PendingFiles>) -> Vec<String> {
    state.0.lock().unwrap().drain(..).collect()
}

/// Append a diagnostic line to /tmp/mdeditor.log in debug builds (best-effort).
/// Compiled out in release — kept as a no-op so call sites need no `cfg` gates.
#[allow(unused_variables)]
fn dlog(msg: &str) {
    #[cfg(debug_assertions)]
    {
        if let Ok(mut f) = OpenOptions::new()
            .create(true)
            .append(true)
            .open("/tmp/mdeditor.log")
        {
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            let _ = writeln!(f, "{} {}", ts, msg);
        }
    }
}

// ── File helpers ─────────────────────────────────────────────────────────────

fn sanitize_io_err(e: std::io::Error) -> String {
    match e.kind() {
        std::io::ErrorKind::NotFound         => "File not found".to_string(),
        std::io::ErrorKind::PermissionDenied => "Permission denied".to_string(),
        std::io::ErrorKind::AlreadyExists    => "File already exists".to_string(),
        _                                    => "Operation failed".to_string(),
    }
}

/// Validate that the path resolves under the user home, /tmp, /var, or /private.
/// Walks up ancestor dirs to handle not-yet-existing files.
fn safe_path(path: &str) -> Result<std::path::PathBuf, String> {
    use std::path::Path;
    if path.is_empty() {
        return Err("Path must not be empty".to_string());
    }
    if !path.starts_with('/') {
        return Err("Path must be absolute".to_string());
    }
    let p = Path::new(path);
    let canonical = std::fs::canonicalize(p).or_else(|_| {
        let mut parts: Vec<std::ffi::OsString> = Vec::new();
        if let Some(fname) = p.file_name() { parts.push(fname.to_owned()); }
        let mut ancestor = p.parent();
        loop {
            match ancestor {
                Some(dir) if dir.as_os_str().is_empty() => break,
                Some(dir) if dir.exists() => {
                    let mut base = std::fs::canonicalize(dir)
                        .map_err(|e| e.to_string())?;
                    for part in parts.iter().rev() { base.push(part); }
                    // Guard against ".." components in the reconstructed path
                    if base.components().any(|c| c == std::path::Component::ParentDir) {
                        return Err("Path traversal detected".to_string());
                    }
                    return Ok(base);
                }
                Some(dir) => {
                    if let Some(n) = dir.file_name() { parts.push(n.to_owned()); }
                    ancestor = dir.parent();
                }
                None => break,
            }
        }
        Err("Cannot resolve path".to_string())
    })?;

    let home = dirs::home_dir().ok_or("Cannot determine home dir")?;
    if canonical.starts_with(&home) { return Ok(canonical); }
    for prefix in &["/tmp", "/var", "/private"] {
        if canonical.starts_with(prefix) { return Ok(canonical); }
    }
    Err("Path outside allowed directories".to_string())
}

fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    const TABLE: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let input = input.as_bytes();
    let mut buf: Vec<u8> = Vec::with_capacity(input.len() * 3 / 4);
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    for &b in input {
        if matches!(b, b'\n' | b'\r' | b' ') { continue; }
        if b == b'=' { break; }
        let val = TABLE.iter().position(|&c| c == b)
            .ok_or_else(|| "Invalid base64".to_string())? as u32;
        acc = (acc << 6) | val;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            buf.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Ok(buf)
}

/// Write base64-encoded binary data to a file. Creates parent directories.
/// Strips optional `data:...;base64,` prefix automatically.
#[tauri::command]
fn write_file_binary(path: String, base64_data: String) -> Result<(), String> {
    use std::io::Write;
    let dest = safe_path(&path)?;
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(sanitize_io_err)?;
    }
    let raw = if let Some(i) = base64_data.find(";base64,") {
        &base64_data[i + 8..]
    } else {
        base64_data.as_str()
    };
    let bytes = base64_decode(raw)?;
    let mut f = std::fs::File::create(&dest).map_err(sanitize_io_err)?;
    f.write_all(&bytes).map_err(sanitize_io_err)
}

/// Move a file from old_path to new_path. Creates parent directories of new_path.
/// Silently succeeds if old_path does not exist (already migrated).
#[tauri::command]
fn rename_file(old_path: String, new_path: String) -> Result<(), String> {
    let src = safe_path(&old_path)?;
    if !src.exists() { return Ok(()); }
    let dst = safe_path(&new_path)?;
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent).map_err(sanitize_io_err)?;
    }
    std::fs::rename(&src, &dst).map_err(sanitize_io_err)
}

/// Quit the application. Called from the frontend after the close-window
/// dirty-tab confirmation loop completes successfully. macOS does NOT quit
/// the app on its own when the last NSWindow is closed (unlike Windows / Linux),
/// so we trigger it explicitly.
#[cfg(not(target_os = "ios"))]
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

/// Set the enabled state of a plugin-contributed menu item by id.
/// IDs follow the `plugin:<plugin-id>:<command>` convention.
/// Walks the entire menu tree (top-level + submenus) so it finds items
/// regardless of which submenu they were appended to.
#[cfg(not(target_os = "ios"))]
#[tauri::command]
fn set_plugin_menu_item_enabled(app: tauri::AppHandle, id: String, enabled: bool) -> Result<(), String> {
    fn walk<R: tauri::Runtime>(items: Vec<MenuItemKind<R>>, id: &str, enabled: bool) -> bool {
        for item in items {
            match item {
                MenuItemKind::MenuItem(mi) => {
                    if mi.id().0.as_str() == id {
                        let _ = mi.set_enabled(enabled);
                        return true;
                    }
                }
                MenuItemKind::Submenu(sm) => {
                    if let Ok(child) = sm.items() {
                        if walk(child, id, enabled) {
                            return true;
                        }
                    }
                }
                _ => {}
            }
        }
        false
    }
    let menu = app.menu().ok_or_else(|| "no menu set".to_string())?;
    let items = menu.items().map_err(|e| e.to_string())?;
    if walk(items, &id, enabled) {
        Ok(())
    } else {
        Err(format!("menu item not found: {id}"))
    }
}

#[derive(serde::Serialize)]
struct ExtResult {
    ext: String,
    uti: Option<String>,
    ok: bool,
    error: Option<String>,
}

#[cfg(target_os = "macos")]
mod macos_defaults {
    use core_foundation::base::TCFType;
    use core_foundation::string::{CFString, CFStringRef};

    // LaunchServices APIs: deprecated in macOS 12+ in favor of NSWorkspace's
    // async setDefaultApplicationAtURL:toOpenContentType:, but still functional
    // and synchronous (which is much easier to call from Rust FFI).
    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn LSSetDefaultRoleHandlerForContentType(
            in_content_type: CFStringRef,
            in_role: u32,
            in_handler_bundle_id: CFStringRef,
        ) -> i32;

        fn UTTypeCreatePreferredIdentifierForTag(
            in_tag_class: CFStringRef,
            in_tag: CFStringRef,
            in_conforming_to_uti: CFStringRef,
        ) -> CFStringRef;
    }

    const K_LS_ROLES_ALL: u32 = 0xFFFFFFFF;

    /// Resolve the canonical UTI for a filename extension (e.g. "py" → "public.python-script").
    /// Returns None when the system can't determine a UTI.
    pub fn resolve_uti(ext: &str) -> Option<String> {
        let tag_class = CFString::new("public.filename-extension");
        let ext_cf = CFString::new(ext);
        let uti_ref = unsafe {
            UTTypeCreatePreferredIdentifierForTag(
                tag_class.as_concrete_TypeRef(),
                ext_cf.as_concrete_TypeRef(),
                std::ptr::null(),
            )
        };
        if uti_ref.is_null() {
            return None;
        }
        let uti = unsafe { CFString::wrap_under_create_rule(uti_ref) };
        Some(uti.to_string())
    }

    /// Set `bundle_id` as the default handler for the given UTI across all roles.
    /// Returns `Ok(())` on success or `Err(OSStatus)` on failure.
    pub fn set_handler(uti: &str, bundle_id: &str) -> Result<(), i32> {
        let uti_cf = CFString::new(uti);
        let bundle_cf = CFString::new(bundle_id);
        let status = unsafe {
            LSSetDefaultRoleHandlerForContentType(
                uti_cf.as_concrete_TypeRef(),
                K_LS_ROLES_ALL,
                bundle_cf.as_concrete_TypeRef(),
            )
        };
        if status == 0 {
            Ok(())
        } else {
            Err(status)
        }
    }
}

/// Set this app as the macOS default handler for each given file extension.
/// For each extension we resolve the UTI and call LaunchServices to register
/// the bundle as the default handler across all roles. Returns a per-extension
/// result so the frontend can report partial success.
#[cfg(not(target_os = "ios"))]
#[tauri::command]
fn set_default_app_for_extensions(app: tauri::AppHandle, exts: Vec<String>) -> Vec<ExtResult> {
    #[cfg(target_os = "macos")]
    {
        let bundle_id = app.config().identifier.clone();
        exts.into_iter()
            .map(|ext| match macos_defaults::resolve_uti(&ext) {
                None => ExtResult {
                    ext,
                    uti: None,
                    ok: false,
                    error: Some("no UTI registered for this extension".into()),
                },
                Some(uti) => match macos_defaults::set_handler(&uti, &bundle_id) {
                    Ok(()) => ExtResult { ext, uti: Some(uti), ok: true, error: None },
                    Err(status) => ExtResult {
                        ext,
                        uti: Some(uti),
                        ok: false,
                        error: Some(format!("LaunchServices OSStatus {}", status)),
                    },
                },
            })
            .collect()
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        exts.into_iter()
            .map(|ext| ExtResult {
                ext,
                uti: None,
                ok: false,
                error: Some("only supported on macOS".into()),
            })
            .collect()
    }
}

#[cfg(not(target_os = "ios"))]
fn show_chat_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri::WebviewUrl;
    if !plugin_host::is_plugin_enabled("openclaw-chat") { return; }
    let win = app.get_webview_window("chat").or_else(|| {
        tauri::WebviewWindowBuilder::new(app, "chat", WebviewUrl::App("chat.html".into()))
            .title("OpenClaw")
            .inner_size(480.0, 720.0)
            .min_inner_size(360.0, 480.0)
            .resizable(true)
            .decorations(true)
            .visible(false)
            .build()
            .map_err(|e| eprintln!("[chat] window build failed: {e}"))
            .ok()
    });
    if let Some(w) = win {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn show_insights_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri::WebviewUrl;
    let win = app.get_webview_window("insights").or_else(|| {
        tauri::WebviewWindowBuilder::new(app, "insights", WebviewUrl::App("insights.html".into()))
            .title("Reading Insights")
            .inner_size(900.0, 640.0)
            .min_inner_size(520.0, 360.0)
            .resizable(true)
            .decorations(true)
            .visible(false)
            .build()
            .map_err(|e| eprintln!("[insights] window build failed: {e}"))
            .ok()
    });
    if let Some(w) = win {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

#[tauri::command]
async fn editor_show_and_open_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
        let _ = win.unminimize();
        // Defer to existing frontend "open file" event so the editor can decide tabs.
        let _ = win.emit("editor://open-path", &path);
    } else {
        // Main window isn't built; emit a global event the next startup will drain.
        let _ = app.emit("editor://pending-open", &path);
    }
    Ok(())
}

#[tauri::command]
async fn editor_open_remote_buffer(app: tauri::AppHandle, remote_path: String, content: String) -> Result<(), String> {
    use tauri::Manager;
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
        let _ = win.emit("editor://open-remote-buffer", &serde_json::json!({
            "remote_path": remote_path,
            "content": content
        }));
    }
    Ok(())
}

#[tauri::command]
fn file_exists(path: String) -> bool {
    std::path::Path::new(&path).exists()
}

#[tauri::command]
fn shared_config_read() -> Result<crate::shared_config::SharedConfig, String> {
    let path = crate::shared_config::config_path().map_err(|e| e.to_string())?;
    crate::shared_config::read(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn shared_config_write(cfg: crate::shared_config::SharedConfig) -> Result<(), String> {
    let path = crate::shared_config::config_path().map_err(|e| e.to_string())?;
    crate::shared_config::write(&path, &cfg).map_err(|e| e.to_string())
}

fn show_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    } else {
        // Window might have been destroyed, recreate it
        let _ = tauri::WebviewWindowBuilder::new(
            app,
            "main",
            tauri::WebviewUrl::default(),
        )
        .title("M\u{2193}")
        .inner_size(1000.0, 700.0)
        .min_inner_size(600.0, 400.0)
        .build();
    }
}

#[cfg(not(target_os = "ios"))]
fn open_sync_log_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let mgr = app.state::<std::sync::Arc<vault_sync::VaultSyncManager>>();
    let entries = mgr.logs.entries();

    let log_path = std::env::temp_dir().join("vault-sync.log");
    let content: String = entries.iter().map(|e| {
        format!("[{}] [{}] {}\n", e.timestamp, e.level, e.message)
    }).collect();
    let _ = std::fs::write(&log_path, &content);

    show_main_window(app);
    if let Some(path_str) = log_path.to_str() {
        emit_open_file_delayed(app, path_str);
    }
}

#[cfg(not(target_os = "ios"))]
fn pick_repo_and_start(app: &tauri::AppHandle) {
    let mgr = app.state::<std::sync::Arc<vault_sync::VaultSyncManager>>();
    let has_repo = mgr.repo_path.lock().unwrap().is_some();

    if has_repo {
        let _ = vault_sync::vault_sync_start(app.clone());
        save_sync_enabled(app, true);
        update_tray_icon(app, true);
        return;
    }

    let app_clone = app.clone();
    pick_sync_folder_inner(app, move |_path_str| {
        let _ = vault_sync::vault_sync_start(app_clone.clone());
        save_sync_enabled(&app_clone, true);
        update_tray_icon(&app_clone, true);
    });
}

#[cfg(not(target_os = "ios"))]
fn pick_sync_folder(app: &tauri::AppHandle) {
    pick_sync_folder_inner(app, move |_| {});
}

#[cfg(not(target_os = "ios"))]
fn pick_sync_folder_inner(app: &tauri::AppHandle, on_done: impl FnOnce(String) + Send + 'static) {
    use tauri_plugin_dialog::DialogExt;
    use tauri_plugin_store::StoreExt;

    let app_clone = app.clone();
    app.dialog()
        .file()
        .set_title("Select Vault Git Repository")
        .pick_folder(move |folder| {
            if let Some(path) = folder {
                let path_str = path.to_string();
                let mgr = app_clone.state::<std::sync::Arc<vault_sync::VaultSyncManager>>();
                *mgr.repo_path.lock().unwrap() = Some(path_str.clone());

                if let Ok(s) = app_clone.store("settings.json") {
                    let _ = s.set("vault_sync.repo_path", serde_json::json!(&path_str));
                    let _ = s.set("vault_sync.auto_start", serde_json::json!(true));
                    let _ = s.save();
                }

                if let Ok(shared_path) = crate::shared_config::config_path() {
                    if let Ok(mut cfg) = crate::shared_config::read(&shared_path) {
                        cfg.sotvault = Some(path_str.clone());
                        let _ = crate::shared_config::write(&shared_path, &cfg);
                    }
                }

                update_tray_repo_label(&app_clone, &path_str);
                agents_sync::restart(&app_clone, &path_str);
                on_done(path_str);
            }
        });
}

#[cfg(not(target_os = "ios"))]
fn update_tray_repo_label(app: &tauri::AppHandle, path: &str) {
    if let Some(state) = app.try_state::<TrayRepoItem>() {
        if let Some(item) = state.0.lock().unwrap().as_ref() {
            let _ = item.set_text(&format!("Vault: {}", abbreviate_path(path)));
        }
    }
}

#[cfg(not(target_os = "ios"))]
fn abbreviate_path(path: &str) -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    if !home.is_empty() && path.starts_with(&home) {
        format!("~{}", &path[home.len()..])
    } else {
        path.to_string()
    }
}

#[cfg(not(target_os = "ios"))]
fn save_sync_enabled(app: &tauri::AppHandle, enabled: bool) {
    use tauri_plugin_store::StoreExt;
    if let Ok(s) = app.store("settings.json") {
        let _ = s.set("vault_sync.auto_start", serde_json::json!(enabled));
        let _ = s.save();
    }
}

#[cfg(not(target_os = "ios"))]
pub fn update_tray_icon(app: &tauri::AppHandle, active: bool) {
    if let Some(tray) = app.tray_by_id("main") {
        let icon = if active {
            Image::from_bytes(include_bytes!("../icons/tray-icon-active.png"))
        } else {
            Image::from_bytes(include_bytes!("../icons/tray-icon.png"))
        };
        if let Ok(img) = icon {
            let _ = tray.set_icon(Some(img));
        }
    }
}

/// Build the Tauri runtime `Context` from the embedded tauri.conf.json.
///
/// `tauri::generate_context!()` is a proc-macro that emits a `_EMBED_INFO_PLIST`
/// static at its call-site. Calling it from two places in the same crate gives
/// a duplicate-symbol link error. Funneling every consumer through this single
/// helper guarantees one expansion. Both the GUI `run()` and the headless CLI
/// runner use it.
pub fn tauri_context() -> tauri::Context {
    tauri::generate_context!()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    dlog("=== note.md start ===");
    dlog(&format!("argv: {:?}", std::env::args().collect::<Vec<_>>()));

    // rustls 0.23 no longer auto-selects a crypto provider; install ring as
    // the default so reqwest::Client::new() doesn't panic with "No provider
    // set" on first HTTPS use (tauri-plugin-http, tauri-plugin-updater, etc).
    // Safe to ignore Err: it only fires if already installed (e.g. in tests).
    let _ = rustls::crypto::ring::default_provider().install_default();

    let builder = tauri::Builder::default()
        .manage(PendingFiles(Mutex::new(Vec::new())));
    #[cfg(not(target_os = "ios"))]
    let builder = builder.manage(TrayRepoItem(Mutex::new(None)));
    #[cfg(not(target_os = "ios"))]
    let builder = builder.manage(RecentMenu(Mutex::new(None)));
    #[cfg(not(target_os = "ios"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
        dlog(&format!("single_instance argv: {:?}", argv));
        for arg in argv.iter().skip(1) {
            emit_open_file_delayed(app, arg);
        }
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.show();
            let _ = w.set_focus();
        }
    }));
    let app = builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_os::init());
    #[cfg(not(target_os = "ios"))]
    let app = app
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());
    let app = app
        .invoke_handler({
            #[cfg(not(target_os = "ios"))]
            { tauri::generate_handler![
                quit_app,
                drain_pending_files,
                set_default_app_for_extensions,
                set_plugin_menu_item_enabled,
                plugin_host::get_plugin_manifests,
                plugin_host::get_all_plugin_manifests,
                plugin_host::plugin_is_enabled,
                plugin_host::invoke_plugin,
                cli::state::cli_payload,
                cli::state::cli_finish,
                cli::install::cli_install_status,
                cli::install::cli_install,
                cli::install::cli_uninstall,
                cli::install::cli_install_candidates,
                themes::commands::theme_list,
                themes::commands::theme_reveal,
                themes::commands::theme_load_compiled,
                themes::commands::theme_recompile,
                themes::commands::theme_recompile_all,
                themes::commands::theme_restore_builtins,
                themes::commands::theme_import,
                themes::commands::theme_install,
                themes::commands::theme_cancel_import,
                vault_sync::vault_sync_start,
                vault_sync::vault_sync_stop,
                vault_sync::vault_sync_now,
                vault_sync::vault_sync_status,
                vault_sync::vault_sync_logs,
                sotvault::sotvault_vault_root,
                sotvault::sotvault_records,
                sotvault::sotvault_forget,
                sotvault::sotvault_sync_to_vault,
                sotvault::sotvault_check_update,
                sotvault::sotvault_apply_update,
                sotvault::sotvault_accept_current,
                write_file_binary,
                rename_file,
                crate::openclaw::commands::openclaw_connect,
                crate::openclaw::commands::openclaw_send,
                crate::openclaw::commands::openclaw_disconnect,
                crate::openclaw::commands::openclaw_pair_create,
                crate::openclaw::commands::openclaw_pair_claim,
                crate::openclaw::commands::openclaw_revoke_device,
                crate::openclaw::commands::openclaw_forget_device,
                crate::openclaw::commands::openclaw_list_devices,
                crate::openclaw::commands::openclaw_approve_pending,
                crate::openclaw::commands::openclaw_reject_pending,
                crate::openclaw::commands::openclaw_upload_attachment,
                editor_show_and_open_path,
                editor_open_remote_buffer,
                update_recent_menu,
                set_menu_locale,
                file_exists,
                shared_config_read,
                shared_config_write,
            ] }
            #[cfg(target_os = "ios")]
            { tauri::generate_handler![
                drain_pending_files,
                plugin_host::get_plugin_manifests,
                plugin_host::get_all_plugin_manifests,
                plugin_host::plugin_is_enabled,
                plugin_host::invoke_plugin,
                vault_ios::vault_status,
                vault_ios::list_dir::vault_list_dir,
                vault_ios::vault_configure,
                vault_ios::vault_sync_now,
                vault_ios::vault_disconnect,
                write_file_binary,
                rename_file,
                crate::openclaw::commands::openclaw_connect,
                crate::openclaw::commands::openclaw_send,
                crate::openclaw::commands::openclaw_disconnect,
                crate::openclaw::commands::openclaw_pair_create,
                crate::openclaw::commands::openclaw_pair_claim,
                crate::openclaw::commands::openclaw_revoke_device,
                crate::openclaw::commands::openclaw_forget_device,
                crate::openclaw::commands::openclaw_list_devices,
                crate::openclaw::commands::openclaw_approve_pending,
                crate::openclaw::commands::openclaw_reject_pending,
                crate::openclaw::commands::openclaw_upload_attachment,
                editor_show_and_open_path,
                editor_open_remote_buffer,
                file_exists,
                shared_config_read,
                shared_config_write,
            ] }
        })
        .setup(|app| {
            // Dev builds: drop the webview HTTP cache on every launch. Vite's
            // optimized-deps URLs (`?v=<hash>`) are served `immutable`, but the
            // hash only tracks the lockfile — file:-linked @moraya/core content
            // changes keep the same URL, so WKWebView would pin a stale bundle
            // forever (pnpm sync:core alone can't fix that side).
            #[cfg(dev)]
            {
                use tauri::Manager;
                for (_label, w) in app.webview_windows() {
                    let _ = w.clear_all_browsing_data();
                }
            }

            // Migrate legacy vault_sync.repo_path to shared config sotvault
            {
                if let (Ok(app_data_dir), Ok(shared)) = (
                    app.path().app_data_dir(),
                    crate::shared_config::config_path(),
                ) {
                    let legacy_store = app_data_dir.join("settings.json");
                    let _ = crate::shared_config::migrate_vault_sync_repo_to_shared(&shared, &legacy_store);
                }
            }

            #[cfg(not(target_os = "ios"))]
            {
                let vault_mgr = std::sync::Arc::new(vault_sync::VaultSyncManager::new());
                app.manage(vault_mgr);
                vault_sync::init(&app.handle());
                agents_sync::init(&app.handle());
            }

            // plugin_host MUST run before any code that calls is_plugin_enabled.
            plugin_host::init(&app.handle());

            let openclaw_state = if plugin_host::is_plugin_enabled("openclaw-chat") {
                crate::openclaw::init_state(&app.handle())
            } else {
                crate::openclaw::OpenClawState::new_disabled()
            };
            app.manage(openclaw_state);

            #[cfg(target_os = "ios")]
            vault_ios::init(&app.handle());

            #[cfg(not(target_os = "ios"))]
            {
                // Bootstrap themes: ensure dirs exist, copy any missing built-ins,
                // and (re)compile every theme into .compiled/ so the frontend can
                // load fresh CSS without waiting on a separate compile pass.
                if let Err(e) = bootstrap_themes(&app.handle()) {
                    eprintln!("[themes] bootstrap failed: {e}");
                }

                let menu_locale = read_saved_locale(&app.handle());
                let plugin_items = plugin_host::collect_top_menu_items(&menu_locale);
                let (menu, recent_submenu) = build_menu(&app.handle(), &plugin_items, &menu_locale)?;
                *app.state::<RecentMenu>().0.lock().unwrap() = Some(recent_submenu);
                app.set_menu(menu)?;
                app.on_menu_event(|app, event| {
                    if event.id().0.as_str() == "hide-app" {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.hide();
                        }
                        return;
                    }
                    if event.id().0.as_str() == "open-insights" {
                        show_insights_window(app);
                        return;
                    }
                    let _ = app.emit("menu-event", event.id().0.as_str());
                });

                // Persistent menu-bar tray icon. White ✦ sparkle from the
                // note.md brand glyph (active state adds a green badge).
                // Left-click toggles main window visibility; right-click shows menu.
                let tray_icon = Image::from_bytes(include_bytes!("../icons/tray-icon.png"))?;
                let (tray_menu, sync_repo_item) = build_tray_menu(&app.handle(), &menu_locale)?;
                {
                    let tray_item_state = app.state::<TrayRepoItem>();
                    *tray_item_state.0.lock().unwrap() = Some(sync_repo_item.clone());
                }
                let _tray = TrayIconBuilder::with_id("main")
                    .icon(tray_icon)
                    .icon_as_template(false)
                    .tooltip("note.md")
                    .menu(&tray_menu)
                    .show_menu_on_left_click(true)
                    .on_menu_event(|app, event| {
                        match event.id().0.as_str() {
                            "tray-show" => show_main_window(app),
                            "tray-today-note" => {
                                show_main_window(app);
                                let _ = app.emit("tray-today-note", ());
                            }
                            "tray-openclaw" => show_chat_window(app),
                            "tray-sync-repo" => { pick_sync_folder(app); }
                            "tray-sync-start" => { pick_repo_and_start(app); }
                            "tray-sync-stop" => {
                                let _ = vault_sync::vault_sync_stop(app.clone());
                                save_sync_enabled(app, false);
                                update_tray_icon(app, false);
                            }
                            "tray-sync-now" => { let _ = vault_sync::vault_sync_now(app.clone()); }
                            "tray-sync-log" => { open_sync_log_window(app); }
                            "tray-edit-agents" => agents_sync::edit_agents_md(app),
                            "tray-open-books" => {
                                let _ = std::process::Command::new("open")
                                    .arg("-b")
                                    .arg("com.laobu.exlibris")
                                    .status();
                            }
                            "tray-open-raw-sync" => {
                                // Disabled in v1; placeholder for upcoming rawvault sync feature
                            }
                            "tray-quit" => app.exit(0),
                            _ => {}
                        }
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } = event
                        {
                            show_main_window(tray.app_handle());
                        }
                    })
                    .build(app)?;
            }

            // Initial CLI argv (Linux / Windows / macOS-when-launched-from-shell).
            // macOS Finder double-click does NOT arrive via argv — uses Apple Events
            // captured via `RunEvent::Opened` (handled in app.run() below) AND via
            // `tauri-plugin-deep-link`'s `on_open_url` (frontend-side belt-and-braces).
            let handle = app.handle();
            for arg in std::env::args().skip(1) {
                emit_open_file_delayed(handle, &arg);
            }

            Ok(())
        })
        .build(tauri_context())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        match event {
            RunEvent::Ready => {
                dlog("RunEvent::Ready");
            }
            RunEvent::Opened { urls } => {
                dlog(&format!("RunEvent::Opened {} urls: {:?}",
                    urls.len(),
                    urls.iter().map(|u| u.to_string()).collect::<Vec<_>>()));
                for url in urls {
                    if let Ok(path) = url.to_file_path() {
                        if let Some(p) = path.to_str() {
                            dlog(&format!("  emit open-file: {}", p));
                            emit_open_file_delayed(app_handle, p);
                        }
                    }
                }
            }
            #[cfg(not(target_os = "ios"))]
            RunEvent::Reopen { has_visible_windows, .. } => {
                dlog(&format!("RunEvent::Reopen has_visible_windows={}", has_visible_windows));
                // Always reveal the main window on dock reactivation. The
                // `has_visible_windows` guard mis-fired when the window was
                // hidden (close → hide), leaving no way to reopen. Showing an
                // already-visible window is a no-op.
                show_main_window(app_handle);
            }
            RunEvent::WindowEvent { ref label, event: ref e, .. } => {
                match e {
                    WindowEvent::CloseRequested { api, .. } => {
                        dlog(&format!("WindowEvent CloseRequested on {}", label));
                        api.prevent_close();
                        if let Some(w) = app_handle.get_webview_window(label) {
                            let _ = w.hide();
                        }
                    }
                    WindowEvent::Destroyed => {
                        dlog(&format!("WindowEvent Destroyed on {}", label));
                    }
                    _ => {}
                }
            }
            RunEvent::ExitRequested { api, .. } => {
                api.prevent_exit();
            }
            RunEvent::Exit => dlog("RunEvent::Exit"),
            _ => {}
        }
    });
}

#[cfg(not(target_os = "ios"))]
fn bootstrap_themes(app: &tauri::AppHandle) -> Result<(), String> {
    use themes::paths::{themes_dir, ensure_dirs};
    use themes::commands::BUILT_IN_THEME_IDS;

    ensure_dirs(app)?;
    let res_dir = app.path().resource_dir().map_err(|e| e.to_string())?.join("resources").join("themes");
    let themes = themes_dir(app)?;
    themes::migration::copy_built_ins_if_missing(&res_dir, &themes, BUILT_IN_THEME_IDS)?;
    let _ = themes::commands::theme_recompile_all(app.clone());
    Ok(())
}

fn emit_open_file_delayed<R: tauri::Runtime>(app: &tauri::AppHandle<R>, path: &str) {
    if let Some(state) = app.try_state::<PendingFiles>() {
        state.0.lock().unwrap().push(path.to_string());
    }
    let app = app.clone();
    let path = path.to_string();
    // Use a plain OS thread + sleep rather than tauri::async_runtime::spawn +
    // tokio::time::sleep. The async task's body never executed when invoked
    // from the single-instance / RunEvent::Opened callbacks (the "emit
    // open-file →" dlog never fired), so files opened while the app was already
    // running — `notemd <file>` re-launch, Finder double-click — never reached
    // the frontend. A raw thread has no dependency on Tauri's async runtime.
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(300));
        dlog(&format!("emit open-file → {}", path));
        #[cfg(not(target_os = "ios"))]
        show_main_window(&app);
        let _ = app.emit("open-file", path);
    });
}

#[cfg(not(target_os = "ios"))]
#[cfg(not(target_os = "ios"))]
#[derive(serde::Deserialize)]
struct RecentMenuItem {
    index: usize,
    label: String,
}

/// Rebuild the File ▸ Open Recent submenu from the frontend's merged list.
/// Item ids are `open-recent:<index>`; clicks flow through the normal menu-event.
#[cfg(not(target_os = "ios"))]
#[tauri::command]
fn update_recent_menu(app: tauri::AppHandle, items: Vec<RecentMenuItem>) -> Result<(), String> {
    let state = app.state::<RecentMenu>();
    let guard = state.0.lock().unwrap();
    let submenu = guard.as_ref().ok_or("recent menu not initialized")?;

    // Clear existing items.
    loop {
        match submenu.remove_at(0) {
            Ok(Some(_)) => continue,
            _ => break,
        }
    }

    if items.is_empty() {
        let placeholder = MenuItemBuilder::with_id("recent-none", "No Recent Files")
            .enabled(false)
            .build(&app)
            .map_err(|e| e.to_string())?;
        submenu.append(&placeholder).map_err(|e| e.to_string())?;
    } else {
        for it in items {
            let mi = MenuItemBuilder::with_id(format!("open-recent:{}", it.index), it.label)
                .build(&app)
                .map_err(|e| e.to_string())?;
            submenu.append(&mi).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Native menu label catalog. Mirrors the JS i18n catalog for the handful of
/// custom menu strings (macOS-provided items like Undo/Copy/Quit localize
/// themselves). Unknown locales fall back to English.
fn menu_label(locale: &str, key: &str) -> String {
    let (en, zh, ja): (&str, &str, &str) = match key {
        "app.about" => ("About note.md", "关于 note.md", "note.md について"),
        "app.checkUpdates" => ("Check for Updates…", "检查更新…", "更新を確認…"),
        "app.preferences" => ("Preferences…", "偏好设置…", "環境設定…"),
        "app.hide" => ("Hide note.md", "隐藏 note.md", "note.md を隠す"),
        "menu.file" => ("File", "文件", "ファイル"),
        "menu.edit" => ("Edit", "编辑", "編集"),
        "menu.view" => ("View", "视图", "表示"),
        "menu.window" => ("Window", "窗口", "ウインドウ"),
        "menu.help" => ("Help", "帮助", "ヘルプ"),
        "menu.plugins" => ("Plugins", "插件", "プラグイン"),
        "file.openRecent" => ("Open Recent", "打开最近", "最近使ったファイルを開く"),
        "file.noRecent" => ("No Recent Files", "无最近文件", "最近のファイルなし"),
        "file.new" => ("New", "新建", "新規"),
        "file.open" => ("Open…", "打开…", "開く…"),
        "file.closeTab" => ("Close Tab", "关闭标签页", "タブを閉じる"),
        "file.save" => ("Save", "保存", "保存"),
        "file.saveAs" => ("Save As…", "另存为…", "名前を付けて保存…"),
        "file.print" => ("Print…", "打印…", "プリント…"),
        "edit.find" => ("Find…", "查找…", "検索…"),
        "edit.findReplace" => ("Find and Replace…", "查找和替换…", "検索と置換…"),
        "view.toggleMode" => ("Toggle Source / Rich", "切换源码 / 富文本", "ソース / リッチを切り替え"),
        "view.insights" => ("Reading Insights…", "阅读洞察数据…", "リーディングインサイト…"),
        "window.zoomIn" => ("Zoom In", "放大", "拡大"),
        "window.zoomOut" => ("Zoom Out", "缩小", "縮小"),
        "window.actualSize" => ("Actual Size", "实际大小", "実際のサイズ"),
        "help.docs" => ("Documentation", "文档", "ドキュメント"),
        "help.cliInstall" => (
            "Install 'notemd' Command in PATH…",
            "将 'notemd' 命令安装到 PATH…",
            "'notemd' コマンドを PATH にインストール…",
        ),
        "help.cliUninstall" => (
            "Uninstall 'notemd' Command",
            "卸载 'notemd' 命令",
            "'notemd' コマンドをアンインストール",
        ),
        // System / framework items (text overrides for PredefinedMenuItem, so
        // they follow the in-app locale instead of the macOS system language).
        "sys.services" => ("Services", "服务", "サービス"),
        "sys.hideOthers" => ("Hide Others", "隐藏其他", "ほかを隠す"),
        "sys.showAll" => ("Show All", "全部显示", "すべてを表示"),
        "sys.quit" => ("Quit note.md", "退出 note.md", "note.md を終了"),
        "sys.undo" => ("Undo", "撤销", "取り消す"),
        "sys.redo" => ("Redo", "重做", "やり直す"),
        "sys.cut" => ("Cut", "剪切", "カット"),
        "sys.copy" => ("Copy", "拷贝", "コピー"),
        "sys.paste" => ("Paste", "粘贴", "ペースト"),
        "sys.selectAll" => ("Select All", "全选", "すべてを選択"),
        "sys.minimize" => ("Minimize", "最小化", "しまう"),
        "sys.maximize" => ("Zoom", "缩放", "拡大／縮小"),
        // Menu-bar tray dropdown
        "tray.show" => ("Show note.md", "显示 note.md", "note.md を表示"),
        "tray.todayNote" => ("Today's Note", "今天的日记", "今日のノート"),
        "tray.vaultSetFolder" => ("Vault: Set Folder…", "Vault：选择文件夹…", "Vault：フォルダを選択…"),
        "tray.startSync" => ("Start Sync", "开始同步", "同期を開始"),
        "tray.stopSync" => ("Stop Sync", "停止同步", "同期を停止"),
        "tray.syncNow" => ("Sync Now", "立即同步", "今すぐ同期"),
        "tray.viewLog" => ("View Log…", "查看日志…", "ログを表示…"),
        "tray.openBooks" => ("Open Books", "打开 Books", "Books を開く"),
        "tray.openRawSync" => ("Open Raw Vault Sync", "打开原始 Vault 同步", "Raw Vault Sync を開く"),
        "tray.editAgents" => ("Edit AGENTS.md…", "编辑 AGENTS.md…", "AGENTS.md を編集…"),
        _ => (key, key, key),
    };
    match locale {
        "zh" => zh,
        "ja" => ja,
        _ => en,
    }
    .to_string()
}

/// Best-effort read of the persisted UI locale from the store file so the
/// native menu can be built in the right language at startup. Falls back to
/// English if the file is missing/unreadable or the value is unknown.
fn read_saved_locale<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> String {
    use tauri::Manager;
    let path = match app.path().app_config_dir() {
        Ok(dir) => dir.join("settings.json"),
        Err(_) => return "en".to_string(),
    };
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => return "en".to_string(),
    };
    let json: serde_json::Value = match serde_json::from_str(&text) {
        Ok(j) => j,
        Err(_) => return "en".to_string(),
    };
    match json.get("locale").and_then(|v| v.as_str()) {
        Some(l @ ("en" | "zh" | "ja")) => l.to_string(),
        _ => "en".to_string(),
    }
}

/// Build the menu-bar tray dropdown in the given locale. Returns the menu and
/// the (dynamic) "Vault:" item so the caller can stash it for later label
/// updates. Event handling stays on the TrayIcon, so rebuilding just the menu
/// preserves click behavior.
fn build_tray_menu<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    locale: &str,
) -> tauri::Result<(Menu<R>, MenuItem<R>)> {
    let show_item = MenuItem::with_id(app, "tray-show", menu_label(locale, "tray.show"), true, None::<&str>)?;
    let today_note_item = MenuItem::with_id(app, "tray-today-note", menu_label(locale, "tray.todayNote"), true, None::<&str>)?;
    let openclaw_item = if plugin_host::is_plugin_enabled("openclaw-chat") {
        Some(MenuItem::with_id(app, "tray-openclaw", "OpenClaw", true, None::<&str>)?)
    } else {
        None
    };
    let sync_repo_label = {
        let mgr = app.state::<std::sync::Arc<vault_sync::VaultSyncManager>>();
        let guard = mgr.repo_path.lock().unwrap();
        match guard.as_deref() {
            Some(p) => format!("Vault: {}", abbreviate_path(p)),
            None => menu_label(locale, "tray.vaultSetFolder"),
        }
    };
    let sync_repo_item = MenuItem::with_id(app, "tray-sync-repo", &sync_repo_label, true, None::<&str>)?;
    let sync_start_item = MenuItem::with_id(app, "tray-sync-start", menu_label(locale, "tray.startSync"), true, None::<&str>)?;
    let sync_stop_item = MenuItem::with_id(app, "tray-sync-stop", menu_label(locale, "tray.stopSync"), true, None::<&str>)?;
    let sync_now_item = MenuItem::with_id(app, "tray-sync-now", menu_label(locale, "tray.syncNow"), true, None::<&str>)?;
    let sync_log_item = MenuItem::with_id(app, "tray-sync-log", menu_label(locale, "tray.viewLog"), true, None::<&str>)?;
    let edit_agents_item = MenuItem::with_id(app, "tray-edit-agents", menu_label(locale, "tray.editAgents"), true, None::<&str>)?;
    let open_books_item = MenuItem::with_id(app, "tray-open-books", menu_label(locale, "tray.openBooks"), true, None::<&str>)?;
    let open_raw_sync_item = MenuItem::with_id(app, "tray-open-raw-sync", menu_label(locale, "tray.openRawSync"), /*enabled=*/ false, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "tray-quit", menu_label(locale, "sys.quit"), true, None::<&str>)?;
    let mut b = MenuBuilder::new(app).item(&show_item).item(&today_note_item).separator();
    if let Some(ref oc) = openclaw_item {
        b = b.item(oc).separator();
    }
    let menu = b
        .item(&sync_repo_item)
        .item(&sync_start_item)
        .item(&sync_stop_item)
        .item(&sync_now_item)
        .item(&sync_log_item)
        .item(&edit_agents_item)
        .separator()
        .item(&open_books_item)
        .item(&open_raw_sync_item)
        .separator()
        .item(&quit_item)
        .build()?;
    Ok((menu, sync_repo_item))
}

/// Rebuild the app menu (and tray) in the given locale and apply them. Called
/// from JS when the user changes the language. The recent-files submenu resets
/// to its placeholder; JS re-pushes the list via `refreshRecentMenu()` after.
#[tauri::command]
fn set_menu_locale(app: tauri::AppHandle, locale: String) -> Result<(), String> {
    let plugin_items = plugin_host::collect_top_menu_items(&locale);
    let (menu, recent_submenu) =
        build_menu(&app, &plugin_items, &locale).map_err(|e| e.to_string())?;
    *app.state::<RecentMenu>().0.lock().unwrap() = Some(recent_submenu);
    app.set_menu(menu).map_err(|e| e.to_string())?;

    // Rebuild the tray dropdown too (event handling lives on the TrayIcon).
    if let Some(tray) = app.tray_by_id("main") {
        let (tray_menu, sync_repo_item) =
            build_tray_menu(&app, &locale).map_err(|e| e.to_string())?;
        *app.state::<TrayRepoItem>().0.lock().unwrap() = Some(sync_repo_item);
        tray.set_menu(Some(tray_menu)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn build_menu<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    plugin_items: &[plugin_host::LocatedMenuItem],
    locale: &str,
) -> tauri::Result<(Menu<R>, Submenu<R>)> {
    let app_meta = AboutMetadata {
        name: Some("note.md".into()),
        version: Some(env!("CARGO_PKG_VERSION").into()),
        ..Default::default()
    };

    let app_menu: Submenu<R> = SubmenuBuilder::new(app, "note.md")
        .item(&PredefinedMenuItem::about(app, Some(&menu_label(locale, "app.about")), Some(app_meta))?)
        .item(
            &MenuItemBuilder::with_id("check-for-updates", menu_label(locale, "app.checkUpdates"))
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("preferences", menu_label(locale, "app.preferences"))
                .accelerator("Cmd+,")
                .build(app)?,
        )
        .separator()
        .item(&PredefinedMenuItem::services(app, Some(&menu_label(locale, "sys.services")))?)
        .separator()
        .item(&MenuItemBuilder::with_id("hide-app", menu_label(locale, "app.hide")).accelerator("Cmd+Shift+H").build(app)?)
        .item(&PredefinedMenuItem::hide_others(app, Some(&menu_label(locale, "sys.hideOthers")))?)
        .item(&PredefinedMenuItem::show_all(app, Some(&menu_label(locale, "sys.showAll")))?)
        .separator()
        .item(&PredefinedMenuItem::quit(app, Some(&menu_label(locale, "sys.quit")))?)
        .build()?;

    let recent_menu: Submenu<R> = SubmenuBuilder::new(app, menu_label(locale, "file.openRecent"))
        .item(
            &MenuItemBuilder::with_id("recent-none", menu_label(locale, "file.noRecent"))
                .enabled(false)
                .build(app)?,
        )
        .build()?;

    let mut file_b = SubmenuBuilder::new(app, menu_label(locale, "menu.file"))
        .item(&MenuItemBuilder::with_id("new", menu_label(locale, "file.new")).accelerator("Cmd+N").build(app)?)
        .item(&MenuItemBuilder::with_id("open", menu_label(locale, "file.open")).accelerator("Cmd+O").build(app)?)
        .item(&recent_menu)
        .separator()
        .item(
            &MenuItemBuilder::with_id("close-tab", menu_label(locale, "file.closeTab"))
                .accelerator("Cmd+W")
                .build(app)?,
        )
        .separator()
        .item(&MenuItemBuilder::with_id("save", menu_label(locale, "file.save")).accelerator("Cmd+S").build(app)?)
        .item(
            &MenuItemBuilder::with_id("save-as", menu_label(locale, "file.saveAs"))
                .accelerator("Cmd+Shift+S")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("print", menu_label(locale, "file.print"))
                .accelerator("Cmd+P")
                .build(app)?,
        );
    for it in plugin_items.iter().filter(|p| p.location == "file") {
        let mut b = MenuItemBuilder::with_id(&it.id, &it.label);
        if let Some(s) = &it.shortcut { b = b.accelerator(s); }
        file_b = file_b.item(&b.build(app)?);
    }
    let file_menu: Submenu<R> = file_b.build()?;

    let mut edit_b = SubmenuBuilder::new(app, menu_label(locale, "menu.edit"))
        .item(&PredefinedMenuItem::undo(app, Some(&menu_label(locale, "sys.undo")))?)
        .item(&PredefinedMenuItem::redo(app, Some(&menu_label(locale, "sys.redo")))?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, Some(&menu_label(locale, "sys.cut")))?)
        .item(&PredefinedMenuItem::copy(app, Some(&menu_label(locale, "sys.copy")))?)
        .item(&PredefinedMenuItem::paste(app, Some(&menu_label(locale, "sys.paste")))?)
        .item(&PredefinedMenuItem::select_all(app, Some(&menu_label(locale, "sys.selectAll")))?)
        .separator()
        .item(&MenuItemBuilder::with_id("find", menu_label(locale, "edit.find")).accelerator("Cmd+F").build(app)?)
        .item(&MenuItemBuilder::with_id("find-replace", menu_label(locale, "edit.findReplace")).build(app)?);
    for it in plugin_items.iter().filter(|p| p.location == "edit") {
        let mut b = MenuItemBuilder::with_id(&it.id, &it.label);
        if let Some(s) = &it.shortcut { b = b.accelerator(s); }
        edit_b = edit_b.item(&b.build(app)?);
    }
    let edit_menu: Submenu<R> = edit_b.build()?;

    let mut view_b = SubmenuBuilder::new(app, menu_label(locale, "menu.view"))
        .item(
            &MenuItemBuilder::with_id("toggle-mode", menu_label(locale, "view.toggleMode"))
                .accelerator("Cmd+/")
                .build(app)?,
        )
        .item(&PredefinedMenuItem::fullscreen(app, None)?)
        .separator()
        .item(&MenuItemBuilder::with_id("open-insights", menu_label(locale, "view.insights")).build(app)?);
    for it in plugin_items.iter().filter(|p| p.location == "view") {
        let mut b = MenuItemBuilder::with_id(&it.id, &it.label);
        if let Some(s) = &it.shortcut { b = b.accelerator(s); }
        view_b = view_b.item(&b.build(app)?);
    }
    let view_menu: Submenu<R> = view_b.build()?;

    let mut window_b = SubmenuBuilder::new(app, menu_label(locale, "menu.window"))
        .item(&PredefinedMenuItem::minimize(app, Some(&menu_label(locale, "sys.minimize")))?)
        .item(&PredefinedMenuItem::maximize(app, Some(&menu_label(locale, "sys.maximize")))?)
        .separator()
        .item(&MenuItemBuilder::with_id("zoom-in", menu_label(locale, "window.zoomIn")).accelerator("Cmd+=").build(app)?)
        .item(&MenuItemBuilder::with_id("zoom-out", menu_label(locale, "window.zoomOut")).accelerator("Cmd+-").build(app)?)
        .item(&MenuItemBuilder::with_id("zoom-reset", menu_label(locale, "window.actualSize")).accelerator("Cmd+0").build(app)?);
    for it in plugin_items.iter().filter(|p| p.location == "window") {
        let mut b = MenuItemBuilder::with_id(&it.id, &it.label);
        if let Some(s) = &it.shortcut { b = b.accelerator(s); }
        window_b = window_b.item(&b.build(app)?);
    }
    let window_menu: Submenu<R> = window_b.build()?;

    let mut help_b = SubmenuBuilder::new(app, menu_label(locale, "menu.help"))
        .item(&MenuItemBuilder::with_id("docs", menu_label(locale, "help.docs")).build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("cli-install", menu_label(locale, "help.cliInstall")).build(app)?)
        .item(&MenuItemBuilder::with_id("cli-uninstall", menu_label(locale, "help.cliUninstall")).build(app)?);
    for it in plugin_items.iter().filter(|p| p.location == "help") {
        let mut b = MenuItemBuilder::with_id(&it.id, &it.label);
        if let Some(s) = &it.shortcut { b = b.accelerator(s); }
        help_b = help_b.item(&b.build(app)?);
    }
    let help_menu: Submenu<R> = help_b.build()?;

    let plugins_in_plugins: Vec<_> = plugin_items.iter().filter(|p| p.location == "plugins").collect();
    let plugins_menu: Option<Submenu<R>> = if !plugins_in_plugins.is_empty() {
        let mut b = SubmenuBuilder::new(app, menu_label(locale, "menu.plugins"));
        for it in plugins_in_plugins {
            let mut mb = MenuItemBuilder::with_id(&it.id, &it.label);
            if let Some(s) = &it.shortcut { mb = mb.accelerator(s); }
            b = b.item(&mb.build(app)?);
        }
        Some(b.build()?)
    } else {
        None
    };

    // Suppress unused warning when WindowEvent isn't matched in run loop above
    let _ = std::any::type_name::<WindowEvent>();

    let mut top = MenuBuilder::new(app);
    top = top.items(&[&app_menu, &file_menu, &edit_menu, &view_menu]);
    if let Some(pm) = &plugins_menu { top = top.item(pm); }
    let menu = top.items(&[&window_menu, &help_menu]).build()?;
    Ok((menu, recent_menu))
}
